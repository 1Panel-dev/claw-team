/**
 * 这个文件负责回调发送失败后的重试和死信落盘。
 * 这样 callback client 本身可以保持简单，重试策略集中在这里维护。
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Logger } from "../observability/logger.js";
import type { ClawSwarmCallbackClient, ClawSwarmEvent } from "./client.js";

// 退避策略都放在这里，便于后续替换成更复杂的队列系统。
export type RetryPolicy = {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
    deadLetterFile: string;
};

export async function sendEventWithRetry(params: {
    client: ClawSwarmCallbackClient;
    event: ClawSwarmEvent;
    policy: RetryPolicy;
    logger: Logger;
}): Promise<void> {
    const { client, event, policy, logger } = params;

    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            await client.sendEvent(event);
            return;
        } catch (err) {
            // attempt > maxAttempts 时认为已经走完所有重试机会。
            if (attempt > policy.maxAttempts) {
                logger.error(
                    { attempt, eventType: event.eventType, eventId: event.eventId, err: String(err) },
                    "callback failed permanently; writing DLQ",
                );
                await writeDeadLetter(policy.deadLetterFile, { event, err: String(err), attempt });
                return;
            }

            const delay = computeBackoffMs(policy, attempt);
            // 这里的 warn 很关键，线上排查“回调怎么变慢了”通常就靠它。
            logger.warn(
                { attempt, delayMs: delay, eventType: event.eventType, eventId: event.eventId, err: String(err) },
                "callback failed; retrying",
            );
            await sleep(delay);
        }
    }
}

// 指数退避 + 抖动，避免多个失败请求同时重试造成尖峰。
function computeBackoffMs(p: RetryPolicy, attempt: number): number {
    const pow = Math.pow(2, Math.max(0, attempt - 1));
    let delay = Math.min(p.maxDelayMs, p.baseDelayMs * pow);
    const jitter = 1 + (Math.random() * 2 - 1) * p.jitterRatio;
    delay = Math.max(0, Math.floor(delay * jitter));
    return delay;
}

async function sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

// 超过最大重试次数后，事件会被写入 dead-letter 文件，方便人工补偿。
async function writeDeadLetter(file: string, record: unknown): Promise<void> {
    const line = JSON.stringify({ id: crypto.randomUUID(), ts: Date.now(), record }) + "\n";
    await fs.appendFile(file, line, { encoding: "utf8" });
}
