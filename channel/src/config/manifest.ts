const channelAccountProperties = {
    enabled: { type: "boolean" },
    baseUrl: { type: "string" },
    outboundToken: { type: "string" },
    inboundSigningSecret: { type: "string" },
    gateway: {
        type: "object",
        additionalProperties: false,
        properties: {
            baseUrl: { type: "string" },
            token: { type: "string" },
            transport: { type: "string" },
            model: { type: "string" },
            stream: { type: "boolean" },
            allowInsecureTls: { type: "boolean" },
        },
    },
    agentDirectory: {
        type: "object",
        additionalProperties: false,
        properties: {
            allowedAgentIds: {
                type: "array",
                items: { type: "string" },
            },
            aliases: {
                type: "object",
                additionalProperties: { type: "string" },
            },
        },
    },
} as const;

// 单账号结构单独保留，供运行时解析和测试复用。
export const channelAccountConfigSchema = {
    type: "object",
    additionalProperties: false,
    properties: channelAccountProperties,
} as const;

// 这是 OpenClaw Channel 配置页真正需要的根 schema：它会被挂在 channels.<channelId> 下。
export const channelConfigSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        enabled: {
            type: "boolean",
        },
        accounts: {
            type: "object",
            additionalProperties: channelAccountConfigSchema,
        },
    },
} as const;

// 顶层 manifest 也保持同构，避免再出现多套路径结构。
export const pluginConfigSchema = channelConfigSchema;

export const channelConfigUiHints = {
    "accounts.*.outboundToken": { sensitive: true, label: "Outbound Token" },
    "accounts.*.inboundSigningSecret": { sensitive: true, label: "Inbound Signing Secret" },
    "accounts.*.gateway.token": { sensitive: true, label: "Gateway Token" },
} as const;
