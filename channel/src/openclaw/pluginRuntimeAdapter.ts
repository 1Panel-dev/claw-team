import crypto from "node:crypto";

import type { OpenClawRunChunk, OpenClawRuntimeAdapter } from "./runtimeTypes.js";

// 官方 direct-dm helper 所需的最小模块形状。
// 这里只声明我们真正会用到的能力，避免把整个宿主 bundle 类型化一遍。
type DirectDmHelperModule = {
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

// plugin_runtime transport 实际依赖到的宿主 runtime 能力集合。
// 这里故意只保留最小表面，后续 OpenClaw 升级时更容易发现破坏性变化。
type RuntimeLike = {
    logger?: {
        warn?: (message: string, meta?: Record<string, unknown>) => void;
    };
    runtime?: {
        config?: {
            loadConfig?: () => unknown;
        };
        channel?: {
            routing?: {
                resolveAgentRoute?: (params: {
                    cfg: unknown;
                    channel: string;
                    accountId: string;
                    peer: { kind: "direct"; id: string };
                }) => { agentId: string; sessionKey: string; accountId?: string };
            };
            reply?: {
                resolveEnvelopeFormatOptions?: (cfg: unknown) => unknown;
                formatAgentEnvelope?: (params: {
                    channel: string;
                    from: string;
                    timestamp?: number;
                    previousTimestamp?: number;
                    envelope: unknown;
                    body: string;
                }) => string;
                finalizeInboundContext?: (ctx: Record<string, unknown>) => any;
                dispatchReplyWithBufferedBlockDispatcher?: (params: {
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
            session?: {
                resolveStorePath?: (store?: string, opts?: { agentId?: string; env?: NodeJS.ProcessEnv }) => string;
                readSessionUpdatedAt?: (params: { storePath: string; sessionKey: string }) => number | undefined;
                recordInboundSession?: (params: {
                    storePath: string;
                    sessionKey: string;
                    ctx: Record<string, unknown>;
                    onRecordError: (err: unknown) => void;
                }) => Promise<void>;
            };
        };
    };
};

type AgentTurnParams = Parameters<OpenClawRuntimeAdapter["runAgentTextTurn"]>[0];
type ResolvedPluginRuntime = ReturnType<typeof resolvePluginRuntime>;

// reply dispatcher 的 deliver 回调可能返回多种 payload 形状，这里统一抽纯文本。
function extractTextFromReplyPayload(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.message === "string") return record.message;
    return "";
}

// 手动 runtime 路径需要先构造一个标准 inbound context，
// 让后续 reply-runtime 能按官方 channel 的方式继续处理。
function buildInboundContext(params: AgentTurnParams, finalizeInboundContext: (ctx: Record<string, unknown>) => any) {
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
function resolvePluginRuntime(api: RuntimeLike) {
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
async function loadDirectDmHelper(): Promise<DirectDmHelperModule | null> {
    try {
        return (await import("openclaw/plugin-sdk/channel-inbound" as string)) as DirectDmHelperModule;
    } catch {
        return null;
    }
}

// 标准单聊主会话优先走官方 direct-dm helper。
// 但 Claw Team 的 agent/session 已由上层明确选定，所以这里会固定 route 结果，
// 不再让宿主侧静态 routing 抢回路由权。
async function runViaOfficialDirectDmHelper(params: {
    api: RuntimeLike;
    runtime: ResolvedPluginRuntime;
    turn: AgentTurnParams;
    queueChunk: (chunk: OpenClawRunChunk) => void;
}): Promise<boolean> {
    const helperModule = await loadDirectDmHelper();
    const dispatchInboundDirectDmWithRuntime = helperModule?.dispatchInboundDirectDmWithRuntime;
    const expectedMainSessionKey = `agent:${params.turn.agentId}:${params.turn.agentId}`;

    // 只有“标准单聊主会话”才交给官方 helper，其他场景走手动 runtime，
    // 这样可以最大化复用官方路径，同时不破坏我们的动态路由语义。
    if (typeof dispatchInboundDirectDmWithRuntime !== "function") {
        return false;
    }

    if (params.turn.peer.kind !== "direct" || params.turn.sessionKey !== expectedMainSessionKey) {
        return false;
    }

    if (
        typeof params.runtime.routing?.resolveAgentRoute !== "function" ||
        typeof params.runtime.resolveEnvelopeFormatOptions !== "function" ||
        typeof params.runtime.formatAgentEnvelope !== "function" ||
        typeof params.runtime.readSessionUpdatedAt !== "function"
    ) {
        return false;
    }

    const resolveEnvelopeFormatOptions = params.runtime.resolveEnvelopeFormatOptions;
    const formatAgentEnvelope = params.runtime.formatAgentEnvelope;
    const readSessionUpdatedAt = params.runtime.readSessionUpdatedAt;
    let collected = "";
    await dispatchInboundDirectDmWithRuntime({
        cfg: params.runtime.loadConfig(),
        runtime: {
            channel: {
                routing: {
                    // Claw Team has already selected the target agent/session. Keep the
                    // official direct-DM pipeline, but do not let host-side static channel
                    // routing override that explicit choice.
                    resolveAgentRoute: () => ({
                        agentId: params.turn.agentId,
                        sessionKey: params.turn.sessionKey,
                        accountId: params.turn.accountId,
                    }),
                },
                session: {
                    resolveStorePath: params.runtime.resolveStorePath,
                    readSessionUpdatedAt,
                    recordInboundSession: params.runtime.recordInboundSession,
                },
                reply: {
                    resolveEnvelopeFormatOptions,
                    formatAgentEnvelope,
                    finalizeInboundContext: params.runtime.finalizeInboundContext,
                    dispatchReplyWithBufferedBlockDispatcher: params.runtime.dispatchReplyWithBufferedBlockDispatcher,
                },
            },
        },
        channel: params.turn.channelId,
        channelLabel: "Claw Team",
        accountId: params.turn.accountId,
        peer: { kind: "direct", id: params.turn.peer.id },
        senderId: params.turn.from.userId,
        senderAddress: `${params.turn.channelId}:${params.turn.from.userId}`,
        recipientAddress: `${params.turn.channelId}:${params.turn.peer.id}`,
        conversationLabel: params.turn.from.displayName?.trim() || params.turn.from.userId,
        rawBody: params.turn.text,
        messageId: crypto.randomUUID(),
        timestamp: Date.now(),
        commandAuthorized: false,
        deliver: async (payload) => {
            const text = extractTextFromReplyPayload(payload);
            if (!text) return;
            collected += text;
            params.queueChunk({ text });
        },
        onRecordError: (err) => {
            params.api.logger?.warn?.("Failed to record inbound session for official direct-dm helper", {
                error: err instanceof Error ? err.message : String(err),
                agentId: params.turn.agentId,
                sessionKey: params.turn.sessionKey,
            });
        },
        onDispatchError: (err, info) => {
            throw new Error(`${info.kind}:${err instanceof Error ? err.message : String(err)}`);
        },
    });

    // 和 chatCompletions transport 一样，最后补一个聚合 final，保持上层回调一致。
    if (collected) {
        params.queueChunk({ text: collected, isFinal: true });
    }
    return true;
}

// 非标准单聊主会话（例如群聊、定向或特殊 session）走手动 runtime 路径。
// 顺序是：先记录 inbound session，再交给 reply-runtime 驱动 agent 回复。
async function runViaManualPluginRuntime(params: {
    api: RuntimeLike;
    runtime: ResolvedPluginRuntime;
    turn: AgentTurnParams;
    queueChunk: (chunk: OpenClawRunChunk) => void;
}): Promise<void> {
    const cfg = params.runtime.loadConfig();
    const ctx = buildInboundContext(params.turn, params.runtime.finalizeInboundContext);
    const storePath = params.runtime.resolveStorePath((cfg as any)?.session?.store, {
        agentId: params.turn.agentId,
    });

    let collected = "";

    await params.runtime.recordInboundSession({
        storePath,
        sessionKey: params.turn.sessionKey,
        ctx,
        onRecordError: (err) => {
            params.api.logger?.warn?.("Failed to record inbound session for plugin runtime transport", {
                error: err instanceof Error ? err.message : String(err),
                agentId: params.turn.agentId,
                sessionKey: params.turn.sessionKey,
            });
        },
    });

    await params.runtime.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
            deliver: async (payload) => {
                const text = extractTextFromReplyPayload(payload);
                if (!text) return;
                collected += text;
                params.queueChunk({ text });
            },
            onError: (err) => {
                throw err;
            },
        },
    });

    // 手动 runtime 也补 final，维持两种 transport 的统一输出约定。
    if (collected) {
        params.queueChunk({ text: collected, isFinal: true });
    }
}

export function createPluginRuntimeAdapter(api: RuntimeLike): OpenClawRuntimeAdapter {
    return {
        async *runAgentTextTurn(params) {
            // 一进入 transport 就先解析宿主依赖，尽早失败，避免半程异常难排查。
            let runtime;
            try {
                runtime = resolvePluginRuntime(api);
            } catch (error) {
                api.logger?.warn?.("Plugin runtime transport unavailable", {
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error instanceof Error ? error : new Error("openclaw_plugin_runtime_unavailable");
            }

            const pendingChunks: OpenClawRunChunk[] = [];
            let wakeReader: (() => void) | undefined;
            let finished = false;
            let failure: Error | undefined;

            const notifyReader = () => wakeReader?.();
            // runtime/reply helper 是回调式的；这里把它们桥接成上层消费的异步 chunk 流。
            const queueChunk = (chunk: OpenClawRunChunk) => {
                pendingChunks.push(chunk);
                notifyReader();
            };

            const dispatchPromise = (async () => {
                // 优先尝试官方单聊 helper；只有它不适用时才退回到手动 runtime。
                const handledByOfficialHelper = await runViaOfficialDirectDmHelper({
                    api,
                    runtime,
                    turn: params,
                    queueChunk,
                });

                if (!handledByOfficialHelper) {
                    await runViaManualPluginRuntime({
                        api,
                        runtime,
                        turn: params,
                        queueChunk,
                    });
                }
                finished = true;
                notifyReader();
            })().catch((error) => {
                failure = error instanceof Error ? error : new Error(String(error));
                finished = true;
                notifyReader();
            });

            try {
                for (;;) {
                    if (pendingChunks.length > 0) {
                        yield pendingChunks.shift()!;
                        continue;
                    }

                    if (finished) {
                        if (failure) throw failure;
                        break;
                    }

                    await new Promise<void>((resolve) => {
                        wakeReader = () => {
                            wakeReader = undefined;
                            resolve();
                        };
                    });
                }
            } finally {
                await dispatchPromise.catch(() => undefined);
            }
        },
    };
}
