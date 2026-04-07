export interface AgentDialogueCreateApi {
    source_agent_id: number;
    target_agent_id: number;
    topic: string;
    window_seconds?: number;
    soft_message_limit?: number;
    hard_message_limit?: number;
}

export interface AgentDialogueReadApi {
    id: number;
    conversation_id: number;
    source_agent_id: number;
    source_agent_cs_id: string;
    source_agent_display_name: string;
    source_agent_instance_name?: string | null;
    target_agent_id: number;
    target_agent_cs_id: string;
    target_agent_display_name: string;
    target_agent_instance_name?: string | null;
    topic: string;
    status: string;
    initiator_type: string;
    initiator_agent_id: number | null;
    window_seconds: number;
    soft_message_limit: number;
    hard_message_limit: number;
    soft_limit_warned_at: string | null;
    last_speaker_agent_id: number | null;
    last_speaker_agent_cs_id: string | null;
    last_speaker_agent_display_name: string | null;
    next_agent_id: number | null;
    next_agent_cs_id: string | null;
    next_agent_display_name: string | null;
    created_at: string;
    updated_at: string;
}

export interface AgentDialogueMessageCreateApi {
    content: string;
}
