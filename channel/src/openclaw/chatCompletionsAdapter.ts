import { Agent as UndiciAgent } from "undici";

import type { AgentTurnParams, OpenClawRunChunk, OpenClawRuntimeAdapter, RuntimeLike } from "./runtimeTypes.js";

// 这里把 Claw Team 的 turn 参数收敛成 OpenAI 兼容请求。
// 对 OpenClaw 来说，真正的路由仍然由请求头里的 agent/session 控制。
function makeGatewayPayload(params: AgentTurnParams) {
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
function extractText(value: unknown): string {
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
function buildGatewayHeaders(params: AgentTurnParams): Record<string, string> {
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

function buildGatewayUrlFromParams(params: AgentTurnParams): string {
    return new URL("/v1/chat/completions", params.gateway.baseUrl).toString();
}

const secureGatewayDispatcher = new UndiciAgent();
const insecureGatewayDispatcher = new UndiciAgent({
    connect: {
        rejectUnauthorized: false,
    },
});

function getGatewayDispatcher(params: AgentTurnParams): UndiciAgent | undefined {
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
async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<OpenClawRunChunk> {
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

// 这一层只负责 HTTP chatCompletions 调用，不做任何 transport 回退。
export function createChatCompletionsRuntimeAdapter(api: RuntimeLike): OpenClawRuntimeAdapter {
    return {
        async *runAgentTextTurn(params): AsyncIterable<OpenClawRunChunk> {
            const response = await fetch(buildGatewayUrlFromParams(params), {
                method: "POST",
                headers: buildGatewayHeaders(params),
                body: JSON.stringify(makeGatewayPayload(params)),
                dispatcher: getGatewayDispatcher(params) as any,
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                api.logger?.warn?.("OpenClaw gateway HTTP request failed", {
                    status: response.status,
                    body: errorText.slice(0, 500),
                });
                throw new Error(`openclaw_gateway_http_${response.status}`);
            }

            const contentType = response.headers.get("content-type") ?? "";
            if (contentType.includes("text/event-stream")) {
                if (!response.body) {
                    throw new Error("OpenClaw gateway returned an empty SSE body");
                }

                // SSE 场景会先产出增量 chunk，最后再补一个聚合 final，
                // 这样上层 callback 和 plugin_runtime 的输出形态保持一致。
                let emitted = false;
                let collected = "";
                for await (const chunk of parseSseStream(response.body)) {
                    emitted = true;
                    collected += chunk.text;
                    yield chunk;
                }

                if (emitted) {
                    yield { text: collected, isFinal: true };
                    return;
                }
            }

            const result = await response.json();
            const text = extractText(result);
            if (!text) {
                throw new Error("OpenClaw gateway returned no readable text payload");
            }

            yield { text, isFinal: true };
        },
    };
}
