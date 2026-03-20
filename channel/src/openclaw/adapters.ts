/**
 * 这个文件隔离插件和 OpenClaw 宿主 runtime 的具体调用方式。
 * 未来如果宿主 SDK 接口名变化，优先改这里，而不要把变化扩散到 dispatcher。
 *
 * 调用流程：
 * 1. dispatchDirect 调用 runAgentTextTurn。
 * 2. 这里通过 OpenClaw 官方公开的 OpenAI 兼容 HTTP 端点发起 agent turn。
 * 3. 如果返回 SSE 流，就边解析边向上游产出 chunk；如果返回 JSON，就产出一次最终结果。
 * 4. 这样上层 dispatcher 就不需要知道 Gateway 的具体协议细节。
 */
import { Agent as UndiciAgent } from "undici";

import type { GatewayRuntimeConfig } from "../config.js";

export type OpenClawRunChunk = { text: string; isFinal?: boolean };

export interface OpenClawRuntimeAdapter {
    // 统一对上层暴露“文本 chunk 流”的抽象，哪怕宿主底层是一次性返回。
    runAgentTextTurn(params: {
        agentId: string;
        channelId: string;
        accountId: string;
        sessionKey: string;
        peer: { kind: "direct" | "group"; id: string; threadId?: string };
        from: { userId: string; displayName?: string };
        text: string;
        gateway: GatewayRuntimeConfig;
    }): AsyncIterable<OpenClawRunChunk>;
}

type RuntimeLike = { logger?: any };

type AgentTurnParams = Parameters<OpenClawRuntimeAdapter["runAgentTextTurn"]>[0];

// 这里使用官方 OpenAI 兼容端点：
// POST /v1/chat/completions
// Header:
//   Authorization: Bearer <gateway token>   (如果网关启用了 token)
//   x-openclaw-agent-id: <agentId>
//   x-openclaw-session-key: <sessionKey>
// Body:
//   { model: "openclaw", stream: true, messages: [...] }
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
        user: params.sessionKey
    };
}

// extractText 负责把多种可能的 OpenAI 兼容返回结构归一成纯文本。
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

function buildGatewayHeaders(params: AgentTurnParams): Record<string, string> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-openclaw-agent-id": params.agentId,
        "x-openclaw-session-key": params.sessionKey,
    };

    const token = params.gateway.token;
    if (token) {
        headers.authorization = `Bearer ${token}`;
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

export function createOpenClawRuntimeAdapter(api: RuntimeLike): OpenClawRuntimeAdapter {
    return {
        async *runAgentTextTurn(params): AsyncIterable<OpenClawRunChunk> {
            const url = buildGatewayUrlFromParams(params);
            const payload = makeGatewayPayload(params);

            const response = await fetch(url, {
                method: "POST",
                headers: buildGatewayHeaders(params),
                body: JSON.stringify(payload),
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

            // stream=true 时，官方 OpenAI 兼容端点使用 SSE。
            if (contentType.includes("text/event-stream")) {
                if (!response.body) {
                    throw new Error("OpenClaw gateway returned an empty SSE body");
                }

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

            // 非 SSE 时，按一次性 OpenAI 兼容 JSON 响应处理。
            const result = await response.json();
            const text = extractText(result);

            if (!text) {
                throw new Error("OpenClaw gateway returned no readable text payload");
            }

            yield { text, isFinal: true };
        },
    };
}

// 这个 mock adapter 主要供单元测试和本地无宿主环境时使用。
export function createMockOpenClawRuntimeAdapter(opts?: {
    prefix?: string;
    chunks?: number;
}): OpenClawRuntimeAdapter {
    const prefix = opts?.prefix ?? "mock";
    const chunks = opts?.chunks ?? 2;

    return {
        async *runAgentTextTurn(params): AsyncIterable<OpenClawRunChunk> {
            for (let i = 1; i <= chunks; i++) {
                yield { text: `${prefix}:${params.agentId}:chunk${i}` };
            }
            yield { text: `${prefix}:${params.agentId}:final`, isFinal: true };
        },
    };
}
