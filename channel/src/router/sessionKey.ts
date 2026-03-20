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
}): string {
    const agentId = norm(params.agentId);
    const chatId = norm(params.chatId);
    // direct 没有显式 threadId 时，就退回 chatId 作为会话 id。
    const conversationId = params.threadId ? norm(params.threadId) : chatId;

    if (params.chatType === "direct") {
        return `${CHANNEL_ID}:direct:${conversationId}:agent:${agentId}`;
    }

    // 群聊在 broadcast 和 mention 之间必须生成不同的 key，否则会串上下文。
    const routeSegment = params.routeKind === "GROUP_MENTION" ? "mention" : "broadcast";
    return `${CHANNEL_ID}:group:${chatId}:${routeSegment}:${agentId}:conv:${conversationId}`;
}
