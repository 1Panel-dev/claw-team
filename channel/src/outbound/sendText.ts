/**
 * 这是 claw-team channel 的出站消息适配层。
 *
 * 作用：
 * 1. 规范化目标 CT ID。
 * 2. 解析 OpenClaw 通过 sendText 传入的结构化 JSON。
 * 3. 调用调度中心的正式业务接口，把一次 sendText 转成 Agent 对话创建请求。
 *
 * 设计原则：
 * - target 校验尽量集中在这里和后端，不把业务语义分散到宿主的多层校验里。
 * - 对“看起来正确但格式有噪音”的 CT ID 做宽松归一化，减少发送链被意外中断。
 */
import { request } from "undici";

import type { Logger } from "../observability/logger.js";
import { CHANNEL_ID, type AccountConfig } from "../config.js";

export const AGENT_DIALOGUE_START_KIND = "agent_dialogue.start" as const;
export const CT_ID_PREFIX = "ctid:" as const;
const TARGET_CT_ID_PATTERN = /^CT[AU]-\d{4,}$/;

type AgentDialogueStartPayload = {
    kind: typeof AGENT_DIALOGUE_START_KIND;
    sourceCtId: string;
    topic: string;
    message: string;
    windowSeconds?: number;
    softMessageLimit?: number;
    hardMessageLimit?: number;
};

type SendTextContext = {
    cfg: unknown;
    to: string;
    text: string;
    accountId?: string | null;
    replyToId?: string | null;
    threadId?: string | number | null;
    identity?: unknown;
    deps?: unknown;
    silent?: boolean;
};

type SendTextResult = {
    messageId: string;
    conversationId?: string;
    meta?: Record<string, unknown>;
};

type TargetResolution =
    | { ok: true; to: string }
    | { ok: false; error: Error };

type MessagingTargetResolution = {
    to: string;
    kind: "user" | "group" | "channel";
    display?: string;
    source?: "normalized" | "directory";
};

function stripWrappingQuotes(value: string): string {
    let current = value.trim();
    while (
        current.length >= 2 &&
        ((current.startsWith('"') && current.endsWith('"')) ||
            (current.startsWith("'") && current.endsWith("'")) ||
            (current.startsWith("`") && current.endsWith("`")))
    ) {
        current = current.slice(1, -1).trim();
    }
    return current;
}

function normalizeTargetCtId(to: string): string {
    // OpenClaw 在不同调用链里可能会给 target 包上 @、引号、零宽字符或变体短横线。
    // 这里统一做宽松归一化，避免把“看起来正确”的 CT ID 错误拒掉。
    const raw = stripWrappingQuotes(
        to
            .trim()
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/[\u2010-\u2015\u2212\uFF0D]/g, "-"),
    );
    const withoutAt = raw.startsWith("@") ? raw.slice(1).trim() : raw;
    const normalized = withoutAt.toLowerCase().startsWith(CT_ID_PREFIX)
        ? withoutAt.slice(CT_ID_PREFIX.length)
        : withoutAt;
    const value = normalized.trim().toUpperCase();
    if (!TARGET_CT_ID_PATTERN.test(value)) {
        throw new Error("claw_team_invalid_target_ct_id");
    }
    return value;
}

export function resolveClawTeamTarget(to?: string): TargetResolution {
    const raw = String(to ?? "").trim();
    if (!raw) {
        return {
            ok: false,
            error: new Error("Delivering to Claw Team requires a target CT ID like CTA-0009 or CTU-0001."),
        };
    }
    try {
        return {
            ok: true,
            to: normalizeTargetCtId(raw),
        };
    } catch {
        return {
            // framework 层过早拒绝会直接拦住 sendText，让我们拿不到更完整的上下文。
            // 这里宽松放行，让 sendText 与后端业务接口去做最终校验和报错。
            ok: true,
            to: raw,
        };
    }
}

export function looksLikeClawTeamCtId(raw: string, normalized?: string): boolean {
    const candidate = String(normalized ?? raw ?? "").trim();
    try {
        normalizeTargetCtId(candidate);
        return true;
    } catch {
        return false;
    }
}

export async function resolveClawTeamMessagingTarget(params: {
    input: string;
}): Promise<MessagingTargetResolution | null> {
    try {
        const to = normalizeTargetCtId(params.input);
        return {
            to,
            kind: "user",
            display: to,
            source: "normalized",
        };
    } catch {
        return null;
    }
}

function parseAgentDialogueStartPayload(text: string): AgentDialogueStartPayload {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("claw_team_send_text_invalid_json");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("claw_team_send_text_invalid_payload");
    }

    const record = parsed as Record<string, unknown>;
    if (String(record.kind ?? "").trim() !== AGENT_DIALOGUE_START_KIND) {
        throw new Error("claw_team_send_text_unsupported_kind");
    }

    const sourceCtId = String(record.sourceCtId ?? "").trim().toUpperCase();
    const topic = String(record.topic ?? "").trim();
    const message = String(record.message ?? "").trim();
    const windowSeconds = typeof record.windowSeconds === "number" ? record.windowSeconds : undefined;
    const softMessageLimit = typeof record.softMessageLimit === "number" ? record.softMessageLimit : undefined;
    const hardMessageLimit = typeof record.hardMessageLimit === "number" ? record.hardMessageLimit : undefined;

    if (!/^CTA-\d{4,}$/.test(sourceCtId)) {
        throw new Error("claw_team_send_text_invalid_source_ct_id");
    }
    if (!topic) {
        throw new Error("claw_team_send_text_missing_topic");
    }
    if (!message) {
        throw new Error("claw_team_send_text_missing_message");
    }

    return {
        kind: AGENT_DIALOGUE_START_KIND,
        sourceCtId,
        topic,
        message,
        ...(windowSeconds !== undefined ? { windowSeconds } : {}),
        ...(softMessageLimit !== undefined ? { softMessageLimit } : {}),
        ...(hardMessageLimit !== undefined ? { hardMessageLimit } : {}),
    };
}

export async function sendClawTeamText(params: {
    ctx: SendTextContext;
    account: AccountConfig;
    logger: Logger;
}): Promise<SendTextResult> {
    let targetCtId = "";
    try {
        targetCtId = normalizeTargetCtId(params.ctx.to);
    } catch {
        params.logger.warn(
            {
                rawTarget: String(params.ctx.to ?? ""),
            },
            "Claw Team sendText received an invalid CT target",
        );
        throw new Error("claw_team_invalid_target_ct_id");
    }
    const payload = parseAgentDialogueStartPayload(params.ctx.text);
    const url = new URL("/api/v1/claw-team/send-text", params.account.baseUrl).toString();

    const response = await request(url, {
        method: "POST",
        headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${params.account.outboundToken}`,
        },
        body: JSON.stringify({
            kind: payload.kind,
            sourceCtId: payload.sourceCtId,
            targetCtId,
            topic: payload.topic,
            message: payload.message,
            ...(payload.windowSeconds !== undefined ? { windowSeconds: payload.windowSeconds } : {}),
            ...(payload.softMessageLimit !== undefined ? { softMessageLimit: payload.softMessageLimit } : {}),
            ...(payload.hardMessageLimit !== undefined ? { hardMessageLimit: payload.hardMessageLimit } : {}),
        }),
        headersTimeout: params.account.retry.callbackTimeoutMs,
        bodyTimeout: params.account.retry.callbackTimeoutMs,
    });

    const text = await response.body.text().catch(() => "");
    if (response.statusCode < 200 || response.statusCode >= 300) {
        params.logger.warn(
            {
                statusCode: response.statusCode,
                targetCtId,
                sourceCtId: payload.sourceCtId,
                body: text.slice(0, 300),
            },
            "Claw Team sendText request failed",
        );
        throw new Error(`claw_team_send_text_http_${response.statusCode}`);
    }

    let body: unknown = {};
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        body = {};
    }
    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const dialogueId = Number(record.dialogueId ?? 0);
    const conversationId = Number(record.conversationId ?? 0);
    const openingMessageId = String(record.openingMessageId ?? "").trim();

    return {
        messageId: openingMessageId || `claw-team:${CHANNEL_ID}:${dialogueId || "unknown"}`,
        ...(conversationId > 0 ? { conversationId: String(conversationId) } : {}),
        meta: {
            kind: AGENT_DIALOGUE_START_KIND,
            dialogueId,
            conversationId,
            targetCtId,
        },
    };
}

export {
    normalizeTargetCtId,
    parseAgentDialogueStartPayload,
};
