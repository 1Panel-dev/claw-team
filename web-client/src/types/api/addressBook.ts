/**
 * 这里放 scheduler-server 通讯录接口的原始类型。
 *
 * 这一层保持和后端字段一致，避免页面组件直接耦合后端结构。
 */
export interface AddressBookAgentApi {
    id: number;
    agent_key: string;
    cs_id: string;
    display_name: string;
    role_name: string | null;
    enabled: boolean;
}

export interface AddressBookInstanceApi {
    id: number;
    name: string;
    status: string;
    agents: AddressBookAgentApi[];
}

export interface AddressBookGroupMemberApi {
    id: number;
    instance_id: number;
    agent_id: number;
    display_name: string;
    agent_key: string;
    instance_name: string;
}

export interface AddressBookGroupApi {
    id: number;
    name: string;
    description: string | null;
    members: AddressBookGroupMemberApi[];
}

export interface AddressBookResponseApi {
    instances: AddressBookInstanceApi[];
    groups: AddressBookGroupApi[];
}
