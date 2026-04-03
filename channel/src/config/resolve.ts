import { listRealOpenClawAgents } from "../openclaw/manageAgents.js";
import { z } from "zod";
import { AccountConfigSchema } from "./schema.js";
import { normalizeAccountConfigInput } from "./legacy.js";
import type { AccountConfig, AgentDirectoryEntry, GatewayRuntimeConfig, ResolvedAccount } from "./types.js";

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
export async function discoverAgents(acct: AccountConfig): Promise<AgentDirectoryEntry[]> {
    try {
        const agents = await listRealOpenClawAgents();
        if (agents.length > 0) {
            return agents;
        }
    } catch {
        return describeAgents(acct);
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

const AccountRuntimeBootstrapSchema = z.object({
    idempotency: AccountConfigSchema.shape.idempotency.default({}),
});

// 注册阶段只允许解析真正需要的最小配置，避免插件安装时因为业务字段缺失而失败。
export function resolveAccountBootstrapConfig(cfg: any, accountId?: string): {
    idempotency: AccountConfig["idempotency"];
} {
    const sec = cfg?.channels?.["claw-team"] ?? {};
    const raw = sec?.accounts?.[accountId ?? "default"] ?? {};
    return AccountRuntimeBootstrapSchema.parse(normalizeAccountConfigInput(raw));
}
