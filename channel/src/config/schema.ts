import { z } from "zod";

/**
 * 这一层只定义标准配置结构。
 * 旧字段兼容、UI 扁平字段适配、环境变量兜底都不放在这里。
 */
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

        webchatMirror: z
            .object({
                includeIntermediateMessages: z.boolean().default(true),
            })
            .default({}),

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
