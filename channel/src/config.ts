/**
 * 这个文件负责定义和解析插件配置。
 * 所有和账号、限流、幂等、签名相关的配置，都应该优先在这里收口。
 */
import { z } from "zod";

// 统一维护 channel id，避免路由、sessionKey、配置路径出现硬编码分叉。
export const CHANNEL_ID = "claw-team" as const;

export const GatewayConfigSchema = z
    .object({
        // 显式指定 Gateway 地址；不配时回退到环境变量或默认值。
        baseUrl: z.string().min(1).optional(),
        // Gateway 如果启用了 Bearer Token，可直接配在这里。
        token: z.string().min(1).optional(),
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
    model: string;
    stream: boolean;
    allowInsecureTls: boolean;
};

// 这份 schema 提供给 OpenClaw 宿主做运行时配置声明，尽量与 openclaw.plugin.json 保持一致。
export const pluginConfigSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        channels: {
            type: "object",
            additionalProperties: true,
            properties: {
                [CHANNEL_ID]: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        accounts: {
                            type: "object",
                            default: {},
                            additionalProperties: {
                                type: "object",
                                additionalProperties: false,
                                required: ["baseUrl", "outboundToken", "inboundSigningSecret"],
                                properties: {
                                    enabled: { type: "boolean", default: true },
                                    baseUrl: { type: "string", minLength: 1 },
                                    outboundToken: { type: "string", minLength: 8 },
                                    inboundSigningSecret: { type: "string", minLength: 16 },
                                    gateway: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            baseUrl: { type: "string", minLength: 1 },
                                            token: { type: "string", minLength: 1 },
                                            model: { type: "string", minLength: 1, default: "openclaw" },
                                            stream: { type: "boolean", default: true },
                                            allowInsecureTls: { type: "boolean", default: false },
                                        },
                                    },
                                    agentDirectory: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            allowedAgentIds: {
                                                type: "array",
                                                items: { type: "string", minLength: 1 },
                                            },
                                            aliases: {
                                                type: "object",
                                                additionalProperties: { type: "string", minLength: 1 },
                                            },
                                        },
                                    },
                                    limits: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            maxBroadcastAgents: {
                                                type: "integer",
                                                minimum: 1,
                                                maximum: 500,
                                                default: 50,
                                            },
                                            maxInFlightRuns: {
                                                type: "integer",
                                                minimum: 1,
                                                maximum: 500,
                                                default: 20,
                                            },
                                            perAgentConcurrency: {
                                                type: "integer",
                                                minimum: 1,
                                                maximum: 50,
                                                default: 2,
                                            },
                                            maxBodyBytes: {
                                                type: "integer",
                                                minimum: 1024,
                                                maximum: 2097152,
                                                default: 1048576,
                                            },
                                            timeSkewMs: {
                                                type: "integer",
                                                minimum: 0,
                                                maximum: 3600000,
                                                default: 300000,
                                            },
                                            nonceTtlSeconds: {
                                                type: "integer",
                                                minimum: 30,
                                                maximum: 3600,
                                                default: 600,
                                            },
                                        },
                                    },
                                    idempotency: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            mode: {
                                                type: "string",
                                                enum: ["memory", "redis"],
                                                default: "memory",
                                            },
                                            ttlSeconds: {
                                                type: "integer",
                                                minimum: 10,
                                                maximum: 604800,
                                                default: 86400,
                                            },
                                            redisUrl: { type: "string", minLength: 1 },
                                        },
                                    },
                                    retry: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            maxAttempts: {
                                                type: "integer",
                                                minimum: 0,
                                                maximum: 50,
                                                default: 10,
                                            },
                                            baseDelayMs: {
                                                type: "integer",
                                                minimum: 50,
                                                maximum: 60000,
                                                default: 500,
                                            },
                                            maxDelayMs: {
                                                type: "integer",
                                                minimum: 100,
                                                maximum: 600000,
                                                default: 60000,
                                            },
                                            jitterRatio: {
                                                type: "number",
                                                minimum: 0,
                                                maximum: 1,
                                                default: 0.2,
                                            },
                                            deadLetterFile: {
                                                type: "string",
                                                minLength: 1,
                                                default: "./claw-team.dlq.jsonl",
                                            },
                                            callbackTimeoutMs: {
                                                type: "integer",
                                                minimum: 100,
                                                maximum: 60000,
                                                default: 8000,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
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
    const parsed = AccountConfigSchema.parse(raw);
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

// Gateway 连接参数采用“账号配置优先，环境变量兜底”的策略。
export function resolveGatewayRuntimeConfig(acct: AccountConfig): GatewayRuntimeConfig {
    return {
        baseUrl: acct.gateway.baseUrl ?? process.env.OPENCLAW_GATEWAY_HTTP_URL ?? "http://127.0.0.1:18789",
        token: acct.gateway.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
        model: acct.gateway.model ?? process.env.OPENCLAW_GATEWAY_MODEL ?? "openclaw",
        stream: acct.gateway.stream ?? process.env.OPENCLAW_GATEWAY_STREAM !== "0",
        allowInsecureTls:
            acct.gateway.allowInsecureTls ?? process.env.OPENCLAW_GATEWAY_INSECURE_TLS === "1",
    };
}
