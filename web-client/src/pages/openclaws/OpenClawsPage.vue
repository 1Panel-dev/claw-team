<template>
  <div class="page-shell">
    <section class="page-shell__body" v-loading="syncingAgents" element-loading-background="rgba(122, 122, 122, 0.8)">
      <el-card shadow="never">
        <template #header>
          <div class="openclaws-page__panel-header">
            <el-space wrap>
              <h2 class="page-section-title">{{ t("openclaw.instanceList") }}</h2>
              <el-tag type="info" effect="plain">{{ instances.length }}</el-tag>
            </el-space>
            <el-button type="primary" :disabled="pageBusy" @click="openCreateInstance">
              {{ t("openclaw.addInstance") }}
            </el-button>
          </div>
        </template>

        <el-empty v-if="loading && !instances.length" :description="t('openclaw.loadingInstances')"/>
        <el-empty v-else-if="!instances.length" :description="t('openclaw.noInstances')"/>

        <div v-else class="openclaws-page__instance-list">
          <el-card
            v-for="instance in instances"
            :key="instance.id"
            shadow="hover"
            class="openclaws-page__instance"
          >
            <div class="openclaws-page__instance-header">
              <div>
                <div class="openclaws-page__instance-title">
                  {{ instance.name }}
                  <el-tag :type="statusTagType(instance.status)" effect="light">
                    {{ statusLabel(instance.status) }}
                  </el-tag>
                </div>
                <div class="openclaws-page__instance-meta">{{ instance.channel_base_url }}</div>
              </div>

              <el-space wrap class="openclaws-page__instance-actions">
                <el-tooltip :content="t('openclaw.addAgent')" placement="top">
                  <el-button type="primary" circle :disabled="pageBusy" @click="openAgentCreate(instance.id, instance.name)">
                    <el-icon><Plus /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="t('openclaw.syncAgents')" placement="top">
                  <el-button
                    circle
                    :loading="savingId === `instance:${instance.id}:sync`"
                    :disabled="pageBusy"
                    @click="syncAgents(instance.id, instance.name)"
                  >
                    <el-icon><RefreshRight /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="t('openclaw.editInstance')" placement="top">
                  <el-button circle :disabled="pageBusy" @click="openInstanceEdit(instance)">
                    <el-icon><EditPen /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip
                  :content="instance.status === 'active' ? t('openclaw.disable') : t('openclaw.enable')"
                  placement="top"
                >
                  <el-button
                    :type="instance.status === 'active' ? 'warning' : 'success'"
                    circle
                    :disabled="pageBusy"
                    @click="toggleInstance(instance.id, instance.status !== 'active')"
                  >
                    <el-icon>
                      <component :is="instance.status === 'active' ? SwitchButton : VideoPlay" />
                    </el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="t('openclaw.deleteInstance')" placement="top">
                  <el-button
                    type="danger"
                    circle
                    :disabled="pageBusy"
                    @click="confirmDeleteInstance(instance)"
                  >
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </el-tooltip>
              </el-space>
            </div>

            <el-table
              v-if="instance.agents.length"
              :data="instance.agents"
              stripe
              table-layout="fixed"
            >
              <el-table-column prop="display_name" :label="t('openclaw.displayName')" min-width="300" show-overflow-tooltip/>
              <el-table-column prop="agent_key" :label="t('openclaw.agentKey')" min-width="300" show-overflow-tooltip/>
              <el-table-column prop="cs_id" label="CS ID" min-width="200" show-overflow-tooltip/>
              <el-table-column :label="t('openclaw.roleName')" min-width="240" show-overflow-tooltip>
                <template #default="{ row }">
                  {{ row.role_name || "—" }}
                </template>
              </el-table-column>
              <el-table-column :label="t('openclaw.agentStatus')" min-width="120">
                <template #default="{ row }">
                  <el-tag :type="row.enabled ? 'success' : 'info'" effect="light">
                    {{ row.enabled ? t("conversation.enabled") : t("conversation.disabled") }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column :label="t('openclaw.actions')" min-width="220" fixed="right">
                <template #default="{ row }">
                  <el-space>
                    <el-button
                      v-if="canEditAgent(row)"
                      link
                      :disabled="pageBusy"
                      @click="openAgentEdit(instance.id, instance.name, row)"
                    >
                      {{ t("openclaw.editAgent") }}
                    </el-button>
                    <el-button
                      link
                      :disabled="pageBusy"
                      @click="toggleAgent(row.id, !row.enabled)"
                    >
                      {{ row.enabled ? t("openclaw.disable") : t("openclaw.enable") }}
                    </el-button>
                  </el-space>
                </template>
              </el-table-column>
            </el-table>

            <el-empty v-else :description="t('openclaw.noAgents')"/>
          </el-card>
        </div>
      </el-card>
    </section>

    <InstanceCreateDrawer
      v-model:visible="createDrawerVisible"
      :submitting="creating"
      :credentials="createCredentials"
      mode="create"
      @submit="handleCreateInstanceSubmit"
    />

    <InstanceCreateDrawer
      v-model:visible="editDrawerVisible"
      :submitting="creating"
      mode="edit"
      :initial-value="editingInstance"
      :credentials="editCredentials"
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
import { Delete, EditPen, Plus, RefreshRight, SwitchButton, VideoPlay } from "@element-plus/icons-vue";
import {computed, onBeforeUnmount, onMounted, ref} from "vue";

import AgentCreateDrawer from "@/components/openclaw/AgentCreateDrawer.vue";
import InstanceCreateDrawer from "@/components/openclaw/InstanceCreateDrawer.vue";
import {useI18n} from "@/composables/useI18n";
import {useOpenClawStore} from "@/stores/openclaw";
import type {AgentReadApi} from "@/types/api/agent";
import type {InstanceCredentialsReadApi, InstanceReadApi} from "@/types/api/instance";

const openClawStore = useOpenClawStore();
const {t} = useI18n();

const createDrawerVisible = ref(false);
const editDrawerVisible = ref(false);
const agentDrawerVisible = ref(false);
const agentDrawerMode = ref<"create" | "edit">("create");
const syncingAgents = ref(false);
const refreshTimer = ref<number | null>(null);
const activeInstanceId = ref<number | null>(null);
const activeInstanceName = ref("");
const editingInstance = ref<InstanceReadApi | null>(null);
const createCredentials = ref<InstanceCredentialsReadApi | null>(null);
const editCredentials = ref<InstanceCredentialsReadApi | null>(null);
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
const creatingAgent = computed(
  () => activeInstanceId.value !== null && openClawStore.creatingAgentForInstanceId === activeInstanceId.value,
);
const editingAgent = computed(
  () => editingAgentProfile.value !== null && openClawStore.editingAgentId === editingAgentProfile.value.agent_id,
);
const loadingAgentProfileId = computed(() => openClawStore.loadingAgentProfileId);
const pageBusy = computed(
  () =>
    syncingAgents.value ||
    loading.value ||
    creating.value ||
    savingId.value !== null ||
    creatingAgent.value ||
    editingAgent.value ||
    loadingAgentProfileId.value !== null,
);

onMounted(async () => {
  if (!instances.value.length) {
    await openClawStore.loadInstances();
  }
  await openClawStore.refreshInstanceHealth();
  startInstancePolling();
});

onBeforeUnmount(() => {
  stopInstancePolling();
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

function statusTagType(status: string) {
  if (status === "active") {
    return "success";
  }
  if (status === "offline") {
    return "warning";
  }
  return "info";
}

function canEditAgent(agent: AgentReadApi) {
  return agent.created_via_clawswarm || agent.agent_key.trim().toLowerCase() !== "main";
}

async function syncAgents(instanceId: number, instanceName: string) {
  syncingAgents.value = true;
  try {
    const result = await openClawStore.syncInstanceAgents(instanceId);
    ElMessage.success(t("openclaw.syncSuccess", {name: instanceName, count: result.imported_agent_count}));
  } finally {
    syncingAgents.value = false;
  }
}

function startInstancePolling(intervalMs = 60_000) {
  stopInstancePolling();
  refreshTimer.value = window.setInterval(() => {
    if (!pageBusy.value) {
      void openClawStore.refreshInstanceHealth();
    }
  }, intervalMs);
}

function stopInstancePolling() {
  if (refreshTimer.value !== null) {
    window.clearInterval(refreshTimer.value);
    refreshTimer.value = null;
  }
}

async function toggleInstance(instanceId: number, enable: boolean) {
  await openClawStore.setInstanceEnabled(instanceId, enable);
}

async function confirmDeleteInstance(instance: InstanceReadApi) {
  try {
    await ElMessageBox.confirm(
      t("openclaw.deleteInstanceConfirm", {name: instance.name}),
      t("openclaw.deleteInstanceTitle"),
      {
        type: "warning",
        confirmButtonText: t("openclaw.confirmDeleteInstance"),
        cancelButtonText: t("common.cancel"),
      },
    );
  } catch {
    return;
  }

  try {
    await openClawStore.deleteExistingInstance(instance.id);
    ElMessage.success(t("openclaw.deleteInstanceSuccess", {name: instance.name}));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function toggleAgent(agentId: number, enable: boolean) {
  await openClawStore.setAgentEnabled(agentId, enable);
}

function openCreateInstance() {
  createCredentials.value = null;
  createDrawerVisible.value = true;
}

async function openInstanceEdit(instance: InstanceReadApi) {
  try {
    editingInstance.value = instance;
    editCredentials.value = await openClawStore.loadInstanceCredentials(instance.id);
    editDrawerVisible.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
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

async function handleCreateInstance(payload: {
  mode: "create";
  name: string;
  channel_base_url: string;
  channel_account_id: string;
}) {
  try {
    const result = await openClawStore.quickConnectInstance(payload);
    createCredentials.value = result.credentials;
    ElMessage.success(t("openclaw.connectSuccess", {name: result.instance.name, count: result.imported_agent_count}));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function handleEditInstance(payload: {
  mode: "edit";
  instance_id: number;
  name: string;
  channel_base_url: string;
  channel_account_id: string;
}) {
  try {
    const instance = await openClawStore.updateInstance(payload.instance_id, {
      name: payload.name,
      channel_base_url: payload.channel_base_url,
      channel_account_id: payload.channel_account_id,
    });
    ElMessage.success(t("openclaw.updateSuccess", {name: instance.name}));
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
  try {
    const agent = await openClawStore.createNewAgent(activeInstanceId.value, payload);
    agentDrawerVisible.value = false;
    ElMessage.success(t("openclaw.agentCreateSuccess", {name: agent.display_name}));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
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
  try {
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
    ElMessage.success(t("openclaw.agentUpdateSuccess", {name: agent.display_name}));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function handleCreateInstanceSubmit(
  payload:
    | {
    mode: "create";
    name: string;
    channel_base_url: string;
    channel_account_id: string;
  }
    | {
    mode: "edit";
    instance_id: number;
    name: string;
    channel_base_url: string;
    channel_account_id: string;
  },
) {
  if (payload.mode === "create") {
    return handleCreateInstance(payload);
  }
}

function handleEditInstanceSubmit(
  payload:
    | {
    mode: "create";
    name: string;
    channel_base_url: string;
    channel_account_id: string;
  }
    | {
    mode: "edit";
    instance_id: number;
    name: string;
    channel_base_url: string;
    channel_account_id: string;
  },
) {
  if (payload.mode === "edit") {
    return handleEditInstance(payload);
  }
}

function handleAgentSubmit(
  payload:
    | {
    mode: "create";
    agent_key: string;
    display_name: string;
    role_name: string;
    identity_md?: string;
    soul_md?: string;
    user_md?: string;
    memory_md?: string;
  }
    | {
    mode: "edit";
    agent_id: number;
    agent_key: string;
    display_name: string;
    role_name: string;
    identity_md?: string;
    soul_md?: string;
    user_md?: string;
    memory_md?: string;
  },
) {
  if (payload.mode === "edit") {
    return handleEditAgent(payload);
  }
  return handleCreateAgent(payload);
}

</script>

<style scoped>
.page-shell {
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.openclaws-page__panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.openclaws-page__instance-list {
  display: grid;
  gap: var(--space-4);
}

.openclaws-page__instance {
  display: grid;
  gap: var(--space-3);
}

.openclaws-page__instance-actions {
  align-items: center;
}

.openclaws-page__instance-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.openclaws-page__instance-title {
  font-weight: 700;
}

.openclaws-page__instance-meta {
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}

@media (max-width: 960px) {
  .openclaws-page__instance-header,
  .openclaws-page__panel-header {
    flex-direction: column;
  }
}
</style>
