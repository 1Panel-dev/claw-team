/**
 * 这个文件负责把 Agent 执行事件回推给 Claw Team。
 * 它只关心“怎么发出去”，不关心“什么时候发、失败后怎么重试”。
 *
 * 调用流程：
 * 1. dispatchDirect 生成 run.accepted / reply.chunk / reply.final / run.error 事件。
 * 2. 这些事件会先经过 callback/retry.ts。
 * 3. retry 层每次真正发送时，最终都会落到这里的 sendEvent。
 * 4. 这里负责 HTTP 请求、鉴权头和签名头的最终组装。
 */
import crypto from "node:crypto";
import { request } from "undici";
import type { Logger } from "../observability/logger.js";

// 插件当前向 Claw Team 回推的事件类型。
export type ClawTeamEventType = "run.accepted" | "reply.chunk" | "reply.final" | "run.error";

export type ClawTeamEvent = {
    eventId: string;
    eventType: ClawTeamEventType;
    correlation: {
        messageId: string;
        chatId: string;
        agentId: string;
        sessionKey: string;
    };
    payload: Record<string, unknown>;
    timestamp: number;
};

// 用接口包一层，方便未来替换成队列、SSE 或其它回调实现。
export interface ClawTeamCallbackClient {
    sendEvent(event: ClawTeamEvent): Promise<void>;
}

export class HttpClawTeamCallbackClient implements ClawTeamCallbackClient {
    constructor(
        private opts: {
            baseUrl: string;
            token: string;
            timeoutMs: number;
            logger: Logger;
        },
    ) {}

    async sendEvent(event: ClawTeamEvent): Promise<void> {
        const url = new URL("/api/v1/claw-team/events", this.opts.baseUrl).toString();
        const body = JSON.stringify(event);
        // timestamp + body 做 HMAC，便于对端做防篡改校验。
        const timestamp = Date.now().toString();
        const signature = crypto.createHmac("sha256", this.opts.token).update(`${timestamp}.${body}`).digest("hex");

        const res = await request(url, {
            method: "POST",
            headers: {
                "content-type": "application/json; charset=utf-8",
                authorization: `Bearer ${this.opts.token}`,
                "x-claw-team-timestamp": timestamp,
                "x-claw-team-signature": `sha256=${signature}`,
            },
            body,
            headersTimeout: this.opts.timeoutMs,
            bodyTimeout: this.opts.timeoutMs,
        });

        // 非 2xx 一律视为失败，交给上层 retry 处理。
        if (res.statusCode < 200 || res.statusCode >= 300) {
            const txt = await res.body.text().catch(() => "");
            this.opts.logger.warn(
                { statusCode: res.statusCode, body: truncate(txt, 300) },
                "Claw Team callback non-2xx",
            );
            throw new Error(`claw_team_callback_http_${res.statusCode}`);
        }
    }
}

// 避免日志里塞入超长响应体。
function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n) + "...";
}
