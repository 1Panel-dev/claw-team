/**
 * 这些测试主要保护 runtime adapter 的兼容假设。
 * 现在 adapter 走的是 OpenClaw 官方公开 HTTP 端点，所以这里主要验证：
 * 1. SSE 流能否被正确解析
 * 2. 普通 JSON 返回能否被正确解析
 */
import { describe, expect, it } from "vitest";

import { AccountConfigSchema, resolveGatewayRuntimeConfig } from "../config.js";
import { dispatchDirect } from "../dispatcher/dispatchDirect.js";
import { createMockOpenClawRuntimeAdapter, createOpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import { createLogger } from "../observability/logger.js";
import { InMemoryMessageStateStore } from "../store/messageState.js";
import { createIdempotencyStore } from "../store/idempotency.js";
import type { ClawSwarmEvent } from "../callback/client.js";

const gateway = resolveGatewayRuntimeConfig(
    AccountConfigSchema.parse({
        baseUrl: "https://clawswarm.example.com",
        outboundToken: "outbound-token",
        inboundSigningSecret: "1234567890123456",
        gateway: {
            baseUrl: "https://gateway.example.com",
            token: "gateway-token",
            transport: "chat_completions",
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
            channelId: "clawswarm",
            accountId: "default",
            sessionKey: "clawswarm:direct:c1:agent:qa",
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
                channelId: "clawswarm",
                accountId: "default",
                sessionKey: "clawswarm:direct:c1:agent:qa",
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
                channelId: "clawswarm",
                accountId: "default",
                sessionKey: "clawswarm:direct:c2:agent:pm",
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

    it("fails with a stable error when plugin_runtime transport is selected but the host plugin runtime is unavailable", async () => {
        const adapter = createOpenClawRuntimeAdapter({});

        await expect(async () => {
            for await (const _chunk of adapter.runAgentTextTurn({
                agentId: "pm",
                channelId: "clawswarm",
                accountId: "default",
                sessionKey: "agent:pm:pm",
                peer: { kind: "direct", id: "c2" },
                from: { userId: "u2" },
                text: "status?",
                gateway: {
                    ...gateway,
                    transport: "plugin_runtime",
                },
            })) {
                // no-op
            }
        }).rejects.toThrow("openclaw_plugin_runtime_unavailable");
    });

    it("uses chat_completions in auto mode when host config enables gateway.http.endpoints.chatCompletions.enabled", async () => {
        const adapter = createOpenClawRuntimeAdapter({
            runtime: {
                config: {
                    loadConfig: () => ({
                        gateway: {
                            http: {
                                endpoints: {
                                    chatCompletions: {
                                        enabled: true,
                                    },
                                },
                            },
                        },
                    }),
                },
            },
        });
        const originalFetch = globalThis.fetch;

        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: "auto http" } }],
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
                channelId: "clawswarm",
                accountId: "default",
                sessionKey: "agent:pm:pm",
                peer: { kind: "direct", id: "c2" },
                from: { userId: "u2" },
                text: "status?",
                gateway: {
                    ...gateway,
                    transport: "auto",
                },
            })) {
                chunks.push(chunk.text);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(chunks).toEqual(["auto http"]);
    });

    it("uses plugin_runtime in auto mode when host config does not enable chatCompletions", async () => {
        const dispatchReplyWithBufferedBlockDispatcher = async (params: {
            dispatcherOptions: {
                deliver: (payload: { text?: string }) => Promise<void>;
            };
        }) => {
            await params.dispatcherOptions.deliver({ text: "auto runtime" });
            return { queuedFinal: true };
        };

        const adapter = createOpenClawRuntimeAdapter({
            runtime: {
                config: {
                    loadConfig: () => ({
                        gateway: {
                            http: {
                                endpoints: {
                                    chatCompletions: {
                                        enabled: false,
                                    },
                                },
                            },
                        },
                        session: { store: "~/.openclaw/agents/{agentId}/sessions/sessions.json" },
                    }),
                },
                channel: {
                    reply: {
                        finalizeInboundContext: (ctx: unknown) => ctx,
                        dispatchReplyWithBufferedBlockDispatcher,
                    },
                    session: {
                        resolveStorePath: () => "/tmp/pm-sessions.json",
                        recordInboundSession: async () => undefined,
                    },
                },
            },
        });

        const chunks: string[] = [];
        for await (const chunk of adapter.runAgentTextTurn({
            agentId: "pm",
            channelId: "clawswarm",
            accountId: "default",
            sessionKey: "agent:pm:pm",
            peer: { kind: "direct", id: "c2" },
            from: { userId: "u2" },
            text: "status?",
            gateway: {
                ...gateway,
                transport: "auto",
            },
        })) {
            chunks.push(chunk.text);
        }

        expect(chunks).toEqual(["auto runtime", "auto runtime"]);
    });

    it("does not duplicate reply.final text when an SSE adapter emits an aggregated final chunk", async () => {
        const accountConfig = AccountConfigSchema.parse({
            baseUrl: "https://clawswarm.example.com",
            outboundToken: "outbound-token",
            inboundSigningSecret: "1234567890123456",
            gateway: {
                baseUrl: "https://gateway.example.com",
                token: "gateway-token",
                model: "openclaw",
                stream: true,
                allowInsecureTls: false,
            },
        });
        const logger = createLogger();
        const messageState = new InMemoryMessageStateStore();
        const idempotency = createIdempotencyStore({ mode: "memory", logger });
        const events: ClawSwarmEvent[] = [];

        messageState.create({
            messageId: "msg-test-1234",
            traceId: "trace-1",
            accountId: "default",
            conversationId: "conv-1",
            targetAgentIds: [],
            sessionKeys: [],
            status: "ROUTED",
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
        });

        await dispatchDirect({
            channelId: "clawswarm",
            accountId: "default",
            accountConfig,
            logger,
            idempotency,
            messageState,
            clawSwarm: {
                async sendEvent(event: ClawSwarmEvent) {
                    events.push(event);
                },
            },
            openclaw: {
                async *runAgentTextTurn() {
                    yield { text: "hello " };
                    yield { text: "world" };
                    yield { text: "hello world", isFinal: true };
                },
            },
            inbound: {
                messageId: "msg-test-1234",
                accountId: "default",
                chat: { type: "direct", chatId: "conv-1" },
                from: { userId: "user-1", displayName: "User" },
                text: "hello",
                directAgentId: "qa",
            },
            agentId: "qa",
            routeKind: "DIRECT",
            traceId: "trace-1",
        });

        const finalEvent = events.find((event) => event.eventType === "reply.final");
        expect(finalEvent?.payload.text).toBe("hello world");

        const chunkEvents = events.filter((event) => event.eventType === "reply.chunk");
        expect(chunkEvents.map((event) => event.payload.text)).toEqual(["hello ", "world"]);
    });

    it("includes rich message parts in reply.final events", async () => {
        const accountConfig = AccountConfigSchema.parse({
            baseUrl: "https://clawswarm.example.com",
            outboundToken: "outbound-token",
            inboundSigningSecret: "1234567890123456",
            gateway: {
                baseUrl: "https://gateway.example.com",
                token: "gateway-token",
                model: "openclaw",
                stream: true,
                allowInsecureTls: false,
            },
        });
        const logger = createLogger();
        const messageState = new InMemoryMessageStateStore();
        const idempotency = createIdempotencyStore({ mode: "memory", logger });
        const events: ClawSwarmEvent[] = [];

        messageState.create({
            messageId: "msg-parts-1234",
            traceId: "trace-parts",
            accountId: "default",
            conversationId: "conv-parts",
            targetAgentIds: [],
            sessionKeys: [],
            status: "ROUTED",
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
        });

        await dispatchDirect({
            channelId: "clawswarm",
            accountId: "default",
            accountConfig,
            logger,
            idempotency,
            messageState,
            clawSwarm: {
                async sendEvent(event: ClawSwarmEvent) {
                    events.push(event);
                },
            },
            openclaw: {
                async *runAgentTextTurn() {
                    yield {
                        text: [
                            "巡检摘要如下：",
                            "",
                            "[[tool:预发巡检|completed|共检查 12 项，全部正常]]",
                            "",
                            "[[attachment:巡检报告.pdf|application/pdf|https://example.com/report.pdf]]",
                        ].join("\n"),
                        isFinal: true,
                    };
                },
            },
            inbound: {
                messageId: "msg-parts-1234",
                accountId: "default",
                chat: { type: "direct", chatId: "conv-parts" },
                from: { userId: "user-1", displayName: "User" },
                text: "status",
                directAgentId: "qa",
            },
            agentId: "qa",
            routeKind: "DIRECT",
            traceId: "trace-parts",
        });

        const finalEvent = events.find((event) => event.eventType === "reply.final");
        expect(finalEvent?.payload.parts).toEqual([
            { kind: "markdown", content: "巡检摘要如下：" },
            { kind: "tool_card", title: "预发巡检", status: "completed", summary: "共检查 12 项，全部正常" },
            {
                kind: "attachment",
                name: "巡检报告.pdf",
                mimeType: "application/pdf",
                url: "https://example.com/report.pdf",
            },
        ]);
    });
});
