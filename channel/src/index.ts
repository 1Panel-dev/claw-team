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
import { registerWebchatTranscriptMirror } from "./openclaw/webchatMirror.js";
import {
    looksLikeClawTeamCtId,
    normalizeTargetCtId,
    resolveClawTeamMessagingTarget,
    resolveClawTeamTarget,
    sendClawTeamText,
} from "./outbound/sendText.js";

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

        // 这里把 OpenClaw Web UI 里直接产生的 assistant 回复追加镜像到调度中心。
        // 它只监听 transcript 更新，不会接管或覆盖 Claw Team 现有消息。
        registerWebchatTranscriptMirror(api, logger);

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
                messaging: {
                    // message 工具会先走 messaging.targetResolver，再进入 outbound.sendText。
                    // 这里把合法 CT ID 识别成 direct target，才能让宿主认可这是合法目标。
                    targetResolver: {
                        looksLikeId: (raw: string, normalized?: string) => looksLikeClawTeamCtId(raw, normalized),
                        hint: "Use a CT ID like CTA-0009 or CTU-0001",
                        resolveTarget: async ({ input, normalized }: { input: string; normalized: string }) => {
                            const resolved = await resolveClawTeamMessagingTarget({ input });
                            if (!resolved) {
                                logger.warn(
                                    {
                                        rawTarget: input,
                                        normalizedTarget: normalized,
                                    },
                                    "Claw Team messaging.resolveTarget could not resolve target",
                                );
                            }
                            return resolved;
                        },
                    },
                    inferTargetChatType: ({ to }: { to: string }) =>
                        looksLikeClawTeamCtId(to) ? "direct" : undefined,
                    parseExplicitTarget: ({ raw }: { raw: string }) => {
                        try {
                            return {
                                to: normalizeTargetCtId(raw),
                                chatType: "direct" as const,
                            };
                        } catch {
                            logger.warn(
                                {
                                    rawTarget: raw,
                                },
                                "Claw Team messaging.parseExplicitTarget rejected target",
                            );
                            return null;
                        }
                    },
                    formatTargetDisplay: ({ target }: { target: string }) => target,
                },
                outbound: {
                    // 当前先支持最小的结构化 sendText。
                    // OpenClaw 侧把目标 CT ID 放在 to，正文放一个 JSON 模板；
                    // 插件内部会把它转成正式的 Claw Team 业务请求，而不是直接调用 callback 入口。
                    deliveryMode: "direct",
                    resolveTarget({ to }) {
                        const result = resolveClawTeamTarget(to);
                        if (!result.ok) {
                            const rawTarget = String(to ?? "");
                            logger.warn(
                                {
                                    rawTarget,
                                    rawTargetLength: rawTarget.length,
                                    rawTargetCodePoints: Array.from(rawTarget).map((char) => char.codePointAt(0)),
                                    error: result.error.message,
                                },
                                "Claw Team resolveTarget rejected target",
                            );
                        }
                        return result;
                    },
                    async sendText(ctx) {
                        const account = resolveAccount(api.config, ctx.accountId);
                        logger.info(
                            {
                                rawTarget: String(ctx.to ?? ""),
                                accountId: ctx.accountId ?? "default",
                                textPreview: String(ctx.text ?? "").slice(0, 240),
                            },
                            "Claw Team sendText received outbound request",
                        );
                        return await sendClawTeamText({
                            ctx,
                            account,
                            logger,
                        });
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
            loadHostConfig: () => api.runtime?.config?.loadConfig?.(),
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
