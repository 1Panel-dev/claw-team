// 统一维护 channel id，避免路由、sessionKey、配置路径出现硬编码分叉。
export const CHANNEL_ID = "clawswarm" as const;
import { AccountConfigSchema } from "./config/schema.js";
import { normalizeAccountConfigInput } from "./config/legacy.js";

export {
    AccountConfigSchema,
    GatewayConfigSchema,
} from "./config/schema.js";
export {
    channelAccountConfigSchema,
    channelConfigSchema,
    channelConfigUiHints,
    pluginConfigSchema,
} from "./config/manifest.js";
export {
    describeAgents,
    discoverAgents,
    resolveAccountBootstrapConfig,
    resolveAliasMap,
    resolveAllowedAgents,
    resolveGatewayRuntimeConfig,
} from "./config/resolve.js";
export type {
    AccountConfig,
    AgentDirectoryEntry,
    GatewayRuntimeConfig,
    RawAccountConfig,
    ResolvedAccount,
} from "./config/types.js";

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
export function resolveAccount(cfg: any, accountId?: string) {
    const sec = getChannelSection(cfg);
    const raw = sec?.accounts?.[accountId ?? "default"] ?? {};
    const parsed = AccountConfigSchema.parse(normalizeAccountConfigInput(raw));
    return { ...parsed, accountId: accountId ?? "default" };
}
