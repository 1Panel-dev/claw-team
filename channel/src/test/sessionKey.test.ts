/**
 * 这些测试保护 sessionKey 规则不被无意改坏。
 * 一旦这里失败，通常意味着上下文隔离规则发生了变化。
 */
import { describe, expect, it } from "vitest";

import { buildSessionKey } from "../router/sessionKey.js";

describe("buildSessionKey", () => {
    it("builds direct session keys in openclaw-native form", () => {
        expect(
            buildSessionKey({
                agentId: "pm",
                chatType: "direct",
                chatId: "chat-1",
            }),
        ).toBe("agent:pm:pm");
    });

    it("builds dedicated direct session keys in clawswarm form", () => {
        expect(
            buildSessionKey({
                agentId: "pm",
                chatType: "direct",
                chatId: "chat-1",
                threadId: "conv-1",
                useDedicatedDirectSession: true,
            }),
        ).toBe("clawswarm:direct:conv-1:agent:pm");
    });

    it("builds mention session keys in documented form", () => {
        expect(
            buildSessionKey({
                agentId: "qa",
                chatType: "group",
                chatId: "proj-alpha",
                threadId: "conv-1",
                routeKind: "GROUP_MENTION",
            }),
        ).toBe("agent:qa:clawswarm:group:proj-alpha:route:mention:conv:conv-1");
    });

    it("builds broadcast session keys in agent-scoped group form", () => {
        expect(
            buildSessionKey({
                agentId: "pm",
                chatType: "group",
                chatId: "proj-alpha",
                threadId: "conv-2",
                routeKind: "GROUP_BROADCAST",
            }),
        ).toBe("agent:pm:clawswarm:group:proj-alpha:route:broadcast:conv:conv-2");
    });
});
