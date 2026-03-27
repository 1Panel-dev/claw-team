import type { OpenClawRunChunk } from "./runtimeTypes.js";
import type { AgentTurnParams, RuntimeLike } from "./runtimeTypes.js";
import {
    buildInboundContext,
    extractTextFromReplyPayload,
    type ResolvedPluginRuntime,
} from "./pluginRuntimeShared.js";

// 非标准单聊主会话（例如群聊、定向或特殊 session）走手动 runtime 路径。
// 顺序是：先记录 inbound session，再交给 reply-runtime 驱动 agent 回复。
export async function runViaManualPluginRuntime(params: {
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
        onRecordError: (err: unknown) => {
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
            deliver: async (payload: unknown) => {
                const text = extractTextFromReplyPayload(payload);
                if (!text) return;
                collected += text;
                params.queueChunk({ text });
            },
            onError: (err: unknown) => {
                throw err;
            },
        },
    });

    // 手动 runtime 也补 final，维持两种 transport 的统一输出约定。
    if (collected) {
        params.queueChunk({ text: collected, isFinal: true });
    }
}
