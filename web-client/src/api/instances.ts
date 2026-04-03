import { apiClient } from "@/api/client";
import type {
    ConnectInstanceResponseApi,
    InstanceCredentialsReadApi,
    InstanceHealthReadApi,
    InstanceReadApi,
} from "@/types/api/instance";

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
    channel_account_id?: string;
}): Promise<ConnectInstanceResponseApi> {
    const response = await apiClient.post<ConnectInstanceResponseApi>("/api/instances/connect", payload, {
        timeout: 60000,
    });
    return response.data;
}

export async function fetchInstanceCredentials(instanceId: number): Promise<InstanceCredentialsReadApi> {
    const response = await apiClient.get<InstanceCredentialsReadApi>(`/api/instances/${instanceId}/credentials`);
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
    }>(`/api/instances/${instanceId}/sync-agents`, undefined, {
        timeout: 60000,
    });
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

export async function deleteInstance(instanceId: number): Promise<void> {
    await apiClient.delete(`/api/instances/${instanceId}`);
}
