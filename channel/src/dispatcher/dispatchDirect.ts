import type { Logger } from "../observability/logger.js";
import { resolveGatewayRuntimeConfig, type AccountConfig } from "../config.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { MessageStateStore } from "../store/messageState.js";
import { dedupeKeyForMessageAgent } from "../store/idempotency.js";
import { buildSessionKey } from "../router/sessionKey.js";
import type { InboundMessage } from "../router/resolveRoute.js";
import type { OpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import type { ClawTeamCallbackClient } from "../callback/client.js";
import { buildCallbackMessageParts } from "../callback/parts.js";
import { markLocalOriginSession } from "../openclaw/mirrorOriginRegistry.js";
import { emitDirectEvent } from "./directEvent.js";
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

    const sessionKey = buildSessionKey({
        agentId,
        chatType: inbound.chat.type,
        chatId: inbound.chat.chatId,
        routeKind,
        threadId: inbound.chat.threadId,
        useDedicatedDirectSession: inbound.useDedicatedDirectSession,
    });
    const first = await idempotency.setIfNotExists(
        dedupeKeyForMessageAgent({ accountId, messageId: inbound.messageId, agentId }),
        accountConfig.idempotency.ttlSeconds,
    );

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

    if (channelId === "claw-team" && routeKind === "DIRECT") {
        markLocalOriginSession(sessionKey);
    }

    await emitDirectEvent({
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
            const isAggregatedFinalDuplicate =
                !!chunk.isFinal && !!chunk.text && buf.length > 0 && chunk.text === buf;

            if (chunk.text && !isAggregatedFinalDuplicate) {
                buf += chunk.text;
                await emitDirectEvent({
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

        await emitDirectEvent({
            clawTeam,
            baseLog,
            accountConfig,
            eventType: "reply.final",
            inbound,
            agentId,
            sessionKey,
            payload: {
                text: buf,
                routeKind,
                parts: buildCallbackMessageParts(buf),
            },
        });

        if (messageState.get(inbound.messageId)) {
            messageState.update(inbound.messageId, {
                status: "CALLBACK_SENT",
                routingMode: routeKind,
                targetAgentIds: [agentId],
                sessionKeys: [sessionKey],
            });
        }
    } catch (err) {
        baseLog.error({ err: String(err) }, "agent run failed");
        await emitDirectEvent({
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
