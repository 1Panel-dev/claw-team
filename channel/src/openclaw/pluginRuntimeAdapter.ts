import type { OpenClawRunChunk, OpenClawRuntimeAdapter, RuntimeLike } from "./runtimeTypes.js";
import { runViaManualPluginRuntime } from "./pluginRuntimeManual.js";
import { runViaOfficialDirectDmHelper } from "./pluginRuntimeOfficial.js";
import { resolvePluginRuntime } from "./pluginRuntimeShared.js";

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
