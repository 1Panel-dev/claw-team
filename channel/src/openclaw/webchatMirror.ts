import type { Logger } from "../observability/logger.js";
/**
 * Web UI 镜像现在改由 internal hook 负责。
 * 这里保留一个空注册函数，避免插件入口和导入关系继续改动。
 */
export function registerWebchatTranscriptMirror(_api: unknown, logger: Logger): void {
    logger.info({}, "Webchat transcript mirror is delegated to the internal hook");
}
