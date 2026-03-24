/**
 * 这个文件负责定义和解析插件配置。
 * 所有和账号、限流、幂等、签名相关的配置，都应该优先在这里收口。
 */
import { z } from "zod";

import { listRealOpenClawAgents } from "./openclaw/manageAgents.js";

// 统一维护 channel id，避免路由、sessionKey、配置路径出现硬编码分叉。
export const CHANNEL_ID = "claw-team" as const;

export const GatewayConfigSchema = z
    .object({
        // 显式指定 Gateway 地址；不配时回退到环境变量或默认值。
        baseUrl: z.string().min(1).optional(),
        // Gateway 如果启用了 Bearer Token，可直接配在这里。
        token: z.string().min(1).optional(),
        // 运行时传输层；默认 auto，按宿主 chatCompletions 开关在 HTTP 和 plugin_runtime 之间选择。
        transport: z
            .enum(["auto", "chat_completions", "plugin_runtime"])
            .optional(),
        // 以下字段不在 schema 层提前打默认值，方便后面统一走“配置优先，环境变量兜底”的解析逻辑。
        model: z.string().min(1).optional(),
        stream: z.boolean().optional(),
        allowInsecureTls: z.boolean().optional(),
    })
    .default({});

// AccountConfigSchema 定义单个账号的完整配置形状，并负责默认值填充。
export const AccountConfigSchema = z
    .object({
        // 允许按账号粒度禁用接入，而不是整个插件一起下线。
        enabled: z.boolean().default(true),

        // Claw Team 后端回调地址与鉴权信息。
        baseUrl: z.string().min(1),
        outboundToken: z.string().min(8),
        inboundSigningSecret: z.string().min(16),

        // 这是插件调用 OpenClaw Gateway 官方 HTTP 端点时使用的参数。
        gateway: GatewayConfigSchema,

        agentDirectory: z
            .object({
                // allowedAgentIds 用来限定默认可路由的 Agent 范围。
                allowedAgentIds: z.array(z.string().min(1)).optional(),
                // aliases 让 "@qa" 这种 mention token 可以映射到真实 agent id。
                aliases: z.record(z.string().min(1)).optional(),
            })
            .optional(),

        limits: z
            .object({
                // 广播时最多打到多少个 Agent，防止配置错误导致雪崩。
                maxBroadcastAgents: z.number().int().min(1).max(500).default(50),
                // 整个账号同时允许多少个 run 并发。
                maxInFlightRuns: z.number().int().min(1).max(500).default(20),
                // 单个 Agent 的并发上限，避免某个 Agent 被压垮。
                perAgentConcurrency: z.number().int().min(1).max(50).default(2),
                // 限制入站 body 大小，避免恶意请求或超大 payload。
                maxBodyBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(1 * 1024 * 1024),
                // 签名校验允许的时间偏移。
                timeSkewMs: z.number().int().min(0).max(60 * 60 * 1000).default(5 * 60 * 1000),
                // nonce 的有效时间窗口，用于防重放。
                nonceTtlSeconds: z.number().int().min(30).max(3600).default(10 * 60),
            })
            .default({}),

        idempotency: z
            .object({
                // 先支持内存和 Redis 两种去重存储，便于本地开发和生产落地。
                mode: z.enum(["memory", "redis"]).default("memory"),
                ttlSeconds: z.number().int().min(10).max(7 * 24 * 3600).default(24 * 3600),
                redisUrl: z.string().min(1).optional(),
            })
            .default({}),

        retry: z
            .object({
                // 回调失败后的退避重试策略。
                maxAttempts: z.number().int().min(0).max(50).default(10),
                baseDelayMs: z.number().int().min(50).max(60 * 1000).default(500),
                maxDelayMs: z.number().int().min(100).max(10 * 60 * 1000).default(60 * 1000),
                jitterRatio: z.number().min(0).max(1).default(0.2),
                deadLetterFile: z.string().min(1).default("./claw-team.dlq.jsonl"),
                callbackTimeoutMs: z.number().int().min(100).max(60 * 1000).default(8000),
            })
            .default({}),
    })
    .strict();

export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type ResolvedAccount = AccountConfig & { accountId: string };
export type AgentDirectoryEntry = {
    id: string;
    name: string;
    openclawAgentRef: string;
};
export type GatewayRuntimeConfig = {
    baseUrl: string;
    token?: string;
    transport: "auto" | "chat_completions" | "plugin_runtime";
    model: string;
    stream: boolean;
    allowInsecureTls: boolean;
};

type RawAccountConfig = Record<string, unknown>;

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return out.length > 0 ? out : undefined;
}

function parseAliasesJson(value: unknown): Record<string, string> | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        return Object.fromEntries(
            Object.entries(parsed).filter(
                (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
            ),
        );
    } catch {
        return undefined;
    }
}

// normalizeAccountConfigInput 让代码同时兼容两种配置写法：
// 1. 旧版嵌套结构：gateway / agentDirectory / limits / idempotency / retry
// 2. UI 友好的扁平结构：gatewayBaseUrl / maxBroadcastAgents / retryMaxAttempts ...
// 3. 更保守的 UI 兼容结构：allowedAgentIdsCsv / retryJitterRatioPercent
// OpenClaw 当前控制台对 schema 支持范围比较有限，因此数组和 number 往往要退化成字符串或整数。
function normalizeAccountConfigInput(raw: RawAccountConfig): RawAccountConfig {
    const gateway = (raw.gateway as RawAccountConfig | undefined) ?? {};
    const agentDirectory = (raw.agentDirectory as RawAccountConfig | undefined) ?? {};
    const limits = (raw.limits as RawAccountConfig | undefined) ?? {};
    const idempotency = (raw.idempotency as RawAccountConfig | undefined) ?? {};
    const retry = (raw.retry as RawAccountConfig | undefined) ?? {};

    return {
        ...raw,
        gateway: {
            ...gateway,
            baseUrl: asString(gateway.baseUrl) ?? asString(raw.gatewayBaseUrl),
            token: asString(gateway.token) ?? asString(raw.gatewayToken),
            transport: asString(gateway.transport) ?? asString(raw.gatewayTransport),
            model: asString(gateway.model) ?? asString(raw.gatewayModel),
            stream: asBoolean(gateway.stream) ?? asBoolean(raw.gatewayStream),
            allowInsecureTls:
                asBoolean(gateway.allowInsecureTls) ?? asBoolean(raw.gatewayAllowInsecureTls),
        },
        agentDirectory: {
            ...agentDirectory,
            allowedAgentIds:
                asStringArray(agentDirectory.allowedAgentIds) ??
                asStringArray(raw.allowedAgentIds) ??
                (typeof raw.allowedAgentIdsCsv === "string"
                    ? raw.allowedAgentIdsCsv
                          .split(",")
                          .map((item) => item.trim())
                          .filter((item) => item.length > 0)
                    : undefined),
            aliases:
                ((agentDirectory.aliases as Record<string, string> | undefined) ?? parseAliasesJson(raw.aliasesJson)),
        },
        limits: {
            ...limits,
            maxBroadcastAgents: asNumber(limits.maxBroadcastAgents) ?? asNumber(raw.maxBroadcastAgents),
            maxInFlightRuns: asNumber(limits.maxInFlightRuns) ?? asNumber(raw.maxInFlightRuns),
            perAgentConcurrency: asNumber(limits.perAgentConcurrency) ?? asNumber(raw.perAgentConcurrency),
            maxBodyBytes: asNumber(limits.maxBodyBytes) ?? asNumber(raw.maxBodyBytes),
            timeSkewMs: asNumber(limits.timeSkewMs) ?? asNumber(raw.timeSkewMs),
            nonceTtlSeconds: asNumber(limits.nonceTtlSeconds) ?? asNumber(raw.nonceTtlSeconds),
        },
        idempotency: {
            ...idempotency,
            mode: asString(idempotency.mode) ?? asString(raw.idempotencyMode),
            ttlSeconds: asNumber(idempotency.ttlSeconds) ?? asNumber(raw.idempotencyTtlSeconds),
            redisUrl: asString(idempotency.redisUrl) ?? asString(raw.redisUrl),
        },
        retry: {
            ...retry,
            maxAttempts: asNumber(retry.maxAttempts) ?? asNumber(raw.retryMaxAttempts),
            baseDelayMs: asNumber(retry.baseDelayMs) ?? asNumber(raw.retryBaseDelayMs),
            maxDelayMs: asNumber(retry.maxDelayMs) ?? asNumber(raw.retryMaxDelayMs),
            jitterRatio:
                asNumber(retry.jitterRatio) ??
                asNumber(raw.retryJitterRatio) ??
                (typeof raw.retryJitterRatioPercent === "number"
                    ? raw.retryJitterRatioPercent / 100
                    : undefined),
            deadLetterFile: asString(retry.deadLetterFile) ?? asString(raw.retryDeadLetterFile),
            callbackTimeoutMs:
                asNumber(retry.callbackTimeoutMs) ?? asNumber(raw.retryCallbackTimeoutMs),
        },
    };
}

// 这份 schema 提供给 OpenClaw 宿主做运行时配置声明。
// 这里尽量贴近 1panel 插件那种“极简、宽松”的 schema 风格，
// 优先保证 Control UI 能渲染；更严格的校验仍然交给 Zod 解析阶段处理。
export const pluginConfigSchema = {
    type: "object",
    properties: {
        enabled: {
            type: "boolean",
        },
        accounts: {
            type: "object",
            additionalProperties: {
                type: "object",
                properties: {
                    enabled: { type: "boolean" },
                    baseUrl: { type: "string" },
                    outboundToken: { type: "string" },
                    inboundSigningSecret: { type: "string" },
                    gatewayBaseUrl: { type: "string" },
                    gatewayToken: { type: "string" },
                    gatewayTransport: { type: "string" },
                    gatewayModel: { type: "string" },
                },
            },
        },
    },
} as const;

// 这是注册给 registerChannel({ plugin }) 的“账号级”表单 schema。
// OpenClaw 控制台在 Channel 配置页里，实际更像是读取这里，而不是外层 manifest 的总配置 schema。
// 因此它必须和 1panel 的形状接近：{ configSchema: { schema: ... } }。
export const channelAccountConfigSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        enabled: {
            type: "boolean",
            description: "选填：是否启用这个账号",
        },
        baseUrl: {
            type: "string",
            description: "必填：Claw Team 调度中心回调地址",
        },
        outboundToken: {
            type: "string",
            description: "必填：channel 回调 Claw Team 调度中心时使用的 Bearer Token",
        },
        inboundSigningSecret: {
            type: "string",
            description: "必填：Claw Team 调度中心调用 channel 时使用的签名密钥",
        },
        gatewayBaseUrl: {
            type: "string",
            description: "建议填写：OpenClaw Gateway 地址，不填时回退到默认值或环境变量",
        },
        gatewayToken: {
            type: "string",
            description: "建议填写：调用 OpenClaw Gateway 的 Bearer Token",
        },
        gatewayModel: {
            type: "string",
            description: "选填：调用 Gateway 时使用的模型名，默认 openclaw",
        },
        gatewayTransport: {
            type: "string",
            description: "选填：Gateway 传输层，默认 auto；可显式指定 chat_completions / plugin_runtime",
        },
    },
} as const;

// OpenClaw 配置里渠道插件通常挂在 channels.<CHANNEL_ID> 下。
function getChannelSection(cfg: any): any {
    return cfg?.channels?.[CHANNEL_ID] ?? {};
}

// 返回当前渠道下配置过的账号 id 列表。
export function listAccountIds(cfg: any): string[] {
    const sec = getChannelSection(cfg);
    const accounts = sec?.accounts ?? {};
    return Object.keys(accounts);
}

// 解析账号配置，并由 Zod 负责默认值和结构校验。
export function resolveAccount(cfg: any, accountId?: string): ResolvedAccount {
    const sec = getChannelSection(cfg);
    const raw = sec?.accounts?.[accountId ?? "default"] ?? {};
    const parsed = AccountConfigSchema.parse(normalizeAccountConfigInput(raw));
    return { ...parsed, accountId: accountId ?? "default" };
}

// 将配置中的 allowedAgentIds 去重，供广播默认路由使用。
export function resolveAllowedAgents(acct: AccountConfig): string[] {
    const ids = acct.agentDirectory?.allowedAgentIds ?? [];
    return Array.from(new Set(ids));
}

// mention token 到真实 agent id 的别名映射。
export function resolveAliasMap(acct: AccountConfig): Record<string, string> {
    return acct.agentDirectory?.aliases ?? {};
}

// 生成一个适合对外返回的 Agent 描述结构。
export function describeAgents(acct: AccountConfig): AgentDirectoryEntry[] {
    return resolveAllowedAgents(acct).map((id) => ({
        id,
        name: id,
        openclawAgentRef: id,
    }));
}

// 优先尝试从 OpenClaw 宿主真实发现 Agent。
// 如果 CLI 不存在、执行失败或输出无法解析，再回退到静态配置的 allowedAgentIds。
export function discoverAgents(acct: AccountConfig): AgentDirectoryEntry[] {
    try {
        const agents = listRealOpenClawAgents();
        if (agents.length > 0) {
            const allowed = resolveAllowedAgents(acct);
            if (allowed.length > 0) {
                const allowedSet = new Set(allowed);
                const filtered = agents.filter((agent) => allowedSet.has(agent.id));
                if (filtered.length > 0) {
                    return filtered;
                }
            }

            return agents;
        }
    } catch {
        // noop: fall back to static config
    }

    return describeAgents(acct);
}

// Gateway 连接参数采用“账号配置优先，环境变量兜底”的策略。
export function resolveGatewayRuntimeConfig(acct: AccountConfig): GatewayRuntimeConfig {
    return {
        baseUrl: acct.gateway.baseUrl ?? process.env.OPENCLAW_GATEWAY_HTTP_URL ?? "http://127.0.0.1:18789",
        token: acct.gateway.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
        transport:
            acct.gateway.transport ??
            (process.env.OPENCLAW_GATEWAY_TRANSPORT === "auto"
                ? "auto"
                : process.env.OPENCLAW_GATEWAY_TRANSPORT === "plugin_runtime"
                    ? "plugin_runtime"
                  : "auto"),
        model: acct.gateway.model ?? process.env.OPENCLAW_GATEWAY_MODEL ?? "openclaw",
        stream: acct.gateway.stream ?? process.env.OPENCLAW_GATEWAY_STREAM !== "0",
        allowInsecureTls:
            acct.gateway.allowInsecureTls ?? process.env.OPENCLAW_GATEWAY_INSECURE_TLS === "1",
    };
}
