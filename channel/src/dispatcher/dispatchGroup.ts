/**
 * 这个文件负责群聊场景下的多 Agent 调度。
 * 它本身不直接执行业务逻辑，而是把每个 Agent 的任务安全地排队后交给 dispatchDirect。
 */
import type { Logger } from "../observability/logger.js";
import type { AccountConfig } from "../config.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { MessageStateStore } from "../store/messageState.js";
import type { ClawSwarmCallbackClient } from "../callback/client.js";
import type { OpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import type { InboundMessage } from "../router/resolveRoute.js";
import { buildSessionKey } from "../router/sessionKey.js";
import { dispatchDirect } from "./dispatchDirect.js";
import { createGroupDispatchQueue } from "./groupQueue.js";

// dispatchGroup 只负责编排，不负责具体 Agent 执行细节。
export async function dispatchGroup(params: {
    channelId: string;
    accountId: string;
    accountConfig: AccountConfig;
    logger: Logger;

    idempotency: IdempotencyStore;
    messageState: MessageStateStore;
    clawSwarm: ClawSwarmCallbackClient;
    openclaw: OpenClawRuntimeAdapter;

    inbound: InboundMessage;
    agentIds: string[];
    routeKind: "GROUP_MENTION" | "GROUP_BROADCAST";
    traceId: string;
}): Promise<void> {
    const {
        channelId,
        accountId,
        accountConfig,
        logger,
        idempotency,
        messageState,
        clawSwarm,
        openclaw,
        inbound,
        agentIds,
        routeKind,
        traceId,
    } = params;

    const queue = createGroupDispatchQueue(accountConfig);

    const tasks = agentIds.map(async (agentId) => {
        const sessionKey = buildSessionKey({
            agentId,
            chatType: inbound.chat.type,
            chatId: inbound.chat.chatId,
            routeKind,
            threadId: inbound.chat.threadId,
        });
        return queue.run({
            accountId,
            agentId,
            sessionKey,
            task: async () => {
                await dispatchDirect({
                    channelId,
                    accountId,
                    accountConfig,
                    logger,
                    idempotency,
                    messageState,
                    clawSwarm,
                    openclaw,
                    inbound,
                    agentId,
                    routeKind,
                    traceId,
                });
            },
        });
    });

    await Promise.all(tasks);
}
