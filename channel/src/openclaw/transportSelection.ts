import type { RuntimeLike } from "./runtimeTypes.js";

/**
 * auto 模式下只看宿主 openclaw.json 里的官方开关。
 * 这样 transport 选择由宿主配置决定，而不是靠运行时失败再回退。
 */
export function shouldUseChatCompletions(api: RuntimeLike): boolean {
    const loadConfig = api.runtime?.config?.loadConfig;
    if (typeof loadConfig !== "function") {
        return false;
    }

    try {
        const cfg = loadConfig() as
            | {
                  gateway?: {
                      http?: {
                          endpoints?: {
                              chatCompletions?: {
                                  enabled?: boolean;
                              };
                          };
                      };
                  };
              }
            | undefined;
        return cfg?.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
    } catch {
        return false;
    }
}
