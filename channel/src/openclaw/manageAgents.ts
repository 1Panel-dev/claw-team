/**
 * 这个文件负责通过 OpenClaw CLI 管理真实 Agent。
 *
 * 目前先支持最小能力：
 * 1. 创建真实 Agent
 * 2. 设置展示名称
 *
 * 这样 claw-team 的“新增 Agent”就不再只是写调度中心数据库，
 * 而是能真正把 Agent 建到 OpenClaw 宿主里，再同步回来。
 */
import { execFileSync } from "node:child_process";

import type { AgentDescriptor } from "../types.js";

type OpenClawCliAgent = {
    id?: string;
    name?: string;
};

// 容器环境里不同镜像的安装位置可能不同，这里按常见候选顺序尝试。
function runOpenClawCli(args: string[]): string {
    for (const command of ["/usr/local/bin/openclaw", "openclaw"]) {
        try {
            return execFileSync(command, args, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch {
            // try next candidate
        }
    }
    throw new Error("openclaw_cli_unavailable");
}

// CLI --json 输出前后偶尔会混进日志，这里从原始文本里尽量提取首个对象。
function extractJsonObject(raw: string): Record<string, unknown> | null {
    const start = raw.indexOf("{");
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === "\"") {
                inString = false;
            }
            continue;
        }

        if (ch === "\"") {
            inString = true;
            continue;
        }

        if (ch === "{") {
            depth += 1;
            continue;
        }

        if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(raw.slice(start, i + 1));
                    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                        ? (parsed as Record<string, unknown>)
                        : null;
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}

// list 场景同理，尽量从原始输出里提取首个 JSON 数组。
function extractJsonArray(raw: string): unknown[] | null {
    const start = raw.indexOf("[");
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === "\"") {
                inString = false;
            }
            continue;
        }

        if (ch === "\"") {
            inString = true;
            continue;
        }

        if (ch === "[") {
            depth += 1;
            continue;
        }

        if (ch === "]") {
            depth -= 1;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(raw.slice(start, i + 1));
                    return Array.isArray(parsed) ? parsed : null;
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}

export function listRealOpenClawAgents(): AgentDescriptor[] {
    const output = runOpenClawCli(["agents", "list", "--json"]);
    const parsed = extractJsonArray(output);
    if (!parsed) return [];

    return parsed
        .map((item) => item as OpenClawCliAgent)
        .filter((item): item is OpenClawCliAgent & { id: string } => typeof item?.id === "string" && item.id.trim().length > 0)
        .map((item) => ({
            id: item.id,
            name: typeof item.name === "string" && item.name.trim().length > 0 ? item.name : item.id,
            openclawAgentRef: item.id,
        }));
}

// 第一版 workspace 先按固定规则生成，避免把底层目录细节暴露给上层表单。
function normalizeWorkspace(agentId: string): string {
    return `/home/node/.openclaw/workspace-${agentId}`;
}

export function createRealOpenClawAgent(params: {
    agentId: string;
    displayName: string;
}): AgentDescriptor {
    // 先真实创建，再回查列表拿宿主最终状态，避免只信 add 命令的瞬时输出。
    const addOutput = runOpenClawCli([
        "agents",
        "add",
        params.agentId,
        "--workspace",
        normalizeWorkspace(params.agentId),
        "--non-interactive",
        "--json",
    ]);
    const addResult = extractJsonObject(addOutput);
    const agentId = String(addResult?.agentId ?? params.agentId).trim();
    if (!agentId) {
        throw new Error("openclaw_agent_create_failed");
    }

    if (params.displayName.trim() && params.displayName.trim() !== agentId) {
        runOpenClawCli([
            "agents",
            "set-identity",
            "--agent",
            agentId,
            "--name",
            params.displayName.trim(),
            "--json",
        ]);
    }

    const created = listRealOpenClawAgents().find((item) => item.id === agentId);
    return created ?? {
        id: agentId,
        name: params.displayName.trim() || agentId,
        openclawAgentRef: agentId,
    };
}
