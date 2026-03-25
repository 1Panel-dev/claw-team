<template>
  <div class="page-shell">
    <section class="hero page-card page-shell__header">
      <div>
        <div class="hero__eyebrow">{{ t("openclaw.eyebrow") }}</div>
        <h1 class="hero__title">{{ t("openclaw.title") }}</h1>
        <p class="hero__description">
          {{ t("openclaw.description") }}
        </p>
      </div>
      <div class="hero__actions">
        <div class="hero__badge">{{ t("openclaw.badge") }}</div>
        <button class="hero__button" @click="createDrawerVisible = true">{{ t("openclaw.addInstance") }}</button>
      </div>
    </section>

    <section class="grid page-grid">
      <article class="card page-card">
        <div class="card__header">
          <h2 class="card__title">{{ t("openclaw.instanceList") }}</h2>
          <span class="card__meta">{{ instances.length }}</span>
        </div>

        <div v-if="loading" class="card__empty">{{ t("openclaw.loadingInstances") }}</div>
        <div v-else-if="!instances.length" class="card__empty">{{ t("openclaw.noInstances") }}</div>

        <div v-else class="instance-list">
          <article v-for="instance in instances" :key="instance.id" class="instance-card">
            <header class="instance-card__header">
              <div>
                <div class="instance-card__title">{{ instance.name }}</div>
                <div class="instance-card__meta">{{ instance.channel_base_url }}</div>
              </div>
              <div class="instance-card__actions">
                <span class="status-pill" :class="statusClass(instance.status)">
                  {{ statusLabel(instance.status) }}
                </span>
                <button class="action-button action-button--ghost" @click="openAgentCreate(instance.id, instance.name)">
                  {{ t("openclaw.addAgent") }}
                </button>
                <button
                  class="action-button action-button--ghost"
                  :disabled="savingId === `instance:${instance.id}:sync`"
                  @click="syncAgents(instance.id, instance.name)"
                >
                  {{ t("openclaw.syncAgents") }}
                </button>
                <button
                    class="action-button action-button--ghost"
                    @click="openInstanceEdit(instance)"
                >
                  {{ t("openclaw.editInstance") }}
                </button>
                <button
                  class="action-button"
                  :disabled="savingId === `instance:${instance.id}`"
                  @click="toggleInstance(instance.id, instance.status !== 'active')"
                >
                  {{ instance.status === "active" ? t("openclaw.disable") : t("openclaw.enable") }}
                </button>
              </div>
            </header>

            <div class="instance-card__body">
              <div class="instance-card__section-header">
                <div class="instance-card__section-title">{{ t("openclaw.agents") }}</div>
              </div>
              <div v-if="!instance.agents.length" class="instance-card__empty">{{ t("openclaw.noAgents") }}</div>
              <div v-for="agent in instance.agents" :key="agent.id" class="agent-row">
                <div>
                  <div class="agent-row__title">{{ agent.display_name }}</div>
                  <div class="agent-row__meta">
                    {{ agent.agent_key }} · {{ agent.ct_id }}<span v-if="agent.role_name"> / {{ agent.role_name }}</span>
                  </div>
                </div>
                <div class="instance-card__actions">
                  <span class="status-pill" :class="agent.enabled ? 'status-pill--active' : 'status-pill--disabled'">
                    {{ agent.enabled ? t("conversation.enabled") : t("conversation.disabled") }}
                  </span>
                  <button
                    v-if="canEditAgent(agent)"
                    class="action-button action-button--ghost"
                    :disabled="savingId === `agent:${agent.id}` || loadingAgentProfileId === agent.id"
                    @click="openAgentEdit(instance.id, instance.name, agent)"
                  >
                    {{ t("openclaw.editAgent") }}
                  </button>
                  <button
                    class="action-button action-button--ghost"
                    :disabled="savingId === `agent:${agent.id}`"
                    @click="toggleAgent(agent.id, !agent.enabled)"
                  >
                    {{ agent.enabled ? t("openclaw.disable") : t("openclaw.enable") }}
                  </button>
                </div>
              </div>
            </div>
          </article>
        </div>
      </article>

      <article class="card page-card">
        <h2 class="card__title">{{ t("openclaw.currentStage") }}</h2>
        <p class="card__text">
          {{ t("openclaw.currentStageText") }}
        </p>
        <ul class="card__list">
          <li>{{ t("openclaw.stagePoint1") }}</li>
          <li>{{ t("openclaw.stagePoint2") }}</li>
          <li>{{ t("openclaw.stagePoint3") }}</li>
          <li>{{ t("openclaw.stagePoint4") }}</li>
        </ul>
      </article>
    </section>

    <InstanceCreateDrawer
      v-model:visible="createDrawerVisible"
      :submitting="creating"
      mode="create"
      @submit="handleCreateInstanceSubmit"
    />

    <InstanceCreateDrawer
      v-model:visible="editDrawerVisible"
      :submitting="creating"
      mode="edit"
      :initial-value="editingInstance"
      @submit="handleEditInstanceSubmit"
    />

    <AgentCreateDrawer
      v-model:visible="agentDrawerVisible"
      :submitting="creatingAgent || editingAgent"
      :instance-name="activeInstanceName"
      :mode="agentDrawerMode"
      :initial-value="editingAgentProfile"
      @submit="handleAgentSubmit"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * OpenClaw 页面现在开始承载真实的实例管理能力。
 *
 * 第一阶段先把“看列表 + 启用/禁用”做稳；
 * 创建和配置类表单后续在这个模块里继续补即可。
 */
import { computed, onMounted } from "vue";
import { ref } from "vue";
import ElMessage from "element-plus/es/components/message/index";

import AgentCreateDrawer from "@/components/openclaw/AgentCreateDrawer.vue";
import InstanceCreateDrawer from "@/components/openclaw/InstanceCreateDrawer.vue";
import { useI18n } from "@/composables/useI18n";
import { useOpenClawStore } from "@/stores/openclaw";
import type { AgentReadApi } from "@/types/api/agent";
import type { InstanceReadApi } from "@/types/api/instance";

const openClawStore = useOpenClawStore();
const createDrawerVisible = ref(false);
const editDrawerVisible = ref(false);
const agentDrawerVisible = ref(false);
const agentDrawerMode = ref<"create" | "edit">("create");
const activeInstanceId = ref<number | null>(null);
const activeInstanceName = ref("");
const editingInstance = ref<InstanceReadApi | null>(null);
const editingAgentProfile = ref<{
    agent_id: number;
    agent_key: string;
    display_name: string;
    role_name: string | null;
    identity_md: string;
    soul_md: string;
    user_md: string;
    memory_md: string;
} | null>(null);

const instances = computed(() => openClawStore.instances);
const loading = computed(() => openClawStore.loading);
const savingId = computed(() => openClawStore.savingId);
const creating = computed(() => openClawStore.creating);
const { t } = useI18n();
const creatingAgent = computed(
    () => activeInstanceId.value !== null && openClawStore.creatingAgentForInstanceId === activeInstanceId.value,
);
const editingAgent = computed(
    () => editingAgentProfile.value !== null && openClawStore.editingAgentId === editingAgentProfile.value.agent_id,
);
const loadingAgentProfileId = computed(() => openClawStore.loadingAgentProfileId);

onMounted(async () => {
    if (!instances.value.length) {
        await openClawStore.loadInstances();
    }
});

function statusLabel(status: string) {
    if (status === "active") {
        return t("openclaw.online");
    }
    if (status === "offline") {
        return t("openclaw.offline");
    }
    return t("openclaw.inactive");
}

function statusClass(status: string) {
    if (status === "active") {
        return "status-pill--active";
    }
    if (status === "offline") {
        return "status-pill--offline";
    }
    return "status-pill--disabled";
}

function canEditAgent(agent: AgentReadApi) {
    // 兼容历史数据：旧版本没有 created_via_claw_team 标记时，
    // 先保持非 main Agent 可编辑，避免把原来就从 ClawTeam 创建的 Agent 隐掉。
    return agent.created_via_claw_team || agent.agent_key.trim().toLowerCase() !== "main";
}

async function toggleInstance(instanceId: number, enable: boolean) {
    await openClawStore.setInstanceEnabled(instanceId, enable);
}

async function syncAgents(instanceId: number, instanceName: string) {
    const result = await openClawStore.syncInstanceAgents(instanceId);
    ElMessage.success(t("openclaw.syncSuccess", { name: instanceName, count: result.imported_agent_count }));
}

async function toggleAgent(agentId: number, enable: boolean) {
    await openClawStore.setAgentEnabled(agentId, enable);
}

async function handleCreateInstance(payload: {
    mode: "create";
    name: string;
    channel_base_url: string;
    shared_secret: string;
    channel_account_id: string;
}) {
    const result = await openClawStore.quickConnectInstance(payload);
    createDrawerVisible.value = false;
    ElMessage.success(t("openclaw.connectSuccess", { name: result.instance.name, count: result.imported_agent_count }));
}

function handleCreateInstanceSubmit(payload: {
    mode: "create";
    name: string;
    channel_base_url: string;
    shared_secret: string;
    channel_account_id: string;
} | {
    mode: "edit";
    instance_id: number;
    name: string;
    channel_base_url: string;
    shared_secret: string;
    channel_account_id: string;
}) {
    if (payload.mode !== "create") {
        return;
    }
    return handleCreateInstance(payload);
}

function openInstanceEdit(instance: InstanceReadApi) {
    editingInstance.value = instance;
    editDrawerVisible.value = true;
}

async function handleEditInstance(payload: {
    mode: "edit";
    instance_id: number;
    name: string;
    channel_base_url: string;
    shared_secret: string;
    channel_account_id: string;
}) {
    const instance = await openClawStore.updateInstance(payload.instance_id, {
        name: payload.name,
        channel_base_url: payload.channel_base_url,
        shared_secret: payload.shared_secret || undefined,
        channel_account_id: payload.channel_account_id,
    });
    editDrawerVisible.value = false;
    editingInstance.value = null;
    ElMessage.success(t("openclaw.updateSuccess", { name: instance.name }));
}

function handleEditInstanceSubmit(payload: {
    mode: "create";
    name: string;
    channel_base_url: string;
    shared_secret: string;
    channel_account_id: string;
} | {
    mode: "edit";
    instance_id: number;
    name: string;
    channel_base_url: string;
    shared_secret: string;
    channel_account_id: string;
}) {
    if (payload.mode !== "edit") {
        return;
    }
    return handleEditInstance(payload);
}

function openAgentCreate(instanceId: number, instanceName: string) {
    activeInstanceId.value = instanceId;
    activeInstanceName.value = instanceName;
    agentDrawerMode.value = "create";
    editingAgentProfile.value = null;
    agentDrawerVisible.value = true;
}

async function openAgentEdit(instanceId: number, instanceName: string, agent: AgentReadApi) {
    try {
        activeInstanceId.value = instanceId;
        activeInstanceName.value = instanceName;
        agentDrawerMode.value = "edit";
        const profile = await openClawStore.loadAgentProfile(agent.id);
        editingAgentProfile.value = {
            agent_id: profile.id,
            agent_key: profile.agent_key,
            display_name: profile.display_name,
            role_name: profile.role_name,
            identity_md: profile.identity_md,
            soul_md: profile.soul_md,
            user_md: profile.user_md,
            memory_md: profile.memory_md,
        };
        agentDrawerVisible.value = true;
    } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : String(error));
    }
}

async function handleCreateAgent(payload: {
    mode: "create";
    agent_key: string;
    display_name: string;
    role_name: string;
    identity_md?: string;
    soul_md?: string;
    user_md?: string;
    memory_md?: string;
}) {
    if (activeInstanceId.value === null) {
        return;
    }
    const agent = await openClawStore.createNewAgent(activeInstanceId.value, payload);
    agentDrawerVisible.value = false;
    ElMessage.success(t("openclaw.agentCreateSuccess", { name: agent.display_name }));
}

async function handleEditAgent(payload: {
    mode: "edit";
    agent_id: number;
    agent_key: string;
    display_name: string;
    role_name: string;
    identity_md?: string;
    soul_md?: string;
    user_md?: string;
    memory_md?: string;
}) {
    const agent = await openClawStore.updateExistingAgent(payload.agent_id, {
        display_name: payload.display_name,
        role_name: payload.role_name,
        identity_md: payload.identity_md,
        soul_md: payload.soul_md,
        user_md: payload.user_md,
        memory_md: payload.memory_md,
    });
    agentDrawerVisible.value = false;
    editingAgentProfile.value = null;
    ElMessage.success(t("openclaw.agentUpdateSuccess", { name: agent.display_name }));
}

function handleAgentSubmit(payload: {
    mode: "create";
    agent_key: string;
    display_name: string;
    role_name: string;
    identity_md?: string;
    soul_md?: string;
    user_md?: string;
    memory_md?: string;
} | {
    mode: "edit";
    agent_id: number;
    agent_key: string;
    display_name: string;
    role_name: string;
    identity_md?: string;
    soul_md?: string;
    user_md?: string;
    memory_md?: string;
}) {
    if (payload.mode === "edit") {
        return handleEditAgent(payload);
    }
    return handleCreateAgent(payload);
}
</script>

<style scoped>
.hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  background: linear-gradient(135deg, var(--color-bg-panel), color-mix(in srgb, var(--color-bg-soft) 65%, white));
}

.hero__eyebrow {
  color: var(--color-text-secondary);
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero__title {
  margin: 8px 0 12px;
  font-size: 1.9rem;
}

.hero__description {
  margin: 0;
  max-width: 62ch;
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.hero__badge {
  padding: 10px 14px;
  border-radius: 999px;
  background: var(--color-bg-app);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.hero__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.hero__button {
  padding: 10px 14px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  cursor: pointer;
}

.grid {
}

.card {
  gap: var(--space-3);
  background: var(--color-bg-app);
}

.card__title {
  margin: 0;
  font-size: 1.15rem;
}

.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.card__meta {
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}

.card__text {
  margin: 0;
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.card__list {
  margin: 0;
  padding-left: 1.2rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
}

.card__empty {
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.instance-list {
  display: grid;
  gap: var(--space-4);
}

.instance-card {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-panel);
}

.instance-card__header,
.agent-row,
.instance-card__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.instance-card__title,
.agent-row__title {
  font-weight: 700;
}

.instance-card__meta,
.agent-row__meta,
.instance-card__empty {
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}

.instance-card__body {
  display: grid;
  gap: var(--space-3);
}

.instance-card__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.instance-card__section-title {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.status-pill {
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 0.78rem;
  white-space: nowrap;
}

.status-pill--active {
  background: color-mix(in srgb, var(--color-success) 12%, var(--color-bg-app));
  color: var(--color-success);
}

.status-pill--offline {
  background: color-mix(in srgb, var(--color-text-secondary) 12%, var(--color-bg-app));
  color: var(--color-text-secondary);
}

.status-pill--disabled {
  background: color-mix(in srgb, var(--color-danger) 12%, var(--color-bg-app));
  color: var(--color-danger);
}

.action-button {
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-contrast);
  cursor: pointer;
}

.action-button--ghost {
  border: 1px solid var(--color-border);
  background: var(--color-bg-app);
  color: var(--color-text-primary);
}

.action-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 960px) {
  .hero,
  .grid {
    grid-template-columns: 1fr;
    flex-direction: column;
  }
}
</style>
