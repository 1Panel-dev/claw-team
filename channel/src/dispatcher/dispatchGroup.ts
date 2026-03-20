/**
 * 这个文件负责群聊场景下的多 Agent 调度。
 * 它本身不直接执行业务逻辑，而是把每个 Agent 的任务安全地排队后交给 dispatchDirect。
 */
import type { Logger } from "../observability/logger.js";
import type { AccountConfig } from "../config.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { MessageStateStore } from "../store/messageState.js";
import type { ClawTeamCallbackClient } from "../callback/client.js";
import type { OpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import type { InboundMessage } from "../router/resolveRoute.js";
import { dispatchDirect } from "./dispatchDirect.js";
import { buildSessionKey } from "../router/sessionKey.js";

// 一个最小可用的信号量实现，用于限制全局或单 Agent 并发。
class Semaphore {
    private available: number;
    private waiters: Array<() => void> = [];

    constructor(n: number) {
        this.available = n;
    }

    async acquire(): Promise<() => void> {
        // 还有配额时立即拿到；没有配额时进入等待队列。
        if (this.available > 0) {
            this.available -= 1;
            return () => this.release();
        }

        await new Promise<void>((resolve) => this.waiters.push(resolve));
        this.available -= 1;
        return () => this.release();
    }

    private release() {
        this.available += 1;
        const w = this.waiters.shift();
        if (w) w();
    }
}

// keyedTail 用来保证“同一个 Agent + 同一个会话”的任务顺序执行。
const keyedTail = new Map<string, Promise<void>>();

function enqueueKeyed(key: string, task: () => Promise<void>): Promise<void> {
    // 新任务会串到上一个同 key 任务后面，避免同一上下文并发写乱序。
    const prev = keyedTail.get(key) ?? Promise.resolve();
    const next = prev
        .catch(() => undefined)
        .then(task)
        .finally(() => {
            if (keyedTail.get(key) === next) keyedTail.delete(key);
        });

    keyedTail.set(key, next);
    return next;
}

// dispatchGroup 只负责编排，不负责具体 Agent 执行细节。
export async function dispatchGroup(params: {
    channelId: string;
    accountId: string;
    accountConfig: AccountConfig;
    logger: Logger;

    idempotency: IdempotencyStore;
    messageState: MessageStateStore;
    clawTeam: ClawTeamCallbackClient;
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
        clawTeam,
        openclaw,
        inbound,
        agentIds,
        routeKind,
        traceId,
    } = params;

    // globalSem 控制整个账号维度的总并发。
    const globalSem = new Semaphore(accountConfig.limits.maxInFlightRuns);
    // perAgentSem 控制单个 Agent 的并发，避免某个 Agent 被群聊打爆。
    const perAgentSem = new Map<string, Semaphore>();

    const getAgentSem = (agentId: string) => {
        const cur = perAgentSem.get(agentId);
        if (cur) return cur;

        const s = new Semaphore(accountConfig.limits.perAgentConcurrency);
        perAgentSem.set(agentId, s);
        return s;
    };

    const tasks = agentIds.map(async (agentId) => {
        const sessionKey = buildSessionKey({
            agentId,
            chatType: inbound.chat.type,
            chatId: inbound.chat.chatId,
            routeKind,
            threadId: inbound.chat.threadId,
        });
        const queueKey = `${accountId}|${agentId}|${sessionKey}`;

        return enqueueKeyed(queueKey, async () => {
            // 先占全局配额，再占单 Agent 配额；释放顺序反过来也没问题。
            const releaseGlobal = await globalSem.acquire();
            const releaseAgent = await getAgentSem(agentId).acquire();

            try {
                await dispatchDirect({
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
                });
            } finally {
                releaseAgent();
                releaseGlobal();
            }
        });
    });

    await Promise.all(tasks);
}
