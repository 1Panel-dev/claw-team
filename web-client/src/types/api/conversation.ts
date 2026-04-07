/**
 * 这里放会话和消息相关的后端原始返回类型。
 */
export interface ConversationListItemApi {
    id: number;
    type: string;
    title: string | null;
    group_id: number | null;
    direct_instance_id: number | null;
    direct_agent_id: number | null;
    agent_dialogue_id?: number | null;
    created_at: string;
    updated_at: string;
    display_title: string;
    group_name: string | null;
    instance_name: string | null;
    agent_display_name: string | null;
    dialogue_source_agent_name?: string | null;
    dialogue_target_agent_name?: string | null;
    dialogue_status?: string | null;
    dialogue_window_seconds?: number | null;
    dialogue_soft_message_limit?: number | null;
    dialogue_hard_message_limit?: number | null;
    last_message_id: string | null;
    last_message_preview: string | null;
    last_message_sender_type: string | null;
    last_message_sender_label: string | null;
    last_message_at: string | null;
    last_message_status: string | null;
}

export interface ConversationReadApi {
    id: number;
    type: string;
    title: string | null;
    group_id: number | null;
    direct_instance_id: number | null;
    direct_agent_id: number | null;
    agent_dialogue_id?: number | null;
    created_at: string;
    updated_at: string;
}

export interface MessageReadApi {
    id: string;
    conversation_id: number;
    sender_type: string;
    sender_label: string;
    sender_cs_id?: string | null;
    source?: "webchat" | null;
    content: string;
    status: string;
    created_at: string;
    updated_at: string;
    parts?: Array<
        | {
              kind: "markdown";
              content: string;
          }
        | {
              kind: "attachment";
              name: string;
              mime_type: string | null;
              url: string;
          }
        | {
              kind: "tool_card";
              title: string;
              status: "pending" | "running" | "completed" | "failed";
              summary: string;
          }
    >;
}

export interface DispatchReadApi {
    id: string;
    message_id: string;
    conversation_id: number;
    instance_id: number;
    agent_id: number;
    dispatch_mode: string;
    channel_message_id: string | null;
    channel_trace_id: string | null;
    session_key: string | null;
    status: string;
    error_message: string | null;
    created_at: string;
    updated_at: string;
}

export interface ConversationMessagesResponseApi {
    conversation: ConversationReadApi;
    messages: MessageReadApi[];
    dispatches: DispatchReadApi[];
    next_message_cursor: string | null;
    next_dispatch_cursor: string | null;
    has_more_messages: boolean;
    oldest_loaded_message_id: string | null;
}
