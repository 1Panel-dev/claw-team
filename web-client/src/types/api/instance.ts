export interface InstanceReadApi {
    id: number;
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
