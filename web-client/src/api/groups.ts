import { apiClient } from "@/api/client";
import type { GroupDetailApi, GroupReadApi } from "@/types/api/group";

export async function fetchGroups(): Promise<GroupReadApi[]> {
    const response = await apiClient.get<GroupReadApi[]>("/api/groups");
    return response.data;
}

export async function fetchGroupDetail(groupId: number): Promise<GroupDetailApi> {
    const response = await apiClient.get<GroupDetailApi>(`/api/groups/${groupId}`);
    return response.data;
}

export async function createGroup(payload: {
    name: string;
    description?: string | null;
    members?: Array<{ instance_id: number; agent_id: number }>;
}): Promise<GroupReadApi> {
    const response = await apiClient.post<GroupReadApi>("/api/groups", payload);
    return response.data;
}

export async function addGroupMembers(
    groupId: number,
    members: Array<{ instance_id: number; agent_id: number }>,
) {
    const response = await apiClient.post(`/api/groups/${groupId}/members`, {
        members,
    });
    return response.data;
}

export async function deleteGroupMember(groupId: number, memberId: number): Promise<GroupDetailApi> {
    const response = await apiClient.delete<GroupDetailApi>(`/api/groups/${groupId}/members/${memberId}`);
    return response.data;
}

export async function deleteGroup(groupId: number): Promise<void> {
    await apiClient.post(`/api/groups/${groupId}/delete`);
}
