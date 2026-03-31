import { defineStore } from "pinia";

import { createAgent, disableAgent, enableAgent, fetchAgentProfile, fetchAgents, updateAgent } from "@/api/agents";
import {
    connectOpenClaw,
    createInstance,
    disableInstance,
    enableInstance,
    fetchInstanceHealth,
    fetchInstances,
    syncOpenClawAgents,
    updateOpenClawInstance,
} from "@/api/instances";
import type { AgentReadApi } from "@/types/api/agent";
import type { InstanceReadApi } from "@/types/api/instance";

export interface OpenClawInstanceView extends InstanceReadApi {
    agents: AgentReadApi[];
}

export const useOpenClawStore = defineStore("openclaw", {
    state: () => ({
        instances: [] as OpenClawInstanceView[],
        loading: false,
        savingId: null as string | null,
        creating: false,
        creatingAgentForInstanceId: null as number | null,
        editingAgentId: null as number | null,
        loadingAgentProfileId: null as number | null,
    }),
    actions: {
        async loadInstances() {
            this.loading = true;
            try {
                const instances = await fetchInstances();
                const items = await Promise.all(
                    instances.map(async (instance) => ({
                        ...instance,
                        agents: await fetchAgents(instance.id),
                    })),
                );
                this.instances = items;
            } finally {
                this.loading = false;
            }
        },
        async refreshInstanceHealth() {
            const items = await fetchInstanceHealth();
            const statusById = new Map(items.map((item) => [item.id, item.status]));
            this.instances = this.instances.map((instance) => ({
                ...instance,
                status: statusById.get(instance.id) ?? instance.status,
            }));
        },
        async createNewInstance(payload: {
            name: string;
            channel_base_url: string;
            channel_account_id: string;
            channel_signing_secret: string;
            callback_token: string;
        }) {
            this.creating = true;
            try {
                const instance = await createInstance({
                    ...payload,
                    status: "active",
                });
                await this.loadInstances();
                return instance;
            } finally {
                this.creating = false;
            }
        },
        async quickConnectInstance(payload: {
            name: string;
            channel_base_url: string;
            shared_secret: string;
            channel_account_id?: string;
        }) {
            this.creating = true;
            try {
                const result = await connectOpenClaw(payload);
                await this.loadInstances();
                return result;
            } finally {
                this.creating = false;
            }
        },
        async updateInstance(
            instanceId: number,
            payload: {
                name: string;
                channel_base_url: string;
                shared_secret?: string;
                channel_account_id?: string;
            },
        ) {
            this.creating = true;
            try {
                const instance = await updateOpenClawInstance(instanceId, {
                    name: payload.name,
                    channel_base_url: payload.channel_base_url,
                    channel_account_id: payload.channel_account_id ?? "default",
                    ...(payload.shared_secret
                        ? {
                            channel_signing_secret: payload.shared_secret,
                            callback_token: payload.shared_secret,
                        }
                        : {}),
                });
                await this.loadInstances();
                return instance;
            } finally {
                this.creating = false;
            }
        },
        async syncInstanceAgents(instanceId: number) {
            this.savingId = `instance:${instanceId}:sync`;
            try {
                const result = await syncOpenClawAgents(instanceId);
                await this.loadInstances();
                return result;
            } finally {
                this.savingId = null;
            }
        },
        async setInstanceEnabled(instanceId: number, enabled: boolean) {
            this.savingId = `instance:${instanceId}`;
            try {
                await (enabled ? enableInstance(instanceId) : disableInstance(instanceId));
                await this.loadInstances();
            } finally {
                this.savingId = null;
            }
        },
        async setAgentEnabled(agentId: number, enabled: boolean) {
            this.savingId = `agent:${agentId}`;
            try {
                await (enabled ? enableAgent(agentId) : disableAgent(agentId));
                await this.loadInstances();
            } finally {
                this.savingId = null;
            }
        },
        async createNewAgent(
            instanceId: number,
            payload: {
                agent_key: string;
                display_name: string;
                role_name?: string | null;
                identity_md?: string | null;
                soul_md?: string | null;
                user_md?: string | null;
                memory_md?: string | null;
                enabled?: boolean;
            },
        ) {
            this.creatingAgentForInstanceId = instanceId;
            try {
                const agent = await createAgent(instanceId, {
                    ...payload,
                    enabled: payload.enabled ?? true,
                });
                await this.loadInstances();
                return agent;
            } finally {
                this.creatingAgentForInstanceId = null;
            }
        },
        async loadAgentProfile(agentId: number) {
            this.loadingAgentProfileId = agentId;
            try {
                return await fetchAgentProfile(agentId);
            } finally {
                this.loadingAgentProfileId = null;
            }
        },
        async updateExistingAgent(
            agentId: number,
            payload: {
                display_name?: string | null;
                role_name?: string | null;
                identity_md?: string | null;
                soul_md?: string | null;
                user_md?: string | null;
                memory_md?: string | null;
                enabled?: boolean;
            },
        ): Promise<AgentReadApi> {
            this.editingAgentId = agentId;
            try {
                const agent = await updateAgent(agentId, payload);
                await this.loadInstances();
                return agent;
            } finally {
                this.editingAgentId = null;
            }
        },
    },
});
