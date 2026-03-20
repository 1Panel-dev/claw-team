/**
 * 这个文件负责把入站消息解析成明确的路由决策。
 * 简单说，它决定这条消息到底应该打给哪个 Agent，以及属于哪种路由模式。
 *
 * 调用流程：
 * 1. http/routes.ts 在入站请求通过校验后调用这里。
 * 2. 这里根据 chat.type、mentions、directAgentId、targetAgentIds 和配置默认值做判断。
 * 3. 最终返回 DIRECT / GROUP_MENTION / GROUP_BROADCAST 三种之一。
 * 4. dispatcher 再根据这个结果决定执行一个 Agent 还是多个 Agent。
 */
import { z } from "zod";
import type { AccountConfig } from "../config.js";
import { resolveAliasMap, resolveAllowedAgents } from "../config.js";
import type { RoutingMode } from "../types.js";

export type RouteKind = RoutingMode;

// 这是插件当前接受的标准入站消息格式。
export const InboundMessageSchema = z
    .object({
        messageId: z.string().min(8),
        accountId: z.string().optional(),

        chat: z
            .object({
                type: z.enum(["direct", "group"]),
                chatId: z.string().min(1),
                threadId: z.string().optional(),
                groupId: z.string().optional(),
            })
            .strict(),

        from: z
            .object({
                userId: z.string().min(1),
                displayName: z.string().optional(),
            })
            .strict(),

        text: z.string().min(1),

        mentions: z.array(z.string().min(1)).optional(),

        directAgentId: z.string().optional(),

        targetAgentIds: z.array(z.string().min(1)).optional(),

        timestamp: z.number().int().optional(),
    })
    .strict();

export type InboundMessage = z.infer<typeof InboundMessageSchema>;

// RouteDecision 是路由层给 dispatcher 的最终输出。
export type RouteDecision = {
    kind: RouteKind;
    targetAgentIds: string[];
    mentionTokens: string[];
    groupId?: string;
    conversationId: string;
};

// 如果调用方没显式提供 mentions，就从文本里兜底解析 @token。
export function parseMentionsFromText(text: string): string[] {
    const out: string[] = [];
    const re = /@([a-zA-Z0-9_-]{1,64})/g;
    for (;;) {
        const m = re.exec(text);
        if (!m) break;
        out.push(m[1]);
    }
    return out;
}

// 去重并清理空白，避免后续同一个 Agent 被重复投递。
function uniq(xs: string[]): string[] {
    return Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean)));
}

// 先走 aliasMap，把用户侧 token 转成真正的 agent id。
function resolveTokensToAgentIds(tokens: string[], acct: AccountConfig): string[] {
    const aliasMap = resolveAliasMap(acct);
    return uniq(tokens.map((t) => aliasMap[t] ?? t));
}

// resolveRoute 是整个消息路由策略的中心。
export function resolveRoute(input: InboundMessage, acct: AccountConfig): RouteDecision {
    const isGroup = input.chat.type === "group";
    // 优先使用调用方显式传入的 mentions；没有的话再从 text 中推断。
    const explicitMentions = input.mentions && input.mentions.length > 0 ? input.mentions : undefined;
    const parsedMentions = explicitMentions ?? parseMentionsFromText(input.text);
    const mentionTokens = uniq(parsedMentions);

    if (!isGroup) {
        // 单聊要求最终必须能确定唯一目标 Agent。
        const directAgent = input.directAgentId ?? mentionTokens[0];
        if (!directAgent) {
            throw new Error("DIRECT chat requires directAgentId or a @mention token");
        }
        return {
            kind: "DIRECT",
            mentionTokens,
            targetAgentIds: resolveTokensToAgentIds([directAgent], acct),
            conversationId: input.chat.threadId ?? input.chat.chatId,
        };
    }

    if (mentionTokens.length > 0) {
        // 群聊中只要出现 mention，就只投给被 @ 的对象。
        return {
            kind: "GROUP_MENTION",
            mentionTokens,
            targetAgentIds: resolveTokensToAgentIds(mentionTokens, acct),
            groupId: input.chat.groupId ?? input.chat.chatId,
            conversationId: input.chat.threadId ?? input.chat.chatId,
        };
    }

    // 群聊无 @ 时，优先采用请求方指定的 targetAgentIds，否则回退到配置默认值。
    const fromRequest = input.targetAgentIds && input.targetAgentIds.length > 0 ? uniq(input.targetAgentIds) : [];
    const defaults = resolveAllowedAgents(acct);

    const targets = fromRequest.length > 0 ? fromRequest : defaults;
    if (targets.length === 0) {
        throw new Error("GROUP_BROADCAST requires targetAgentIds or configured allowedAgentIds");
    }

    // 广播前再做一次上限截断，避免一次消息误打太多 Agent。
    const limited = targets.slice(0, acct.limits.maxBroadcastAgents);
    return {
        kind: "GROUP_BROADCAST",
        mentionTokens,
        targetAgentIds: limited,
        groupId: input.chat.groupId ?? input.chat.chatId,
        conversationId: input.chat.threadId ?? input.chat.chatId,
    };
}
