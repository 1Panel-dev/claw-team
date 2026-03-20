/**
 * 这些测试主要保护 runtime adapter 的兼容假设。
 * 现在 adapter 走的是 OpenClaw 官方公开 HTTP 端点，所以这里主要验证：
 * 1. SSE 流能否被正确解析
 * 2. 普通 JSON 返回能否被正确解析
 */
import { describe, expect, it } from "vitest";

import { AccountConfigSchema, resolveGatewayRuntimeConfig } from "../config.js";
import { createMockOpenClawRuntimeAdapter, createOpenClawRuntimeAdapter } from "../openclaw/adapters.js";

const gateway = resolveGatewayRuntimeConfig(
    AccountConfigSchema.parse({
        baseUrl: "https://claw-team.example.com",
        outboundToken: "outbound-token",
        inboundSigningSecret: "1234567890123456",
        gateway: {
            baseUrl: "https://gateway.example.com",
            token: "gateway-token",
            model: "openclaw",
            stream: true,
            allowInsecureTls: false,
        },
    }),
);

describe("createMockOpenClawRuntimeAdapter", () => {
    it("yields a final chunk", async () => {
        const adapter = createMockOpenClawRuntimeAdapter({ prefix: "test", chunks: 1 });
        const chunks: string[] = [];

        for await (const chunk of adapter.runAgentTextTurn({
            agentId: "qa",
            channelId: "claw-team",
            accountId: "default",
            sessionKey: "claw-team:direct:c1:agent:qa",
            peer: { kind: "direct", id: "c1" },
            from: { userId: "u1" },
            text: "hello",
            gateway,
        })) {
            chunks.push(chunk.text);
        }

        expect(chunks.at(-1)).toBe("test:qa:final");
    });
});

describe("createOpenClawRuntimeAdapter", () => {
    it("parses SSE streaming responses from the gateway", async () => {
        const adapter = createOpenClawRuntimeAdapter({});
        const originalFetch = globalThis.fetch;

        globalThis.fetch = (async () =>
            new Response(
                [
                    'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
                    'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
                    "data: [DONE]\n\n",
                ].join(""),
                {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                },
            )) as typeof fetch;

        const chunks: string[] = [];
        try {
            for await (const chunk of adapter.runAgentTextTurn({
                agentId: "qa",
                channelId: "claw-team",
                accountId: "default",
                sessionKey: "claw-team:direct:c1:agent:qa",
                peer: { kind: "direct", id: "c1" },
                from: { userId: "u1" },
                text: "hello",
                gateway,
            })) {
                chunks.push(chunk.text);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(chunks).toEqual(["hello ", "world", "hello world"]);
    });

    it("parses JSON responses from the gateway", async () => {
        const adapter = createOpenClawRuntimeAdapter({});
        const originalFetch = globalThis.fetch;

        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: "single response" } }],
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            )) as typeof fetch;

        const chunks: string[] = [];
        try {
            for await (const chunk of adapter.runAgentTextTurn({
                agentId: "pm",
                channelId: "claw-team",
                accountId: "default",
                sessionKey: "claw-team:direct:c2:agent:pm",
                peer: { kind: "direct", id: "c2" },
                from: { userId: "u2" },
                text: "status?",
                gateway,
            })) {
                chunks.push(chunk.text);
                expect(chunk.isFinal).toBe(true);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(chunks).toEqual(["single response"]);
    });
});
