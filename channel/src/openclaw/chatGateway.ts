import { Agent as UndiciAgent } from "undici";

import type { AgentTurnParams, OpenClawRunChunk } from "./runtimeTypes.js";

// 这里把 ClawSwarm 的 turn 参数收敛成 OpenAI 兼容请求。
// 对 OpenClaw 来说，真正的路由仍然由请求头里的 agent/session 控制。
export function makeGatewayPayload(params: AgentTurnParams) {
    return {
        model: params.gateway.model,
        stream: params.gateway.stream,
        messages: [
            {
                role: "user",
                content: params.text,
            },
        ],
        user: params.sessionKey,
    };
}

// Gateway 兼容端点在不同模式下返回结构不完全一致，这里做一层宽松提取。
export function extractText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";

    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.delta === "string") return record.delta;
    if (typeof record.outputText === "string") return record.outputText;
    if (typeof record.message === "string") return record.message;
    if (Array.isArray(record.choices)) {
        return record.choices
            .map((choice) => extractText(choice))
            .filter(Boolean)
            .join("");
    }
    if (record.delta && typeof record.delta === "object") {
        return extractText(record.delta);
    }
    if (record.message && typeof record.message === "object") {
        return extractText(record.message);
    }
    if (Array.isArray(record.content)) {
        return record.content
            .map((item) => extractText(item))
            .filter(Boolean)
            .join("");
    }
    if (Array.isArray(record.output)) {
        return record.output
            .map((item) => extractText(item))
            .filter(Boolean)
            .join("");
    }

    return "";
}

// 指定 agentId/sessionKey 是这条 transport 最关键的路由条件。
export function buildGatewayHeaders(params: AgentTurnParams): Record<string, string> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-openclaw-agent-id": params.agentId,
        "x-openclaw-session-key": params.sessionKey,
    };

    if (params.gateway.token) {
        headers.authorization = `Bearer ${params.gateway.token}`;
    }

    return headers;
}

export function buildGatewayUrlFromParams(params: AgentTurnParams): string {
    return new URL("/v1/chat/completions", params.gateway.baseUrl).toString();
}

const secureGatewayDispatcher = new UndiciAgent();
const insecureGatewayDispatcher = new UndiciAgent({
    connect: {
        rejectUnauthorized: false,
    },
});

export function getGatewayDispatcher(params: AgentTurnParams): UndiciAgent | undefined {
    const isHttps = params.gateway.baseUrl.startsWith("https://");
    if (!isHttps) return undefined;
    return params.gateway.allowInsecureTls ? insecureGatewayDispatcher : secureGatewayDispatcher;
}

// SSE 模式下只取本次 turn 对应的 delta/message 文本，其他字段都交给上层忽略。
function extractDeltaTextFromChatChunk(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;

    if (Array.isArray(record.choices)) {
        return record.choices
            .map((choice) => {
                if (!choice || typeof choice !== "object") return "";
                const choiceRecord = choice as Record<string, unknown>;
                return extractText(choiceRecord.delta ?? choiceRecord.message ?? choiceRecord);
            })
            .filter(Boolean)
            .join("");
    }

    return extractText(payload);
}

// OpenClaw 开启 stream 时，兼容端点返回 SSE。这里按最小规则把 data: 块转成 chunk 流。
export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<OpenClawRunChunk> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;

            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            const dataLines = rawEvent
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim());

            if (dataLines.length === 0) continue;

            const data = dataLines.join("\n");
            if (data === "[DONE]") {
                return;
            }

            const payload = JSON.parse(data);
            const text = extractDeltaTextFromChatChunk(payload);
            if (text) {
                yield { text, isFinal: false };
            }
        }
    }
}
