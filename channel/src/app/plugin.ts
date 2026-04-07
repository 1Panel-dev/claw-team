import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import {
    CHANNEL_ID,
    channelConfigSchema,
    channelConfigUiHints,
    listAccountIds,
    pluginConfigSchema,
    resolveAccount,
} from "../config.js";
import { createClawSwarmRoutes } from "../http/routes.js";
import { registerWebchatTranscriptMirror } from "../openclaw/webchatMirror.js";
import {
    looksLikeClawSwarmCsId,
    normalizeTargetCsId,
    resolveClawSwarmMessagingTarget,
    resolveClawSwarmTarget,
    sendClawSwarmText,
} from "../outbound/sendText.js";
import { createPluginRuntimeServices, describeRuntimeShape } from "./runtime.js";

function createMessagingConfig(params: {
    logger: ReturnType<typeof createPluginRuntimeServices>["logger"];
}) {
    const { logger } = params;

    return {
        // message 工具会先走 messaging.targetResolver，再进入 outbound.sendText。
        // 这里把合法 CS ID 识别成 direct target，才能让宿主认可这是合法目标。
        targetResolver: {
            looksLikeId: (raw: string, normalized?: string) => looksLikeClawSwarmCsId(raw, normalized),
            hint: "Use a CS ID like CSA-0009 or CSU-0001",
            resolveTarget: async ({ input, normalized }: { input: string; normalized: string }) => {
                const resolved = await resolveClawSwarmMessagingTarget({ input });
                if (!resolved) {
                    logger.warn(
                        {
                            rawTarget: input,
                            normalizedTarget: normalized,
                        },
                        "ClawSwarm messaging.resolveTarget could not resolve target",
                    );
                }
                return resolved;
            },
        },
        inferTargetChatType: ({ to }: { to: string }) => (looksLikeClawSwarmCsId(to) ? "direct" : undefined),
        parseExplicitTarget: ({ raw }: { raw: string }) => {
            try {
                return {
                    to: normalizeTargetCsId(raw),
                    chatType: "direct" as const,
                };
            } catch {
                logger.warn(
                    {
                        rawTarget: raw,
                    },
                    "ClawSwarm messaging.parseExplicitTarget rejected target",
                );
                return null;
            }
        },
        formatTargetDisplay: ({ target }: { target: string }) => target,
    };
}

function createOutboundConfig(params: {
    api: OpenClawPluginApi;
    logger: ReturnType<typeof createPluginRuntimeServices>["logger"];
}) {
    const { api, logger } = params;

    return {
        // 当前先支持最小的结构化 sendText。
        // OpenClaw 侧把目标 CS ID 放在 to，正文放一个 JSON 模板；
        // 插件内部会把它转成正式的 ClawSwarm 业务请求，而不是直接调用 callback 入口。
        deliveryMode: "direct" as const,
        resolveTarget({ to }: { to?: string }) {
            const result = resolveClawSwarmTarget(to);
            if (!result.ok) {
                const rawTarget = String(to ?? "");
                logger.warn(
                    {
                        rawTarget,
                        rawTargetLength: rawTarget.length,
                        rawTargetCodePoints: Array.from(rawTarget).map((char) => char.codePointAt(0)),
                        error: result.error.message,
                    },
                    "ClawSwarm resolveTarget rejected target",
                );
            }
            return result;
        },
        async sendText(ctx: Parameters<typeof sendClawSwarmText>[0]["ctx"]) {
            const account = resolveAccount(api.config, ctx.accountId ?? undefined);
            logger.info(
                {
                    rawTarget: String(ctx.to ?? ""),
                    accountId: ctx.accountId ?? "default",
                    textPreview: String(ctx.text ?? "").slice(0, 240),
                },
                "ClawSwarm sendText received outbound request",
            );
            return await sendClawSwarmText({
                ctx,
                account,
                logger,
            });
        },
    };
}

function createChannelPlugin(api: OpenClawPluginApi) {
    const services = createPluginRuntimeServices(api);
    const { logger, openclaw, idempotency, messageState, clawSwarmFactory } = services;

    logger.info(describeRuntimeShape(api.runtime), "Plugin runtime shape detected");

    // 这里把 OpenClaw Web UI 里直接产生的 assistant 回复追加镜像到调度中心。
    // 它只监听 transcript 更新，不会接管或覆盖 ClawSwarm 现有消息。
    registerWebchatTranscriptMirror(api, logger);

    const handler = createClawSwarmRoutes({
        channelId: CHANNEL_ID,
        getAccount: (accountId?: string) => resolveAccount(api.config, accountId),
        logger,
        idempotency,
        messageState,
        clawSwarmFactory,
        openclaw,
        loadHostConfig: () => api.runtime?.config?.loadConfig?.(),
    });

    api.registerChannel({
        plugin: {
            id: CHANNEL_ID,
            meta: {
                id: CHANNEL_ID,
                label: "ClawSwarm",
            },
            capabilities: {
                chatTypes: ["direct", "group"],
            },
            configSchema: { schema: channelConfigSchema, uiHints: channelConfigUiHints },
            config: {
                listAccountIds,
                resolveAccount,
            },
            messaging: createMessagingConfig({ logger }),
            outbound: createOutboundConfig({ api, logger }),
        },
    });

    // 所有入站 HTTP 接口都统一挂在 /clawswarm/v1/ 前缀下。
    api.registerHttpRoute({
        path: "/clawswarm/v1/",
        match: "prefix",
        auth: "plugin",
        handler,
    });
}

// 这台 OpenClaw 宿主导出的插件入口形状和 defineChannelPluginEntry 不一致，
const plugin = {
    id: CHANNEL_ID,
    name: "ClawSwarm Channel",
    description: "Channel plugin bridging OpenClaw agents with ClawSwarm platform.",
    configSchema: pluginConfigSchema,
    register(api: OpenClawPluginApi) {
        createChannelPlugin(api);
    },
};

export default plugin;
