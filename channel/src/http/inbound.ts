import crypto from "node:crypto";

import { dispatchDirect } from "../dispatcher/dispatchDirect.js";
import { dispatchGroup } from "../dispatcher/dispatchGroup.js";
import { buildSessionKey } from "../router/sessionKey.js";
import { InboundMessageSchema, resolveRoute } from "../router/resolveRoute.js";
import { verifyInboundSignature } from "../security/signature.js";
import type { ClawSwarmCallbackClient } from "../callback/client.js";
import type { AccountConfig } from "../config.js";
import type { Logger } from "../observability/logger.js";
import type { OpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import type { RouteDecision } from "../router/resolveRoute.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { MessageStateStore } from "../store/messageState.js";
import { readRawBody, sendJson } from "./common.js";
import { createInboundMessageState } from "./dispatchState.js";

export async function handleInboundRoute(params: {
    pathname: string;
    method: string;
    req: any;
    res: any;
    channelId: string;
    getAccount: (accountId?: string) => AccountConfig & { accountId: string };
    logger: Logger;
    idempotency: IdempotencyStore;
    messageState: MessageStateStore;
    clawSwarmFactory: (acct: AccountConfig) => ClawSwarmCallbackClient;
    openclaw: OpenClawRuntimeAdapter;
}): Promise<boolean> {
    const {
        pathname,
        method,
        req,
        res,
        channelId,
        getAccount,
        logger,
        idempotency,
        messageState,
        clawSwarmFactory,
        openclaw,
    } = params;

    // 这是最核心的 webhook：ClawSwarm 后端把用户消息投递到这里。
    if (pathname !== "/clawswarm/v1/inbound" || method !== "POST") {
        return false;
    }

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

    const clawSwarm = clawSwarmFactory(acct2);

    // route decision 决定了这条消息最终打给谁。
    let decision: RouteDecision;
    try {
        decision = resolveRoute(inbound, acct2);
    } catch (err) {
        sendJson(res, 400, { error: "route_error", detail: String(err) });
        return true;
    }

    // 在真正异步执行前，先把消息状态记录好，后面排障就有抓手。
    createInboundMessageState({
        messageState,
        inbound,
        traceId,
        accountId,
        decision,
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
                    clawSwarm,
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
                    clawSwarm,
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
