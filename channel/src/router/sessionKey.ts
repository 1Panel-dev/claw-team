/**
 * 这个文件负责生成稳定的 sessionKey。
 * sessionKey 是上下文隔离的核心，一旦规则改动，历史会话连续性也会受影响。
 */
import { CHANNEL_ID } from "../config.js";
import type { RoutingMode } from "../types.js";

export type ChatType = "direct" | "group";

// 对 key 里的动态片段做轻量规范化，避免空格和特殊字符污染 sessionKey。
function norm(s: string): string {
    return s
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9:_-]/g, "_")
        .slice(0, 200);
}

export function buildSessionKey(params: {
    agentId: string;
    chatType: ChatType;
    chatId: string;
    // group 场景下需要知道是 mention 还是 broadcast，因为两者必须隔离上下文。
    routeKind?: RoutingMode;
    threadId?: string | undefined;
    useDedicatedDirectSession?: boolean | undefined;
}): string {
    const agentId = norm(params.agentId);
    const chatId = norm(params.chatId);
    // direct 没有显式 threadId 时，就退回 chatId 作为会话 id。
    const conversationId = params.threadId ? norm(params.threadId) : chatId;

    if (params.chatType === "direct") {
        if (params.useDedicatedDirectSession) {
            // 单独聊天通道沿用 ClawSwarm 自己的 direct 会话命名。
            return `${CHANNEL_ID}:direct:${conversationId}:agent:${agentId}`;
        }
        // 单聊场景改成对齐 OpenClaw Web UI 自身的原生 session 规则。
        // 这样从 ClawSwarm 发给某个 Agent 的单聊，会直接落到
        // OpenClaw 控制台里同一个 Agent 的既有会话里。
        return `agent:${agentId}:${agentId}`;
    }

    // 群聊需要遵循 OpenClaw 官方的 agent-scoped group session 规则：
    // agent:<agentId>:<channel>:group:<id>
    // 否则宿主侧很多逻辑会从 sessionKey 里解析不出 agentId，最后回退成 main。
    // 我们仍然在后缀里保留 route/conversation 信息，避免 mention/broadcast 串上下文。
    const routeSegment = params.routeKind === "GROUP_MENTION" ? "mention" : "broadcast";
    return `agent:${agentId}:${CHANNEL_ID}:group:${chatId}:route:${routeSegment}:conv:${conversationId}`;
}
