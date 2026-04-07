import { request } from "undici";

import type { AccountConfig } from "../config.js";

type SendTextHttpPayload = {
    kind: string;
    sourceCsId: string;
    targetCsId: string;
    topic: string;
    message: string;
    windowSeconds?: number;
    softMessageLimit?: number;
    hardMessageLimit?: number;
};

type SendTextHttpResponse = {
    dialogueId: number;
    conversationId: number;
    openingMessageId: string;
};

export async function postClawSwarmSendText(params: {
    account: AccountConfig;
    payload: SendTextHttpPayload;
}): Promise<SendTextHttpResponse> {
    const url = new URL("/api/v1/clawswarm/send-text", params.account.baseUrl).toString();

    const response = await request(url, {
        method: "POST",
        headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${params.account.outboundToken}`,
        },
        body: JSON.stringify(params.payload),
        headersTimeout: params.account.retry.callbackTimeoutMs,
        bodyTimeout: params.account.retry.callbackTimeoutMs,
    });

    const text = await response.body.text().catch(() => "");
    if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(`clawswarm_send_text_http_${response.statusCode}`);
        (error as Error & { detail?: string }).detail = text.slice(0, 300);
        throw error;
    }

    let body: unknown = {};
    try {
        body = text ? JSON.parse(text) : {};
    } catch {
        body = {};
    }

    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    return {
        dialogueId: Number(record.dialogueId ?? 0),
        conversationId: Number(record.conversationId ?? 0),
        openingMessageId: String(record.openingMessageId ?? "").trim(),
    };
}
