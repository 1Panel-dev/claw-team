import { describe, expect, it, vi } from "vitest";

import { AccountConfigSchema, resolveGatewayRuntimeConfig } from "../config.js";
import { createPluginRuntimeAdapter } from "../openclaw/pluginRuntimeAdapter.js";

const dispatchInboundDirectDmWithRuntimeMock = vi.fn();

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
    dispatchInboundDirectDmWithRuntime: dispatchInboundDirectDmWithRuntimeMock,
}));

const gateway = resolveGatewayRuntimeConfig(
    AccountConfigSchema.parse({
        baseUrl: "https://clawswarm.example.com",
        outboundToken: "outbound-token",
        inboundSigningSecret: "1234567890123456",
        gateway: {
            baseUrl: "https://gateway.example.com",
            transport: "plugin_runtime",
            model: "openclaw",
            stream: true,
            allowInsecureTls: false,
        },
    }),
);

describe("createPluginRuntimeAdapter", () => {
    it("maps runtime reply deliveries into the existing chunk stream", async () => {
        const loadConfig = vi.fn(() => ({ session: { store: "~/.openclaw/agents/{agentId}/sessions/sessions.json" } }));
        const resolveStorePath = vi.fn(() => "/tmp/weather-sessions.json");
        const recordInboundSession = vi.fn(async () => undefined);
        const finalizeInboundContext = vi.fn((ctx) => ({ ...ctx }));
        const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (params) => {
            await params.dispatcherOptions.deliver({ text: "hello " });
            await params.dispatcherOptions.deliver({ text: "world" });
            return { queuedFinal: true };
        });

        const adapter = createPluginRuntimeAdapter({
            runtime: {
                config: { loadConfig },
                channel: {
                    reply: {
                        finalizeInboundContext,
                        dispatchReplyWithBufferedBlockDispatcher,
                    },
                    session: {
                        resolveStorePath,
                        recordInboundSession,
                    },
                },
            },
        });

        const chunks: string[] = [];
        for await (const chunk of adapter.runAgentTextTurn({
            agentId: "weather",
            channelId: "clawswarm",
            accountId: "default",
            sessionKey: "agent:weather:weather",
            peer: { kind: "direct", id: "conv-1" },
            from: { userId: "user-1", displayName: "Alice" },
            text: "明天天气如何？",
            gateway,
        })) {
            chunks.push(chunk.text);
        }

        expect(chunks).toEqual(["hello ", "world", "hello world"]);
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(resolveStorePath).toHaveBeenCalledWith("~/.openclaw/agents/{agentId}/sessions/sessions.json", {
            agentId: "weather",
        });
        expect(recordInboundSession).toHaveBeenCalledTimes(1);
        expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    });

    it("fails with a stable error when plugin runtime helpers are unavailable", async () => {
        const adapter = createPluginRuntimeAdapter({});

        await expect(async () => {
            for await (const _chunk of adapter.runAgentTextTurn({
                agentId: "weather",
                channelId: "clawswarm",
                accountId: "default",
                sessionKey: "agent:weather:weather",
                peer: { kind: "direct", id: "conv-1" },
                from: { userId: "user-1" },
                text: "明天天气如何？",
                gateway,
            })) {
                // no-op
            }
        }).rejects.toThrow("openclaw_plugin_runtime_unavailable");
    });

    it("keeps the explicitly selected direct route when using the official direct-DM helper", async () => {
        dispatchInboundDirectDmWithRuntimeMock.mockReset();
        dispatchInboundDirectDmWithRuntimeMock.mockImplementationOnce(async (params) => {
            const resolved = params.runtime.channel.routing.resolveAgentRoute({
                cfg: params.cfg,
                channel: params.channel,
                accountId: params.accountId,
                peer: params.peer,
            });
            expect(resolved).toEqual({
                agentId: "weather",
                sessionKey: "agent:weather:weather",
                accountId: "default",
            });
            await params.deliver({ text: "forecast ok" });
        });

        const adapter = createPluginRuntimeAdapter({
            runtime: {
                config: { loadConfig: () => ({ session: { store: "~/.openclaw/agents/{agentId}/sessions/sessions.json" } }) },
                channel: {
                    routing: {
                        resolveAgentRoute: () => ({
                            agentId: "main",
                            sessionKey: "agent:main:main",
                            accountId: "default",
                        }),
                    },
                    reply: {
                        resolveEnvelopeFormatOptions: () => ({}),
                        formatAgentEnvelope: ({ body }: { body: string }) => body,
                        finalizeInboundContext: (ctx: unknown) => ctx,
                        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
                    },
                    session: {
                        resolveStorePath: () => "/tmp/weather-sessions.json",
                        readSessionUpdatedAt: () => undefined,
                        recordInboundSession: vi.fn(async () => undefined),
                    },
                },
            },
        });

        const chunks: string[] = [];
        for await (const chunk of adapter.runAgentTextTurn({
            agentId: "weather",
            channelId: "clawswarm",
            accountId: "default",
            sessionKey: "agent:weather:weather",
            peer: { kind: "direct", id: "conv-1" },
            from: { userId: "user-1", displayName: "Alice" },
            text: "明天天气如何？",
            gateway,
        })) {
            chunks.push(chunk.text);
        }

        expect(chunks).toEqual(["forecast ok", "forecast ok"]);
        expect(dispatchInboundDirectDmWithRuntimeMock).toHaveBeenCalledTimes(1);
    });

    it("extracts final text from rich content payloads delivered by the official helper", async () => {
        dispatchInboundDirectDmWithRuntimeMock.mockReset();
        dispatchInboundDirectDmWithRuntimeMock.mockImplementationOnce(async (params) => {
            await params.deliver({
                content: [
                    { type: "text", text: "好，信息够了。" },
                    { type: "text", text: "下面给你完整方案。" },
                ],
            });
        });

        const adapter = createPluginRuntimeAdapter({
            runtime: {
                config: { loadConfig: () => ({ session: { store: "~/.openclaw/agents/{agentId}/sessions/sessions.json" } }) },
                channel: {
                    routing: {
                        resolveAgentRoute: () => ({
                            agentId: "main",
                            sessionKey: "agent:main:main",
                            accountId: "default",
                        }),
                    },
                    reply: {
                        resolveEnvelopeFormatOptions: () => ({}),
                        formatAgentEnvelope: ({ body }: { body: string }) => body,
                        finalizeInboundContext: (ctx: unknown) => ctx,
                        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
                    },
                    session: {
                        resolveStorePath: () => "/tmp/weather-sessions.json",
                        readSessionUpdatedAt: () => undefined,
                        recordInboundSession: vi.fn(async () => undefined),
                    },
                },
            },
        });

        const chunks: string[] = [];
        for await (const chunk of adapter.runAgentTextTurn({
            agentId: "weather",
            channelId: "clawswarm",
            accountId: "default",
            sessionKey: "agent:weather:weather",
            peer: { kind: "direct", id: "conv-1" },
            from: { userId: "user-1", displayName: "Alice" },
            text: "给我完整方案",
            gateway,
        })) {
            chunks.push(chunk.text);
        }

        expect(chunks).toEqual([
            "好，信息够了。下面给你完整方案。",
            "好，信息够了。下面给你完整方案。",
        ]);
        expect(dispatchInboundDirectDmWithRuntimeMock).toHaveBeenCalledTimes(1);
    });
});
