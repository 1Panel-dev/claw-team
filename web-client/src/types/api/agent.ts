export interface AgentReadApi {
    id: number;
    instance_id: number;
    agent_key: string;
    cs_id: string;
    display_name: string;
    role_name: string | null;
    enabled: boolean;
    created_via_clawswarm: boolean;
    created_at: string;
    updated_at: string;
}

export interface AgentProfileReadApi extends AgentReadApi {
    identity_md: string;
    soul_md: string;
    user_md: string;
    memory_md: string;
}
