import { apiClient } from "@/api/client";
import type { InstanceHealthReadApi, InstanceReadApi } from "@/types/api/instance";

export async function fetchInstances(): Promise<InstanceReadApi[]> {
    const response = await apiClient.get<InstanceReadApi[]>("/api/instances");
    return response.data;
}

export async function fetchInstanceHealth(): Promise<InstanceHealthReadApi[]> {
    const response = await apiClient.get<InstanceHealthReadApi[]>("/api/instances/health");
    return response.data;
}

export async function createInstance(payload: {
    name: string;
    channel_base_url: string;
    channel_account_id: string;
    channel_signing_secret: string;
    callback_token: string;
    status?: string;
}): Promise<InstanceReadApi> {
    const response = await apiClient.post<InstanceReadApi>("/api/instances", payload);
    return response.data;
}

export async function connectOpenClaw(payload: {
    name: string;
    channel_base_url: string;
    shared_secret: string;
    channel_account_id?: string;
}): Promise<{
    instance: InstanceReadApi;
    imported_agent_count: number;
    agent_keys: string[];
}> {
    const response = await apiClient.post<{
        instance: InstanceReadApi;
        imported_agent_count: number;
        agent_keys: string[];
    }>("/api/instances/connect", payload);
    return response.data;
}

export async function syncOpenClawAgents(instanceId: number): Promise<{
    instance: InstanceReadApi;
    imported_agent_count: number;
    agent_keys: string[];
}> {
    const response = await apiClient.post<{
        instance: InstanceReadApi;
        imported_agent_count: number;
        agent_keys: string[];
    }>(`/api/instances/${instanceId}/sync-agents`);
    return response.data;
}

export async function updateOpenClawInstance(
    instanceId: number,
    payload: {
        name?: string;
        channel_base_url?: string;
        channel_account_id?: string;
        channel_signing_secret?: string;
        callback_token?: string;
    },
): Promise<InstanceReadApi> {
    const response = await apiClient.put<InstanceReadApi>(`/api/instances/${instanceId}`, payload);
    return response.data;
}

export async function enableInstance(instanceId: number): Promise<InstanceReadApi> {
    const response = await apiClient.post<InstanceReadApi>(`/api/instances/${instanceId}/enable`);
    return response.data;
}

export async function disableInstance(instanceId: number): Promise<InstanceReadApi> {
    const response = await apiClient.post<InstanceReadApi>(`/api/instances/${instanceId}/disable`);
    return response.data;
}
