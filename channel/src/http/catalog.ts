import type { AccountConfig } from "../config.js";
import type { GroupDescriptor } from "../types.js";
import { discoverAgents } from "../config.js";
import { sendJson } from "./common.js";

export async function handleCatalogRoutes(params: {
    pathname: string;
    method: string;
    res: any;
    channelId: string;
    getAccount: (accountId?: string) => AccountConfig & { accountId: string };
}): Promise<boolean> {
    const { pathname, method, res, channelId, getAccount } = params;

    // 健康检查接口，主要给运维和联调使用。
    if (pathname === "/claw-team/v1/health" && method === "GET") {
        sendJson(res, 200, { ok: true, pluginId: channelId, version: "0.1.0", channelId });
        return true;
    }

    // 返回当前账号允许使用的 Agent 列表，便于前后端联调。
    if (pathname === "/claw-team/v1/agents" && method === "GET") {
        const acct = getAccount(undefined);
        sendJson(res, 200, await discoverAgents(acct));
        return true;
    }

    // 目前群组还是轻量调试视图，默认把“允许路由的 Agent”展示成一个默认群。
    if (pathname === "/claw-team/v1/groups" && method === "GET") {
        const acct = getAccount(undefined);
        const groups: GroupDescriptor[] = [
            {
                groupId: "default",
                name: "Default Claw Team Group",
                members: (await discoverAgents(acct)).map((agent) => agent.id),
            },
        ];
        sendJson(res, 200, groups);
        return true;
    }

    // 查询单个 groupId 的调试信息。
    if (pathname.startsWith("/claw-team/v1/groups/") && method === "GET") {
        const acct = getAccount(undefined);
        const groupId = pathname.split("/").filter(Boolean).at(-1);

        if (!groupId) {
            sendJson(res, 404, { error: "GROUP_NOT_FOUND", message: "group not found" });
            return true;
        }

        sendJson(res, 200, {
            groupId,
            name: groupId === "default" ? "Default Claw Team Group" : groupId,
            members: (await discoverAgents(acct)).map((agent) => agent.id),
        });
        return true;
    }

    return false;
}
