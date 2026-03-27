import crypto from "node:crypto";

import type { AgentTurnParams, RuntimeLike } from "./runtimeTypes.js";

// 官方 direct-dm helper 所需的最小模块形状。
// 这里只声明我们真正会用到的能力，避免把整个宿主 bundle 类型化一遍。
export type DirectDmHelperModule = {
    dispatchInboundDirectDmWithRuntime?: (params: {
        cfg: unknown;
        runtime: {
            channel: {
                routing: {
                    resolveAgentRoute: (params: {
                        cfg: unknown;
                        channel: string;
                        accountId: string;
                        peer: { kind: "direct"; id: string };
                    }) => { agentId: string; sessionKey: string; accountId?: string };
                };
                session: {
                    resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
                    readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
                    recordInboundSession: (params: {
                        storePath: string;
                        sessionKey: string;
                        ctx: Record<string, unknown>;
                        onRecordError: (err: unknown) => void;
                    }) => Promise<void>;
                };
                reply: {
                    resolveEnvelopeFormatOptions: (cfg: unknown) => unknown;
                    formatAgentEnvelope: (params: {
                        channel: string;
                        from: string;
                        timestamp?: number;
                        previousTimestamp?: number;
                        envelope: unknown;
                        body: string;
                    }) => string;
                    finalizeInboundContext: (ctx: Record<string, unknown>) => any;
                    dispatchReplyWithBufferedBlockDispatcher: (params: {
                        ctx: unknown;
                        cfg: unknown;
                        dispatcherOptions: {
                            deliver: (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => Promise<void>;
                            onError?: (err: unknown, info: { kind: string }) => void;
                            onReplyStart?: () => void | Promise<void>;
                        };
                        replyOptions?: Record<string, unknown>;
                    }) => Promise<unknown>;
                };
            };
        };
        channel: string;
        channelLabel: string;
        accountId: string;
        peer: { kind: "direct"; id: string };
        senderId: string;
        senderAddress: string;
        recipientAddress: string;
        conversationLabel: string;
        rawBody: string;
        messageId: string;
        timestamp?: number;
        commandAuthorized?: boolean;
        bodyForAgent?: string;
        commandBody?: string;
        provider?: string;
        surface?: string;
        originatingChannel?: string;
        originatingTo?: string;
        extraContext?: Record<string, unknown>;
        deliver: (payload: unknown) => Promise<void>;
        onRecordError: (err: unknown) => void;
        onDispatchError: (err: unknown, info: { kind: string }) => void;
    }) => Promise<unknown>;
};

export type ResolvedPluginRuntime = ReturnType<typeof resolvePluginRuntime>;

// reply dispatcher 的 deliver 回调可能返回多种 payload 形状，这里统一抽纯文本。
export function extractTextFromReplyPayload(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.message === "string") return record.message;
    return "";
}

// 手动 runtime 路径需要先构造一个标准 inbound context，
// 让后续 reply-runtime 能按官方 channel 的方式继续处理。
export function buildInboundContext(
    params: AgentTurnParams,
    finalizeInboundContext: (ctx: Record<string, unknown>) => any,
) {
    const peerLabel = params.from.displayName?.trim() || params.from.userId;
    const to = `${params.channelId}:${params.peer.id}`;

    return finalizeInboundContext({
        Body: params.text,
        RawBody: params.text,
        CommandBody: params.text,
        BodyForAgent: params.text,
        BodyForCommands: params.text,
        From: `${params.channelId}:${params.from.userId}`,
        To: to,
        SessionKey: params.sessionKey,
        AccountId: params.accountId,
        OriginatingChannel: params.channelId,
        OriginatingTo: to,
        ChatType: params.peer.kind,
        SenderName: peerLabel,
        SenderId: params.from.userId,
        Provider: params.channelId,
        Surface: params.channelId,
        ConversationLabel: peerLabel,
        Timestamp: Date.now(),
        MessageSid: crypto.randomUUID(),
        CommandAuthorized: false,
    });
}

// 只提取 plugin_runtime transport 必需的宿主 helper。
// 如果这些能力缺失，直接认为该 transport 不可用，避免 halfway 才失败。
export function resolvePluginRuntime(api: RuntimeLike) {
    const runtime = api.runtime;
    const loadConfig = runtime?.config?.loadConfig;
    const reply = runtime?.channel?.reply;
    const session = runtime?.channel?.session;
    const routing = runtime?.channel?.routing;

    if (
        typeof loadConfig !== "function" ||
        typeof reply?.finalizeInboundContext !== "function" ||
        typeof reply?.dispatchReplyWithBufferedBlockDispatcher !== "function" ||
        typeof session?.resolveStorePath !== "function" ||
        typeof session?.recordInboundSession !== "function"
    ) {
        throw new Error("openclaw_plugin_runtime_unavailable");
    }

    return {
        loadConfig,
        routing,
        finalizeInboundContext: reply.finalizeInboundContext,
        resolveEnvelopeFormatOptions: reply.resolveEnvelopeFormatOptions,
        formatAgentEnvelope: reply.formatAgentEnvelope,
        dispatchReplyWithBufferedBlockDispatcher: reply.dispatchReplyWithBufferedBlockDispatcher,
        resolveStorePath: session.resolveStorePath,
        readSessionUpdatedAt: session.readSessionUpdatedAt,
        recordInboundSession: session.recordInboundSession,
    };
}

// 官方 direct-dm helper 走的是 channel-inbound 公开子路径。
// 这里按需懒加载，既方便测试 mock，也避免启动时绑定宿主内部模块。
export async function loadDirectDmHelper(): Promise<DirectDmHelperModule | null> {
    try {
        return (await import("openclaw/plugin-sdk/channel-inbound" as string)) as DirectDmHelperModule;
    } catch {
        return null;
    }
}
