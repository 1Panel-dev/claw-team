import type { OpenClawRunChunk } from "./runtimeTypes.js";
import type { AgentTurnParams, RuntimeLike } from "./runtimeTypes.js";
import {
    buildInboundContext,
    extractTextFromReplyPayload,
    loadDirectDmHelper,
    type ResolvedPluginRuntime,
} from "./pluginRuntimeShared.js";

// 标准单聊主会话优先走官方 direct-dm helper。
// 但 ClawSwarm 的 agent/session 已由上层明确选定，所以这里会固定 route 结果，
// 不再让宿主侧静态 routing 抢回路由权。
export async function runViaOfficialDirectDmHelper(params: {
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
                    // ClawSwarm 已经明确选定了目标 agent 和 session。
                    // 这里继续复用官方 direct-DM 主链路，但不再让宿主侧
                    // 的静态 channel routing 覆盖这个显式选择。
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
        channelLabel: "ClawSwarm",
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
        bodyForAgent: params.turn.text,
        commandBody: params.turn.text,
        extraContext: buildInboundContext(params.turn, params.runtime.finalizeInboundContext),
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
