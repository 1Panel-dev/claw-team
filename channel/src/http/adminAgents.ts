import type { AccountConfig } from "../config.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { OpenClawAgentWorkspaceConfig } from "../openclaw/manageAgents.js";
import { createRealOpenClawAgent } from "../openclaw/manageAgents.js";
import { sendJson } from "./common.js";
import { AgentAdminCreateSchema } from "./adminSchemas.js";
import { readVerifiedJsonBody } from "./adminBody.js";
import { handleAdminAgentProfileRoute } from "./adminProfile.js";

export async function handleAdminAgentRoutes(params: {
    pathname: string;
    method: string;
    req: any;
    res: any;
    getAccount: (accountId?: string) => AccountConfig & { accountId: string };
    idempotency: IdempotencyStore;
    loadHostConfig?: () => unknown;
}): Promise<boolean> {
    const { pathname, method, req, res, getAccount, idempotency, loadHostConfig } = params;
    const hostConfig = loadHostConfig?.() as OpenClawAgentWorkspaceConfig | undefined;

    if (
        await handleAdminAgentProfileRoute({
            pathname,
            method,
            req,
            res,
            getAccount,
            idempotency,
            loadHostConfig,
        })
    ) {
        return true;
    }

    if (pathname === "/clawswarm/v1/admin/agents" && method === "POST") {
        const acct = getAccount(undefined);
        const body = await readVerifiedJsonBody({
            req,
            res,
            pathname,
            accountConfig: acct,
            idempotency,
        });
        if (!body.ok) {
            return true;
        }

        const parsed = AgentAdminCreateSchema.safeParse(body.json);
        if (!parsed.success) {
            sendJson(res, 400, { error: "invalid_payload", detail: parsed.error.issues });
            return true;
        }

        try {
            const agent = await createRealOpenClawAgent({
                agentId: parsed.data.agentKey,
                displayName: parsed.data.displayName,
                profileFiles: {
                    identityMd: parsed.data.identityMd,
                    soulMd: parsed.data.soulMd,
                    userMd: parsed.data.userMd,
                    memoryMd: parsed.data.memoryMd,
                },
                cfg: hostConfig,
            });
            sendJson(res, 201, agent);
        } catch (error) {
            sendJson(res, 400, { error: "agent_create_failed", detail: String(error) });
        }
        return true;
    }

    return false;
}
