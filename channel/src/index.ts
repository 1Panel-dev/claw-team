/**
 * 这是插件主入口。
 * 它负责把配置解析、日志、幂等、状态存储、回调客户端和 HTTP 路由组装起来。
 *
 * 调用流程：
 * 1. 宿主加载插件默认导出的对象，并调用 register(api)。
 * 2. 这里创建 logger / idempotency / messageState / runtime adapter。
 * 3. 然后注册 channel 元信息和统一的 HTTP 路由前缀。
 * 4. 后续所有真实请求都会从 http/routes.ts 进入业务链路。
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import {
    CHANNEL_ID,
    channelAccountConfigSchema,
    listAccountIds,
    pluginConfigSchema,
    resolveAccount,
} from "./config.js";
import { createLogger, wrapOpenClawLogger } from "./observability/logger.js";
import { createIdempotencyStore } from "./store/idempotency.js";
import { InMemoryMessageStateStore } from "./store/messageState.js";
import { createClawTeamRoutes } from "./http/routes.js";
import { HttpClawTeamCallbackClient } from "./callback/client.js";
import { createOpenClawRuntimeAdapter } from "./openclaw/adapters.js";

function describeRuntimeShape(runtime: unknown) {
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

// 这台 OpenClaw 宿主导出的插件入口形状和 defineChannelPluginEntry 不一致，
// 所以这里直接导出一个和宿主内置 1panel 插件同形状的对象。
const plugin = {
    id: CHANNEL_ID,
    name: "Claw Team Channel",
    description: "Channel plugin bridging OpenClaw agents with Claw Team platform.",
    configSchema: pluginConfigSchema,
    register(api: OpenClawPluginApi) {
        // 尽量复用宿主 logger，这样插件日志能和 Gateway 日志汇总到一起。
        const sink = wrapOpenClawLogger(api.logger);
        const logger = createLogger({ sink });

        logger.info(describeRuntimeShape(api.runtime), "Plugin runtime shape detected");

        // runtime adapter 是和 OpenClaw 宿主交互的唯一隔离层。
        const openclaw = createOpenClawRuntimeAdapter(api);

        // 幂等存储和消息状态存储分别负责“防重复执行”和“便于排障追踪”。
        const idempotency = createIdempotencyStore({
            mode: resolveAccount(api.config).idempotency.mode,
            redisUrl: resolveAccount(api.config).idempotency.redisUrl,
            logger,
        });
        const messageState = new InMemoryMessageStateStore();

        const clawTeamFactory = (acct: any) =>
            new HttpClawTeamCallbackClient({
                baseUrl: acct.baseUrl,
                token: acct.outboundToken,
                timeoutMs: acct.retry.callbackTimeoutMs,
                logger,
            });

        api.registerChannel({
            plugin: {
                id: CHANNEL_ID,
                meta: {
                    id: CHANNEL_ID,
                    label: "Claw Team",
                },
                capabilities: {
                    chatTypes: ["direct", "group"],
                },
                configSchema: {
                    schema: channelAccountConfigSchema,
                },
                config: {
                    listAccountIds,
                    resolveAccount,
                },
                outbound: {
                    // 当前这版插件只处理“外部系统推送进来 -> Agent 执行 -> 回调回去”的链路。
                    deliveryMode: "direct",
                    async sendText() {
                        throw new Error("sendText not implemented for claw-team");
                    },
                },
            },
        });

        const handler = createClawTeamRoutes({
            channelId: CHANNEL_ID,
            getAccount: (accountId?: string) => resolveAccount(api.config, accountId),
            logger,
            idempotency,
            messageState,
            clawTeamFactory,
            openclaw,
        });

        // 所有入站 HTTP 接口都统一挂在 /claw-team/v1/ 前缀下。
        api.registerHttpRoute({
            path: "/claw-team/v1/",
            match: "prefix",
            auth: "plugin",
            handler,
        });
    },
};

export default plugin;
