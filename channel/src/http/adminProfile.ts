import type { AccountConfig } from "../config.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import type { OpenClawAgentWorkspaceConfig } from "../openclaw/manageAgents.js";
import { getRealOpenClawAgentProfile, updateRealOpenClawAgent } from "../openclaw/manageAgents.js";
import { sendJson } from "./common.js";
import { AgentAdminUpdateSchema } from "./adminSchemas.js";
import { readVerifiedJsonBody } from "./adminBody.js";

export async function handleAdminAgentProfileRoute(params: {
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

    if (!pathname.startsWith("/clawswarm/v1/admin/agents/") || !pathname.endsWith("/profile")) {
        return false;
    }

    const segments = pathname.split("/").filter(Boolean);
    const rawAgentKey = segments.at(-2);
    const agentKey = rawAgentKey ? decodeURIComponent(rawAgentKey) : "";
    if (!agentKey) {
        sendJson(res, 404, { error: "agent_not_found" });
        return true;
    }

    if (method === "GET") {
        try {
            const profile = getRealOpenClawAgentProfile({
                agentId: agentKey,
                cfg: hostConfig,
            });
            sendJson(res, 200, profile);
        } catch (error) {
            sendJson(res, 400, { error: "agent_profile_read_failed", detail: String(error) });
        }
        return true;
    }

    if (method !== "PUT") {
        return false;
    }

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

    const parsed = AgentAdminUpdateSchema.safeParse(body.json);
    if (!parsed.success) {
        sendJson(res, 400, { error: "invalid_payload", detail: parsed.error.issues });
        return true;
    }

    try {
        const agent = await updateRealOpenClawAgent({
            agentId: agentKey,
            displayName: parsed.data.displayName,
            profileFiles: {
                identityMd: parsed.data.identityMd,
                soulMd: parsed.data.soulMd,
                userMd: parsed.data.userMd,
                memoryMd: parsed.data.memoryMd,
            },
            cfg: hostConfig,
        });
        sendJson(res, 200, agent);
    } catch (error) {
        sendJson(res, 400, { error: "agent_update_failed", detail: String(error) });
    }
    return true;
}
