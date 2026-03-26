import { apiClient } from "@/api/client";
import type {
    ConversationListItemApi,
    ConversationMessagesResponseApi,
    ConversationReadApi,
} from "@/types/api/conversation";

export async function fetchConversationList(): Promise<ConversationListItemApi[]> {
    const response = await apiClient.get<ConversationListItemApi[]>("/api/conversations");
    return response.data;
}

export async function createDirectConversation(instanceId: number, agentId: number): Promise<ConversationReadApi> {
    const response = await apiClient.post<ConversationReadApi>("/api/conversations/direct", {
        instance_id: instanceId,
        agent_id: agentId,
    });
    return response.data;
}

export async function createGroupConversation(groupId: number): Promise<ConversationReadApi> {
    const response = await apiClient.post<ConversationReadApi>("/api/conversations/group", {
        group_id: groupId,
    });
    return response.data;
}

export async function fetchConversationMessages(
    conversationId: number,
    params?: {
        messageAfter?: string | null;
        dispatchAfter?: string | null;
        beforeMessageId?: string | null;
        limit?: number;
        includeDispatches?: boolean;
    },
): Promise<ConversationMessagesResponseApi> {
    const response = await apiClient.get<ConversationMessagesResponseApi>(`/api/conversations/${conversationId}/messages`, {
        params: {
            messageAfter: params?.messageAfter ?? undefined,
            dispatchAfter: params?.dispatchAfter ?? undefined,
            beforeMessageId: params?.beforeMessageId ?? undefined,
            limit: params?.limit ?? undefined,
            includeDispatches: params?.includeDispatches ?? undefined,
        },
    });
    return response.data;
}

export async function sendConversationMessage(
    conversationId: number,
    payload: { content: string; mentions?: string[]; use_dedicated_direct_session?: boolean },
) {
    const response = await apiClient.post(`/api/conversations/${conversationId}/messages`, payload);
    return response.data;
}
