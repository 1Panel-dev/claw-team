/**
 * 这个文件只保留对外的 Agent 管理入口。
 * 真正的 CLI 调用、workspace 解析、profile 文件读写，都拆到独立模块里。
 */

import type { AgentDescriptor } from "../types.js";
import {
    readAgentProfileFiles,
    resolveAgentWorkspaceDir,
    writeAgentProfileFiles,
    type AgentProfileFiles,
} from "./agentWorkspace.js";
import { extractJsonArray, extractJsonObject, runOpenClawCli } from "./openclawCli.js";

type OpenClawCliAgent = {
    id?: string;
    name?: string;
};

type OpenClawAgentWorkspaceConfig = {
    agents?: {
        defaults?: {
            workspace?: string;
        };
        list?: Array<{
            id?: string;
            workspace?: string;
        }>;
    };
};

export type { AgentProfileFiles } from "./agentWorkspace.js";
export type { OpenClawAgentWorkspaceConfig };

function toAgentDescriptor(agentId: string, displayName?: string): AgentDescriptor {
    const normalizedName = displayName?.trim();
    return {
        id: agentId,
        name: normalizedName && normalizedName.length > 0 ? normalizedName : agentId,
        openclawAgentRef: agentId,
    };
}

async function findListedAgent(agentId: string): Promise<AgentDescriptor | undefined> {
    return (await listRealOpenClawAgents()).find((item) => item.id === agentId);
}

async function setAgentDisplayName(agentId: string, displayName?: string): Promise<void> {
    const normalizedName = displayName?.trim();
    if (!normalizedName || normalizedName === agentId) {
        return;
    }

    await runOpenClawCli([
        "agents",
        "set-identity",
        "--agent",
        agentId,
        "--name",
        normalizedName,
        "--json",
    ]);
}

export async function listRealOpenClawAgents(): Promise<AgentDescriptor[]> {
    const output = await runOpenClawCli(["agents", "list", "--json"]);
    const parsed = extractJsonArray(output);
    if (!parsed) {
        return [];
    }

    return parsed
        .map((item) => item as OpenClawCliAgent)
        .filter((item): item is OpenClawCliAgent & { id: string } => typeof item?.id === "string" && item.id.trim().length > 0)
        .map((item) => toAgentDescriptor(item.id, item.name));
}

export async function createRealOpenClawAgent(params: {
    agentId: string;
    displayName: string;
    profileFiles?: Partial<AgentProfileFiles>;
    cfg?: OpenClawAgentWorkspaceConfig;
}): Promise<AgentDescriptor> {
    // 先真实创建，再回查列表拿宿主最终状态，避免只信 add 命令的瞬时输出。
    const addOutput = await runOpenClawCli([
        "agents",
        "add",
        params.agentId,
        "--workspace",
        resolveAgentWorkspaceDir(params.agentId, params.cfg),
        "--non-interactive",
        "--json",
    ]);
    const addResult = extractJsonObject(addOutput);
    const agentId = String(addResult?.agentId ?? params.agentId).trim();
    if (!agentId) {
        throw new Error("openclaw_agent_create_failed");
    }

    await setAgentDisplayName(agentId, params.displayName);

    // 真实 Agent 创建完成后，再把 workspace 里的 profile 文件补齐。
    writeAgentProfileFiles({
        agentId,
        profileFiles: params.profileFiles,
        cfg: params.cfg,
    });

    return (await findListedAgent(agentId)) ?? toAgentDescriptor(agentId, params.displayName);
}

export function getRealOpenClawAgentProfile(params: {
    agentId: string;
    cfg?: OpenClawAgentWorkspaceConfig;
}): AgentProfileFiles {
    return readAgentProfileFiles(params);
}

export async function updateRealOpenClawAgent(params: {
    agentId: string;
    displayName?: string;
    profileFiles?: Partial<AgentProfileFiles>;
    cfg?: OpenClawAgentWorkspaceConfig;
}): Promise<AgentDescriptor> {
    const agentId = params.agentId.trim();
    if (!agentId) {
        throw new Error("openclaw_agent_update_failed");
    }

    await setAgentDisplayName(agentId, params.displayName);

    // 编辑链必须保持 patch 语义：未传的文件保持原样，不要回退成默认模板。
    const currentFiles = readAgentProfileFiles({
        agentId,
        cfg: params.cfg,
    });

    writeAgentProfileFiles({
        agentId,
        baseFiles: currentFiles,
        profileFiles: params.profileFiles,
        cfg: params.cfg,
    });

    return (await findListedAgent(agentId)) ?? toAgentDescriptor(agentId, params.displayName);
}
