import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import { resolveAccountBootstrapConfig, type AccountConfig } from "../config.js";
import { createLogger, wrapOpenClawLogger, type Logger } from "../observability/logger.js";
import { createIdempotencyStore } from "../store/idempotency.js";
import { InMemoryMessageStateStore, type MessageStateStore } from "../store/messageState.js";
import { HttpClawTeamCallbackClient, type ClawTeamCallbackClient } from "../callback/client.js";
import { createOpenClawRuntimeAdapter, type OpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import { configureOpenClawCliRuntime } from "../openclaw/openclawCli.js";

export function describeRuntimeShape(runtime: unknown) {
    if (!runtime || typeof runtime !== "object") {
        return { kind: typeof runtime };
    }

    const record = runtime as Record<string, unknown>;
    const topLevelKeys = Object.keys(record).sort();
    const interesting: Record<string, string[]> = {};

    for (const key of ["gateway", "agent", "channels", "message", "session", "events"]) {
        const value = record[key];
        if (value && typeof value === "object") {
            interesting[key] = Object.keys(value as Record<string, unknown>).sort();
        }
    }

    return {
        kind: "object",
        topLevelKeys,
        interesting,
    };
}

export type ClawTeamFactory = (acct: AccountConfig) => ClawTeamCallbackClient;

export interface PluginRuntimeServices {
    logger: Logger;
    openclaw: OpenClawRuntimeAdapter;
    idempotency: ReturnType<typeof createIdempotencyStore>;
    messageState: MessageStateStore;
    clawTeamFactory: ClawTeamFactory;
}

export function createPluginRuntimeServices(api: OpenClawPluginApi): PluginRuntimeServices {
    // 尽量复用宿主 logger，这样插件日志能和 Gateway 日志汇总到一起。
    const sink = wrapOpenClawLogger(api.logger);
    const logger = createLogger({ sink });

    configureOpenClawCliRuntime(api.runtime?.system);

    // runtime adapter 是和 OpenClaw 宿主交互的唯一隔离层。
    const openclaw = createOpenClawRuntimeAdapter(api);

    const bootstrap = resolveAccountBootstrapConfig(api.config);

    // 幂等存储和消息状态存储分别负责“防重复执行”和“便于排障追踪”。
    const idempotency = createIdempotencyStore({
        mode: bootstrap.idempotency.mode,
        redisUrl: bootstrap.idempotency.redisUrl,
        logger,
    });
    const messageState = new InMemoryMessageStateStore();

    const clawTeamFactory: ClawTeamFactory = (acct) =>
        new HttpClawTeamCallbackClient({
            baseUrl: acct.baseUrl,
            token: acct.outboundToken,
            timeoutMs: acct.retry.callbackTimeoutMs,
            logger,
        });

    return {
        logger,
        openclaw,
        idempotency,
        messageState,
        clawTeamFactory,
    };
}
