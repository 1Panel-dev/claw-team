/**
 * 这个文件负责插件的全部 HTTP 入站接口。
 * 这里既包含调试接口，也包含真正的 /inbound webhook 入口。
 *
 * 调用流程：
 * 1. Claw Team 后端调用 /claw-team/v1/inbound。
 * 2. 这里先读取 raw body，并做大小限制、签名校验、JSON 解析和 schema 校验。
 * 3. 然后调用 resolveRoute 生成路由决策，并提前写入 message state。
 * 4. HTTP 先快速 ACK，真正的 Agent 执行通过 dispatchDirect/dispatchGroup 异步完成。
 */
import crypto from "node:crypto";

import { InboundMessageSchema } from "../router/resolveRoute.js";
import { resolveRoute } from "../router/resolveRoute.js";
import { dispatchDirect } from "../dispatcher/dispatchDirect.js";
import { dispatchGroup } from "../dispatcher/dispatchGroup.js";
import { verifyInboundSignature } from "../security/signature.js";
import type { Logger } from "../observability/logger.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import { describeAgents, type AccountConfig } from "../config.js";
import type { MessageStateStore } from "../store/messageState.js";
import type { ClawTeamCallbackClient } from "../callback/client.js";
import type { OpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import type { GroupDescriptor } from "../types.js";

// 读取原始请求体时保留二进制内容，便于后续做签名校验。
async function readRawBody(req: any, maxBytes: number): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const c of req) {
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
        total += buf.length;
        // 超过限制就立刻中断，避免继续吃内存。
        if (total > maxBytes) throw new Error("body_too_large");
        chunks.push(buf);
    }

    return Buffer.concat(chunks);
}

// 统一 JSON 响应格式，避免每个分支重复写 header。
function sendJson(res: any, status: number, obj: unknown) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
}

export function createClawTeamRoutes(params: {
    channelId: string;
    getAccount: (accountId?: string) => AccountConfig & { accountId: string };
    logger: Logger;
    idempotency: IdempotencyStore;
    messageState: MessageStateStore;
    clawTeamFactory: (acct: AccountConfig) => ClawTeamCallbackClient;
    openclaw: OpenClawRuntimeAdapter;
}) {
    const { channelId, getAccount, logger, idempotency, messageState, clawTeamFactory, openclaw } = params;

    // 返回给 registerHttpRoute 的 handler。
    return async function handler(req: any, res: any): Promise<boolean> {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        // 健康检查接口，主要给运维和联调使用。
        if (pathname === "/claw-team/v1/health" && req.method === "GET") {
            sendJson(res, 200, { ok: true, pluginId: channelId, version: "0.1.0", channelId });
            return true;
        }

        // 返回当前账号允许使用的 Agent 列表，便于前后端联调。
        if (pathname === "/claw-team/v1/agents" && req.method === "GET") {
            const acct = getAccount(undefined);
            sendJson(res, 200, describeAgents(acct));
            return true;
        }

        // 目前群组还是轻量调试视图，默认把“允许路由的 Agent”展示成一个默认群。
        if (pathname === "/claw-team/v1/groups" && req.method === "GET") {
            const acct = getAccount(undefined);
            const groups: GroupDescriptor[] = [
                {
                    groupId: "default",
                    name: "Default Claw Team Group",
                    members: describeAgents(acct).map((agent) => agent.id),
                },
            ];
            sendJson(res, 200, groups);
            return true;
        }

        // 查询单个 groupId 的调试信息。
        if (pathname.startsWith("/claw-team/v1/groups/") && req.method === "GET") {
            const acct = getAccount(undefined);
            const groupId = pathname.split("/").filter(Boolean).at(-1);

            if (!groupId) {
                sendJson(res, 404, { error: "GROUP_NOT_FOUND", message: "group not found" });
                return true;
            }

            sendJson(res, 200, {
                groupId,
                name: groupId === "default" ? "Default Claw Team Group" : groupId,
                members: describeAgents(acct).map((agent) => agent.id),
            });
            return true;
        }

        // 这是最核心的 webhook：Claw Team 后端把用户消息投递到这里。
        if (pathname === "/claw-team/v1/inbound" && req.method === "POST") {
            // 签名校验要基于默认账号配置中的安全参数和 body 限制。
            const acct = getAccount(undefined);

            let raw: Uint8Array;
            try {
                raw = await readRawBody(req, acct.limits.maxBodyBytes);
            } catch {
                sendJson(res, 413, { error: "body_too_large" });
                return true;
            }

            // 先验签，再做 JSON 解析，避免无效请求浪费后续处理资源。
            const sig = await verifyInboundSignature({
                req,
                rawBody: raw,
                pathname,
                nowMs: Date.now(),
                accountConfig: acct,
                nonceStore: idempotency,
            });

            if (!sig.ok) {
                sendJson(res, sig.status, { error: sig.reason });
                return true;
            }

            let json: unknown;
            try {
                json = JSON.parse(Buffer.from(raw).toString("utf8"));
            } catch {
                sendJson(res, 400, { error: "invalid_json" });
                return true;
            }

            // 结构校验失败直接返回 400，避免非法数据进入 dispatcher。
            const parsed = InboundMessageSchema.safeParse(json);
            if (!parsed.success) {
                sendJson(res, 400, { error: "invalid_payload", detail: parsed.error.issues });
                return true;
            }

            const inbound = parsed.data;
            const accountId = inbound.accountId ?? sig.headers.accountId ?? "default";
            // traceId 用来贯穿一条消息的所有日志和状态变化。
            const traceId = crypto.randomUUID();

            const acct2 = getAccount(accountId);
            if (!acct2.enabled) {
                sendJson(res, 403, { error: "account_disabled" });
                return true;
            }

            const clawTeam = clawTeamFactory(acct2);

            // route decision 决定了这条消息最终打给谁。
            let decision;
            try {
                decision = resolveRoute(inbound, acct2);
            } catch (err) {
                sendJson(res, 400, { error: "route_error", detail: String(err) });
                return true;
            }

            // 在真正异步执行前，先把消息状态记录好，后面排障就有抓手。
            const now = new Date().toISOString();
            messageState.create({
                messageId: inbound.messageId,
                traceId,
                accountId,
                conversationId: decision.conversationId,
                groupId: decision.groupId,
                targetAgentIds: [],
                sessionKeys: [],
                status: "RECEIVED",
                createdAt: now,
                lastUpdated: now,
            });
            messageState.update(inbound.messageId, { status: "VALIDATED" });
            messageState.update(inbound.messageId, {
                status: "ROUTED",
                routingMode: decision.kind,
                targetAgentIds: decision.targetAgentIds,
                // 这里同步写入预期 sessionKey，方便尚未执行时就能从状态里看出路由结果。
                sessionKeys: decision.targetAgentIds.map((agentId) =>
                    inbound.chat.type === "direct"
                        ? `${channelId}:direct:${decision.conversationId}:agent:${agentId}`
                        : `${channelId}:group:${decision.groupId ?? inbound.chat.chatId}:${decision.kind === "GROUP_MENTION" ? "mention" : "broadcast"}:${agentId}:conv:${decision.conversationId}`,
                ),
            });

            // 先 ACK 给调用方，后续真正的 Agent 执行在后台完成。
            sendJson(res, 200, {
                accepted: true,
                traceId,
                routeKind: decision.kind,
                targetAgentIds: decision.targetAgentIds,
                targetAgentCount: decision.targetAgentIds.length,
            });

            const baseLog = logger.child({
                traceId,
                accountId,
                messageId: inbound.messageId,
                routeKind: decision.kind,
            });

            // 真正的 Agent 执行放到异步阶段，避免 webhook 长时间阻塞。
            setImmediate(async () => {
                try {
                    if (decision.kind === "DIRECT") {
                        await dispatchDirect({
                            channelId,
                            accountId,
                            accountConfig: acct2,
                            logger: baseLog,
                            idempotency,
                            messageState,
                            clawTeam,
                            openclaw,
                            inbound,
                            agentId: decision.targetAgentIds[0],
                            routeKind: decision.kind,
                            traceId,
                        });
                    } else {
                        await dispatchGroup({
                            channelId,
                            accountId,
                            accountConfig: acct2,
                            logger: baseLog,
                            idempotency,
                            messageState,
                            clawTeam,
                            openclaw,
                            inbound,
                            agentIds: decision.targetAgentIds,
                            routeKind: decision.kind,
                            traceId,
                        });
                    }
                } catch (err) {
                    // 这里兜住 dispatch 层之外的异常，确保状态和日志都能留下来。
                    if (messageState.get(inbound.messageId)) {
                        messageState.update(inbound.messageId, {
                            status: "FAILED",
                            routingMode: decision.kind,
                            targetAgentIds: decision.targetAgentIds,
                            sessionKeys: [],
                            error: String(err),
                        });
                    }
                    baseLog.error({ err: String(err) }, "async dispatch failed");
                }
            });

            return true;
        }

        // 不是当前插件关心的路径，返回 false 让宿主继续匹配其它 handler。
        return false;
    };
}
