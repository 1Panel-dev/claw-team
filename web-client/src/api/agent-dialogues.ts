import { apiClient } from "@/api/client";
import type {
    AgentDialogueCreateApi,
    AgentDialogueMessageCreateApi,
    AgentDialogueReadApi,
} from "@/types/api/agent-dialogue";

export async function createAgentDialogue(payload: AgentDialogueCreateApi): Promise<AgentDialogueReadApi> {
    const response = await apiClient.post<AgentDialogueReadApi>("/api/agent-dialogues", payload);
    return response.data;
}

export async function fetchAgentDialogue(dialogueId: number): Promise<AgentDialogueReadApi> {
    const response = await apiClient.get<AgentDialogueReadApi>(`/api/agent-dialogues/${dialogueId}`);
    return response.data;
}

export async function pauseAgentDialogue(dialogueId: number): Promise<AgentDialogueReadApi> {
    const response = await apiClient.post<AgentDialogueReadApi>(`/api/agent-dialogues/${dialogueId}/pause`);
    return response.data;
}

export async function resumeAgentDialogue(dialogueId: number): Promise<AgentDialogueReadApi> {
    const response = await apiClient.post<AgentDialogueReadApi>(`/api/agent-dialogues/${dialogueId}/resume`);
    return response.data;
}

export async function stopAgentDialogue(dialogueId: number): Promise<AgentDialogueReadApi> {
    const response = await apiClient.post<AgentDialogueReadApi>(`/api/agent-dialogues/${dialogueId}/stop`);
    return response.data;
}

export async function sendAgentDialogueMessage(
    dialogueId: number,
    payload: AgentDialogueMessageCreateApi,
): Promise<{ message: string }> {
    const response = await apiClient.post<{ message: string }>(`/api/agent-dialogues/${dialogueId}/messages`, payload);
    return response.data;
}
