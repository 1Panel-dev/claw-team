import { apiClient } from "@/api/client";
import type { AgentProfileReadApi, AgentReadApi } from "@/types/api/agent";

export async function fetchAgents(instanceId: number): Promise<AgentReadApi[]> {
    const response = await apiClient.get<AgentReadApi[]>(`/api/instances/${instanceId}/agents`);
    return response.data;
}

export async function createAgent(
    instanceId: number,
    payload: {
        agent_key: string;
        display_name: string;
        role_name?: string | null;
        identity_md?: string | null;
        soul_md?: string | null;
        user_md?: string | null;
        memory_md?: string | null;
        enabled?: boolean;
    },
): Promise<AgentReadApi> {
    // Agent 创建会触发远端文件写入和同步，耗时通常长于普通接口。
    const response = await apiClient.post<AgentReadApi>(`/api/instances/${instanceId}/agents`, payload, {
        timeout: 70000,
    });
    return response.data;
}

export async function fetchAgentProfile(agentId: number): Promise<AgentProfileReadApi> {
    const response = await apiClient.get<AgentProfileReadApi>(`/api/agents/${agentId}/profile`, {
        timeout: 30000,
    });
    return response.data;
}

export async function updateAgent(
    agentId: number,
    payload: {
        display_name?: string | null;
        role_name?: string | null;
        identity_md?: string | null;
        soul_md?: string | null;
        user_md?: string | null;
        memory_md?: string | null;
        enabled?: boolean;
    },
): Promise<AgentReadApi> {
    const response = await apiClient.put<AgentReadApi>(`/api/agents/${agentId}`, payload, {
        timeout: 70000,
    });
    return response.data;
}

export async function enableAgent(agentId: number): Promise<AgentReadApi> {
    const response = await apiClient.post<AgentReadApi>(`/api/agents/${agentId}/enable`);
    return response.data;
}

export async function disableAgent(agentId: number): Promise<AgentReadApi> {
    const response = await apiClient.post<AgentReadApi>(`/api/agents/${agentId}/disable`);
    return response.data;
}
