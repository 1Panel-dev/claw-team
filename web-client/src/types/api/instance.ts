export interface InstanceReadApi {
    id: number;
    instance_key: string;
    name: string;
    channel_base_url: string;
    channel_account_id: string;
    status: string;
    created_at: string;
    updated_at: string;
}

export interface InstanceHealthReadApi {
    id: number;
    status: string;
}

export interface InstanceCredentialsReadApi {
    outbound_token: string;
    inbound_signing_secret: string;
}

export interface ConnectInstanceResponseApi {
    instance: InstanceReadApi;
    imported_agent_count: number;
    agent_keys: string[];
    credentials: InstanceCredentialsReadApi;
}
