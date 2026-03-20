/**
 * 这是插件主入口。
 * 它负责把配置解析、日志、幂等、状态存储、回调客户端和 HTTP 路由组装起来。
 *
 * 调用流程：
 * 1. 宿主加载插件并调用 registerFull。
 * 2. 这里创建 logger / idempotency / messageState / runtime adapter。
 * 3. 然后注册 channel 元信息和统一的 HTTP 路由前缀。
 * 4. 后续所有真实请求都会从 http/routes.ts 进入业务链路。
 */
import {
    defineChannelPluginEntry,
} from "openclaw/plugin-sdk/core";

import { CHANNEL_ID, listAccountIds, pluginConfigSchema, resolveAccount } from "./config.js";
import { createLogger, wrapOpenClawLogger } from "./observability/logger.js";
import { createIdempotencyStore } from "./store/idempotency.js";
import { InMemoryMessageStateStore } from "./store/messageState.js";
import { createClawTeamRoutes } from "./http/routes.js";
import { HttpClawTeamCallbackClient } from "./callback/client.js";
import { createOpenClawRuntimeAdapter } from "./openclaw/adapters.js";

// 某些宿主会在 setRuntime 阶段先下发 runtime，再进入 registerFull。
let runtime: any = null;

export default defineChannelPluginEntry({
    id: CHANNEL_ID,
    name: "Claw Team Channel",
    description: "Channel plugin bridging OpenClaw agents with Claw Team platform.",
    configSchema: pluginConfigSchema,

    setRuntime(rt) {
        runtime = rt;
    },

    registerFull(api) {
        // 尽量复用宿主 logger，这样插件日志能和 Gateway 日志汇总到一起。
        const sink = wrapOpenClawLogger(api.logger);
        const logger = createLogger({ sink });

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
});
