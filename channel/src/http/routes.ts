import type { Logger } from "../observability/logger.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { AccountConfig } from "../config.js";
import type { MessageStateStore } from "../store/messageState.js";
import type { ClawSwarmCallbackClient } from "../callback/client.js";
import type { OpenClawRuntimeAdapter } from "../openclaw/adapters.js";
import { handleAdminAgentRoutes } from "./adminAgents.js";
import { handleCatalogRoutes } from "./catalog.js";
import { handleInboundRoute } from "./inbound.js";

export function createClawSwarmRoutes(params: {
    channelId: string;
    getAccount: (accountId?: string) => AccountConfig & { accountId: string };
    logger: Logger;
    idempotency: IdempotencyStore;
    messageState: MessageStateStore;
    clawSwarmFactory: (acct: AccountConfig) => ClawSwarmCallbackClient;
    openclaw: OpenClawRuntimeAdapter;
    loadHostConfig?: () => unknown;
}) {
    const { channelId, getAccount, logger, idempotency, messageState, clawSwarmFactory, openclaw, loadHostConfig } = params;

    // 返回给 registerHttpRoute 的 handler。
    return async function handler(req: any, res: any): Promise<boolean> {
        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;

        if (
            await handleCatalogRoutes({
                pathname,
                method: req.method,
                res,
                channelId,
                getAccount,
            })
        ) {
            return true;
        }

        if (
            await handleAdminAgentRoutes({
                pathname,
                method: req.method,
                req,
                res,
                getAccount,
                idempotency,
                loadHostConfig,
            })
        ) {
            return true;
        }

        if (
            await handleInboundRoute({
                pathname,
                method: req.method,
                req,
                res,
                channelId,
                getAccount,
                logger,
                idempotency,
                messageState,
                clawSwarmFactory,
                openclaw,
            })
        ) {
            return true;
        }

        // 不是当前插件关心的路径，返回 false 让宿主继续匹配其它 handler。
        return false;
    };
}
