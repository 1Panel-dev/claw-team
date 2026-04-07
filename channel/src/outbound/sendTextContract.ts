/**
 * 这里集中定义 sendText 的结构化协议。
 * 只负责“消息长什么样”，不负责目标识别和 HTTP 调用。
 */
export const AGENT_DIALOGUE_START_KIND = "agent_dialogue.start" as const;

export type AgentDialogueStartPayload = {
    kind: typeof AGENT_DIALOGUE_START_KIND;
    sourceCtId: string;
    topic: string;
    message: string;
    windowSeconds?: number;
    softMessageLimit?: number;
    hardMessageLimit?: number;
};

function parseJsonObject(text: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("clawswarm_send_text_invalid_json");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("clawswarm_send_text_invalid_payload");
    }

    return parsed as Record<string, unknown>;
}

export function parseAgentDialogueStartPayload(text: string): AgentDialogueStartPayload {
    const record = parseJsonObject(text);
    if (String(record.kind ?? "").trim() !== AGENT_DIALOGUE_START_KIND) {
        throw new Error("clawswarm_send_text_unsupported_kind");
    }

    const sourceCtId = String(record.sourceCtId ?? "").trim().toUpperCase();
    const topic = String(record.topic ?? "").trim();
    const message = String(record.message ?? "").trim();
    const windowSeconds = typeof record.windowSeconds === "number" ? record.windowSeconds : undefined;
    const softMessageLimit = typeof record.softMessageLimit === "number" ? record.softMessageLimit : undefined;
    const hardMessageLimit = typeof record.hardMessageLimit === "number" ? record.hardMessageLimit : undefined;

    if (!/^CTA-\d{4,}$/.test(sourceCtId)) {
        throw new Error("clawswarm_send_text_invalid_source_ct_id");
    }
    if (!topic) {
        throw new Error("clawswarm_send_text_missing_topic");
    }
    if (!message) {
        throw new Error("clawswarm_send_text_missing_message");
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
