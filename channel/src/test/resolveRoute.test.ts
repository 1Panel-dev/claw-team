/**
 * 这些测试保护路由决策的核心规则：
 * 单聊必须只命中一个 Agent，群聊 mention 必须正确解析 alias。
 */
import { describe, expect, it } from "vitest";

import { AccountConfigSchema } from "../config.js";
import { resolveRoute } from "../router/resolveRoute.js";

// 用一份最小但完整的配置，避免每个测试重复写 schema 默认值。
const account = AccountConfigSchema.parse({
    baseUrl: "https://clawswarm.example.com",
    outboundToken: "outbound-token",
    inboundSigningSecret: "1234567890123456",
    agentDirectory: {
        allowedAgentIds: ["pm", "qa"],
        aliases: {
            tester: "qa",
        },
    },
});

describe("resolveRoute", () => {
    it("resolves direct messages", () => {
        const result = resolveRoute(
            {
                messageId: "msg_12345678",
                chat: { type: "direct", chatId: "chat-1" },
                from: { userId: "u1" },
                text: "hello",
                directAgentId: "pm",
            },
            account,
        );

        expect(result.kind).toBe("DIRECT");
        expect(result.targetAgentIds).toEqual(["pm"]);
        expect(result.conversationId).toBe("chat-1");
    });

    it("resolves group mentions through aliases", () => {
        const result = resolveRoute(
            {
                messageId: "msg_87654321",
                chat: { type: "group", chatId: "group-1", groupId: "proj-alpha" },
                from: { userId: "u2" },
                text: "@tester please verify",
            },
            account,
        );

        expect(result.kind).toBe("GROUP_MENTION");
        expect(result.targetAgentIds).toEqual(["qa"]);
        expect(result.groupId).toBe("proj-alpha");
    });
});
