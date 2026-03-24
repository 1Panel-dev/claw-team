/**
 * 这里只做 transport 组装和选择。
 * 具体实现都拆到独立 adapter 文件，方便后面单独删除 chat_completions
 * 或 plugin_runtime，而不会把 transport 判断逻辑一起扯坏。
 */
import { createChatCompletionsRuntimeAdapter } from "./chatCompletionsAdapter.js";
import { createPluginRuntimeAdapter } from "./pluginRuntimeAdapter.js";
import { shouldUseChatCompletions } from "./transportSelection.js";
import type { OpenClawRunChunk, OpenClawRuntimeAdapter, RuntimeLike } from "./runtimeTypes.js";
export type { OpenClawRunChunk, OpenClawRuntimeAdapter } from "./runtimeTypes.js";

export function createOpenClawRuntimeAdapter(api: RuntimeLike): OpenClawRuntimeAdapter {
    const pluginRuntime = createPluginRuntimeAdapter(api);
    const chatCompletions = createChatCompletionsRuntimeAdapter(api);

    // auto 只是一个“按宿主配置选 transport”的薄包装；
    // 真正的执行逻辑都在各自 adapter 里，方便后续单独删除任意实现。
    const auto: OpenClawRuntimeAdapter = {
        async *runAgentTextTurn(params): AsyncIterable<OpenClawRunChunk> {
            if (shouldUseChatCompletions(api)) {
                yield* chatCompletions.runAgentTextTurn({
                    ...params,
                    gateway: { ...params.gateway, transport: "chat_completions" },
                });
                return;
            }

            yield* pluginRuntime.runAgentTextTurn({
                ...params,
                gateway: { ...params.gateway, transport: "plugin_runtime" },
            });
        },
    };

    return {
        async *runAgentTextTurn(params): AsyncIterable<OpenClawRunChunk> {
            // 显式 transport 永远优先，只有 auto 才去读宿主开关。
            if (params.gateway.transport === "auto") {
                yield* auto.runAgentTextTurn(params);
                return;
            }

            if (params.gateway.transport === "plugin_runtime") {
                yield* pluginRuntime.runAgentTextTurn(params);
                return;
            }

            yield* chatCompletions.runAgentTextTurn(params);
        },
    };
}

// 这个 mock adapter 主要供单元测试和本地无宿主环境时使用，
// 保持和真实 adapter 一样的 chunk/final 形态即可。
export function createMockOpenClawRuntimeAdapter(opts?: {
    prefix?: string;
    chunks?: number;
}): OpenClawRuntimeAdapter {
    const prefix = opts?.prefix ?? "mock";
    const chunks = opts?.chunks ?? 2;

    return {
        async *runAgentTextTurn(params): AsyncIterable<OpenClawRunChunk> {
            for (let i = 1; i <= chunks; i++) {
                yield { text: `${prefix}:${params.agentId}:chunk${i}` };
            }
            yield { text: `${prefix}:${params.agentId}:final`, isFinal: true };
        },
    };
}
