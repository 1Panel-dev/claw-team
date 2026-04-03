import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    findAssistantReplyForTranscriptUser,
    findMirrorableMessagesForTranscriptUser,
    registerWebchatTranscriptMirror,
} from "../openclaw/webchatMirror.js";
import {
    clearAllLocalOriginSessionsForTest,
    markLocalOriginSession,
} from "../openclaw/mirrorOriginRegistry.js";

function createApiMock(accountOverride?: Record<string, unknown>) {
    const handlers = new Map<string, (event: any, ctx?: any) => Promise<any> | any>();
    return {
        handlers,
        api: {
            config: {
                channels: {
                    "claw-team": {
                        accounts: {
                            default: {
                                baseUrl: "https://mirror.example.com",
                                outboundToken: "token-123",
                                ...accountOverride,
                            },
                        },
                    },
                },
            },
            on: (hookName: string, handler: (event: any, ctx?: any) => Promise<any> | any) => {
                handlers.set(hookName, handler);
            },
        },
    };
}

describe("findAssistantReplyForTranscriptUser", () => {
    it("returns the assistant reply that belongs to the specified transcript user message", () => {
        const transcript = [
            JSON.stringify({
                id: "user-1",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "first question" }],
                },
            }),
            JSON.stringify({
                id: "assistant-1",
                parentId: "user-1",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "first answer" }],
                },
            }),
            JSON.stringify({
                id: "user-2",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "second question" }],
                },
            }),
            JSON.stringify({
                id: "assistant-2",
                parentId: "user-2",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "second answer" }],
                },
            }),
        ].join("\n");

        expect(findAssistantReplyForTranscriptUser(transcript, "user-1")).toEqual({
            messageId: "assistant-1",
            parentId: "user-1",
            content: "first answer",
        });
    });

    it("returns the final assistant reply after internal claw-team dialogue user messages", () => {
        const transcript = [
            JSON.stringify({
                id: "user-1",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "请你和 CTA-0010 对话三轮" }],
                },
            }),
            JSON.stringify({
                id: "internal-user-1",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "[Claw Team Agent Dialogue]\nPartner: TestBot2" }],
                },
            }),
            JSON.stringify({
                id: "assistant-1",
                parentId: "internal-user-1",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "已与 TestBot2 完成三轮对话。" }],
                },
            }),
            JSON.stringify({
                id: "user-2",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "下一步做什么？" }],
                },
            }),
        ].join("\n");

        expect(findAssistantReplyForTranscriptUser(transcript, "user-1")).toEqual({
            messageId: "assistant-1",
            parentId: "internal-user-1",
            content: "已与 TestBot2 完成三轮对话。",
        });
    });

    it("returns all mirrorable transcript outputs for one webchat turn", () => {
        const transcript = [
            JSON.stringify({
                id: "user-1",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "请通过 claw-team channel 联系 TestBot2" }],
                },
            }),
            JSON.stringify({
                id: "assistant-tool-call",
                parentId: "user-1",
                message: {
                    role: "assistant",
                    stopReason: "toolUse",
                    content: [
                        { type: "text", text: "我先尝试通过 claw-team 发送消息。" },
                        { type: "toolCall", name: "message", arguments: { target: "default" } },
                    ],
                },
            }),
            JSON.stringify({
                id: "tool-result-1",
                parentId: "assistant-tool-call",
                message: {
                    role: "toolResult",
                    toolName: "message",
                    details: { status: "error" },
                    content: [{ type: "text", text: "Unknown target \"default\" for Claw Team." }],
                },
            }),
            JSON.stringify({
                id: "assistant-final",
                parentId: "tool-result-1",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "当前无法通过 claw-team channel 发送，请先完成配对。" }],
                },
            }),
        ].join("\n");

        expect(findMirrorableMessagesForTranscriptUser(transcript, "user-1")).toEqual([
            {
                messageId: "assistant-tool-call",
                content: "我先尝试通过 claw-team 发送消息。\n\n[[tool:message|running|{\n  \"target\": \"default\"\n}]]",
                isTerminalAssistant: false,
            },
            {
                messageId: "tool-result-1",
                content: '[[tool:message|failed|Unknown target "default" for Claw Team.\n\n{\n  "status": "error"\n}]]',
                isTerminalAssistant: false,
            },
            {
                messageId: "assistant-final",
                content: "当前无法通过 claw-team channel 发送，请先完成配对。",
                isTerminalAssistant: true,
            },
        ]);
    });

    it("omits thinking but preserves unknown assistant parts as raw summaries", () => {
        const transcript = [
            JSON.stringify({
                id: "user-1",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "show me everything except thinking" }],
                },
            }),
            JSON.stringify({
                id: "assistant-1",
                parentId: "user-1",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [
                        { type: "thinking", text: "internal reasoning" },
                        { type: "text", text: "visible text" },
                        { type: "attachment", name: "report.txt", url: "https://example.com/report.txt" },
                    ],
                },
            }),
        ].join("\n");

        expect(findMirrorableMessagesForTranscriptUser(transcript, "user-1")).toEqual([
            {
                messageId: "assistant-1",
                content:
                    'visible text\n\nTranscript part (attachment):\n```json\n{\n  "type": "attachment",\n  "name": "report.txt",\n  "url": "https://example.com/report.txt"\n}\n```',
                isTerminalAssistant: true,
            },
        ]);
    });
});

describe("registerWebchatTranscriptMirror", () => {
    const fetchMock = vi.fn();
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as any;

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => "",
        });
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        clearAllLocalOriginSessionsForTest();
    });

    it("mirrors a webchat user message after before_dispatch resolves the sessionKey", async () => {
        const { api, handlers } = createApiMock();

        registerWebchatTranscriptMirror(api as any, logger);

        await handlers.get("message_received")?.(
            {
                from: "webchat-user",
                content: "测试用户输入",
                metadata: {
                    messageId: "webchat-msg-001",
                },
            },
            {
                channelId: "webchat",
            },
        );

        expect(fetchMock).not.toHaveBeenCalled();

        await handlers.get("before_dispatch")?.(
            {
                content: "测试用户输入",
                sessionKey: "agent:main:main",
            },
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
            },
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenLastCalledWith(
            "https://mirror.example.com/api/v1/claw-team/webchat-mirror",
            expect.objectContaining({
                method: "POST",
                body: expect.any(String),
            }),
        );
        const payload = JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body as string);
        expect(payload).toMatchObject({
            channelId: "webchat",
            sessionKey: "agent:main:main",
            messageId: "webchat-msg-001",
            senderType: "user",
            content: "测试用户输入",
        });
        expect(typeof payload.timestamp).toBe("number");
    });

    it("avoids duplicating final assistant/tool-result writes and keeps tool flow mirroring", async () => {
        const { api, handlers } = createApiMock();

        registerWebchatTranscriptMirror(api as any, logger);

        await handlers.get("before_tool_call")?.(
            {
                toolName: "sessions_history",
                toolCallId: "call-001",
                params: {
                    sessionKey: "agent:main:main",
                    limit: 20,
                },
            },
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
                toolName: "sessions_history",
                toolCallId: "call-001",
            },
        );

        await handlers.get("tool_result_persist")?.(
            {
                toolName: "sessions_history",
                toolCallId: "call-001",
                message: {
                    role: "toolResult",
                    toolName: "sessions_history",
                    details: {
                        status: "error",
                    },
                    content: [{ type: "text", text: "tool failed" }],
                },
            },
            {
                sessionKey: "agent:main:main",
                toolName: "sessions_history",
                toolCallId: "call-001",
            },
        );

        await handlers.get("before_message_write")?.(
            {
                sessionKey: "agent:main:main",
                message: {
                    role: "assistant",
                    stopReason: "toolUse",
                    content: [
                        { type: "thinking", text: "hidden" },
                        { type: "text", text: "assistant pre-tool note" },
                        { type: "toolCall", name: "sessions_history", arguments: { limit: 20 } },
                    ],
                },
            },
            {
                sessionKey: "agent:main:main",
            },
        );

        await handlers.get("before_message_write")?.(
            {
                sessionKey: "agent:main:main",
                message: {
                    role: "toolResult",
                    toolName: "sessions_history",
                    content: [{ type: "text", text: "duplicate tool result write" }],
                    details: { status: "completed" },
                },
            },
            {
                sessionKey: "agent:main:main",
            },
        );

        await handlers.get("before_message_write")?.(
            {
                sessionKey: "agent:main:main",
                message: {
                    role: "assistant",
                    stopReason: "stop",
                    content: [{ type: "text", text: "duplicate final assistant write" }],
                },
            },
            {
                sessionKey: "agent:main:main",
            },
        );

        await handlers.get("llm_output")?.(
            {
                runId: "run-001",
                sessionId: "session-001",
                provider: "custom",
                model: "qwen3.6-plus",
                assistantTexts: ["intermediate assistant output", "assistant final output"],
            },
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
            },
        );

        const payloads = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string));

        expect(payloads).toEqual([
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
                messageId: "tool-call:agent:main:main:call-001",
                senderType: "assistant",
                content:
                    '[[tool:sessions_history|running|{\n  "sessionKey": "agent:main:main",\n  "limit": 20\n}]]',
                timestamp: expect.any(Number),
            },
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
                messageId: "tool-result:agent:main:main:call-001",
                senderType: "assistant",
                content: "[[tool:sessions_history|failed|tool failed\n\n{\n  \"status\": \"error\"\n}]]",
                timestamp: expect.any(Number),
            },
            expect.objectContaining({
                channelId: "webchat",
                sessionKey: "agent:main:main",
                senderType: "assistant",
                content: "assistant pre-tool note",
                timestamp: expect.any(Number),
            }),
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
                messageId: "llm-output:agent:main:main:run-001:1",
                senderType: "assistant",
                content: "assistant final output",
                timestamp: expect.any(Number),
            },
        ]);
        expect(payloads[2].messageId).toMatch(/^transcript-write:agent:main:main:assistant:/);
        expect(payloads.some((payload) => String(payload.content).includes("duplicate tool result write"))).toBe(false);
        expect(payloads.some((payload) => String(payload.content).includes("duplicate final assistant write"))).toBe(false);
        expect(payloads.some((payload) => String(payload.content).includes("[[event:agent_end|"))).toBe(false);
        expect(payloads.some((payload) => String(payload.content).includes("intermediate assistant output"))).toBe(false);
        expect(payloads.every((payload) => typeof payload.timestamp === "number")).toBe(true);
    });

    it("keeps tool-process mirror events for locally-originated claw-team direct turns but suppresses the final llm output", async () => {
        const { api, handlers } = createApiMock();
        registerWebchatTranscriptMirror(api as any, logger);

        markLocalOriginSession("agent:main:main");

        await handlers.get("before_tool_call")?.(
            {
                toolName: "weather",
                toolCallId: "call-local-1",
                params: { location: "Beijing" },
            },
            {
                sessionKey: "agent:main:main",
                toolName: "weather",
                toolCallId: "call-local-1",
            },
        );

        await handlers.get("llm_output")?.(
            {
                runId: "run-local-1",
                sessionId: "session-local-1",
                provider: "custom",
                model: "qwen3.6-plus",
                assistantTexts: ["local final output"],
            },
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
            },
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://mirror.example.com/api/v1/claw-team/webchat-mirror");
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer token-123",
            },
        });
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"))).toMatchObject({
            channelId: "webchat",
            sessionKey: "agent:main:main",
            senderType: "assistant",
            messageId: "tool-call:agent:main:main:call-local-1",
        });
    });

    it("can disable intermediate mirror messages while keeping final output", async () => {
        const { api, handlers } = createApiMock({
            webchatMirror: {
                includeIntermediateMessages: false,
            },
        });

        registerWebchatTranscriptMirror(api as any, logger);

        await handlers.get("before_tool_call")?.(
            {
                toolName: "weather",
                toolCallId: "call-compact-1",
                params: { location: "Shanghai" },
            },
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
                toolName: "weather",
                toolCallId: "call-compact-1",
            },
        );

        await handlers.get("tool_result_persist")?.(
            {
                toolName: "weather",
                toolCallId: "call-compact-1",
                message: {
                    role: "toolResult",
                    toolName: "weather",
                    details: { status: "completed" },
                    content: [{ type: "text", text: "sunny" }],
                },
            },
            {
                sessionKey: "agent:main:main",
                toolName: "weather",
                toolCallId: "call-compact-1",
            },
        );

        await handlers.get("before_message_write")?.(
            {
                sessionKey: "agent:main:main",
                message: {
                    role: "assistant",
                    stopReason: "toolUse",
                    content: [{ type: "text", text: "先看一下天气。" }],
                },
            },
            {
                sessionKey: "agent:main:main",
            },
        );

        await handlers.get("llm_output")?.(
            {
                runId: "run-compact-1",
                assistantTexts: ["最终答复"],
            },
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
            },
        );

        const payloads = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string));
        expect(payloads).toEqual([
            {
                channelId: "webchat",
                sessionKey: "agent:main:main",
                messageId: "llm-output:agent:main:main:run-compact-1:0",
                senderType: "assistant",
                content: "最终答复",
                timestamp: expect.any(Number),
            },
        ]);
    });
});
