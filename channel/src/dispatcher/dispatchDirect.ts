/**
 * 这个文件负责“把一条消息投递给单个 Agent”。
 * 无论是 direct 还是 group 内某个具体 Agent，最终都会走到这里。
 *
 * 调用流程：
 * 1. routes 或 dispatchGroup 把单个 Agent 任务传进来。
 * 2. 这里先生成 sessionKey，并做 messageId + agentId 级别的幂等校验。
 * 3. 然后调用 openclaw adapter 获取文本流，并把 chunk/final/error 事件回推给 Claw Team。
 * 4. 同时更新 message state，方便后续排障和状态观察。
 */
import crypto from "node:crypto";
import type { Logger } from "../observability/logger.js";
import { resolveGatewayRuntimeConfig, type AccountConfig } from "../config.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { MessageStateStore } from "../store/messageState.js";
import { dedupeKeyForMessageAgent } from "../store/idempotency.js";
import { buildSessionKey } from "../router/sessionKey.js";
import type { InboundMessage } from "../router/resolveRoute.js";
import type { OpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import type { ClawTeamCallbackClient, ClawTeamEvent } from "../callback/client.js";
import { sendEventWithRetry } from "../callback/retry.js";

// dispatchDirect 是最小执行单元：单个 Agent、单个 sessionKey、单条消息。
export async function dispatchDirect(params: {
    channelId: string;
    accountId: string;
    accountConfig: AccountConfig;
    logger: Logger;

    idempotency: IdempotencyStore;
    messageState: MessageStateStore;
    clawTeam: ClawTeamCallbackClient;
    openclaw: OpenClawRuntimeAdapter;

    inbound: InboundMessage;
    agentId: string;
    routeKind: "DIRECT" | "GROUP_MENTION" | "GROUP_BROADCAST";
    traceId: string;
}): Promise<void> {
    const {
        channelId,
        accountId,
        accountConfig,
        logger,
        idempotency,
        messageState,
        clawTeam,
        openclaw,
        inbound,
        agentId,
        routeKind,
        traceId,
    } = params;

    // sessionKey 决定这个 Agent 会看到哪段会话上下文。
    const sessionKey = buildSessionKey({
        agentId,
        chatType: inbound.chat.type,
        chatId: inbound.chat.chatId,
        routeKind,
        threadId: inbound.chat.threadId,
    });

    const first = await idempotency.setIfNotExists(
        dedupeKeyForMessageAgent({ accountId, messageId: inbound.messageId, agentId }),
        accountConfig.idempotency.ttlSeconds,
    );

    // 对同一 messageId + agentId，永远只执行一次。
    if (!first) {
        logger.info(
            {
                accountId,
                messageId: inbound.messageId,
                agentId,
                sessionKey,
                routeKind,
                deduped: true,
            },
            "deduped inbound message; skip run",
        );
        return;
    }

    if (messageState.get(inbound.messageId)) {
        // 这里只记录“这个消息已经开始向某个 Agent 执行”。
        messageState.update(inbound.messageId, {
            status: "DISPATCHED",
            routingMode: routeKind,
            targetAgentIds: [agentId],
            sessionKeys: [sessionKey],
        });
    }

    const baseLog = logger.child({
        traceId,
        accountId,
        messageId: inbound.messageId,
        agentId,
        sessionKey,
        routeKind,
    });

    // 先发 run.accepted 事件，让 Claw Team 知道这条消息已经进入执行阶段。
    await emitEvent({
        clawTeam,
        baseLog,
        accountConfig,
        eventType: "run.accepted",
        inbound,
        agentId,
        sessionKey,
        payload: {
            routeKind,
            chatType: inbound.chat.type,
            chatId: inbound.chat.chatId,
            threadId: inbound.chat.threadId ?? null,
        },
    });

    try {
        // buf 用于累积最终完整文本；chunk 事件用于实时回推增量内容。
        let buf = "";
        for await (const chunk of openclaw.runAgentTextTurn({
            agentId,
            channelId,
            accountId,
            sessionKey,
            peer: {
                kind: inbound.chat.type,
                id: inbound.chat.chatId,
                threadId: inbound.chat.threadId,
            },
            from: inbound.from,
            text: inbound.text,
            gateway: resolveGatewayRuntimeConfig(accountConfig),
        })) {
            if (chunk.text) {
                buf += chunk.text;
                // 每个 chunk 都实时回调给 Claw Team，便于做流式展示。
                await emitEvent({
                    clawTeam,
                    baseLog,
                    accountConfig,
                    eventType: "reply.chunk",
                    inbound,
                    agentId,
                    sessionKey,
                    payload: { text: chunk.text, isFinal: !!chunk.isFinal },
                });
            }
            if (chunk.isFinal) break;
        }

        await emitEvent({
            clawTeam,
            baseLog,
            accountConfig,
            eventType: "reply.final",
            inbound,
            agentId,
            sessionKey,
            payload: { text: buf, routeKind },
        });

        if (messageState.get(inbound.messageId)) {
            // 这里表示“该 Agent 的最终回调已经发出”。
            messageState.update(inbound.messageId, {
                status: "CALLBACK_SENT",
                routingMode: routeKind,
                targetAgentIds: [agentId],
                sessionKeys: [sessionKey],
            });
        }
    } catch (err) {
        // Agent 执行或回调链路出错时，同时发错误事件并写消息状态。
        baseLog.error({ err: String(err) }, "agent run failed");
        await emitEvent({
            clawTeam,
            baseLog,
            accountConfig,
            eventType: "run.error",
            inbound,
            agentId,
            sessionKey,
            payload: { error: String(err), routeKind },
        });

        if (messageState.get(inbound.messageId)) {
            messageState.update(inbound.messageId, {
                status: "FAILED",
                routingMode: routeKind,
                targetAgentIds: [agentId],
                sessionKeys: [sessionKey],
                error: String(err),
            });
        }
    }
}

// emitEvent 统一负责构造事件对象并走带重试的回调发送。
async function emitEvent(params: {
    clawTeam: ClawTeamCallbackClient;
    baseLog: Logger;
    accountConfig: AccountConfig;
    eventType: ClawTeamEvent["eventType"];
    inbound: InboundMessage;
    agentId: string;
    sessionKey: string;
    payload: Record<string, unknown>;
}): Promise<void> {
    const ev: ClawTeamEvent = {
        // eventId 是回调事件自身的唯一标识，不等同于 messageId。
        eventId: crypto.randomUUID(),
        eventType: params.eventType,
        correlation: {
            messageId: params.inbound.messageId,
            chatId: params.inbound.chat.chatId,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
        },
        payload: params.payload,
        timestamp: Date.now(),
    };

    await sendEventWithRetry({
        client: params.clawTeam,
        event: ev,
        policy: params.accountConfig.retry,
        logger: params.baseLog,
    });
}
