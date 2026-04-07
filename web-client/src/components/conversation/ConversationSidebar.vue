<template>
  <div class="sidebar">
    <aside class="sidebar__rail">
      <button
        v-for="item in navItems"
        :key="item.key"
        class="sidebar__rail-item"
        :class="{ 'sidebar__rail-item--active': activePane === item.key }"
        type="button"
        :title="t(item.labelKey)"
        @click="activePane = item.key"
      >
        <ElIcon><component :is="item.icon" /></ElIcon>
      </button>
    </aside>

    <section class="sidebar__panel">
      <header class="sidebar__panel-header">
        <div class="sidebar__search">
          <ElInput
            v-model="searchQuery"
            class="sidebar__search-input"
            :placeholder="t('conversation.search')"
            clearable
          />
        </div>

        <ElButton
          v-if="activePane === 'groups' || activePane === 'recent'"
          class="sidebar__plus"
          circle
          :title="activePane === 'groups' ? t('conversation.createGroup') : t('conversation.createAgentDialogue')"
          @click="activePane === 'groups' ? createDrawerVisible = true : agentDialogueDrawerVisible = true"
        >
          <ElIcon><Plus /></ElIcon>
        </ElButton>
        <ElButton
          v-else-if="activePane === 'agents'"
          class="sidebar__plus sidebar__plus--muted"
          circle
          :title="t('conversation.refreshContacts')"
          @click="refreshAgentsPane"
        >
          <ElIcon><RefreshRight /></ElIcon>
        </ElButton>
        <ElButton
          v-else
          class="sidebar__plus sidebar__plus--muted"
          circle
          :title="t('conversation.switchView')"
          @click="cyclePane"
        >
          <ElIcon><Plus /></ElIcon>
        </ElButton>
      </header>

      <div v-if="activePane === 'agents'" class="sidebar__toolbar">
        <button class="sidebar__ghost-button" type="button" @click="expandAllAgentSections">
          {{ t("conversation.expandAll") }}
        </button>
        <button class="sidebar__ghost-button" type="button" @click="collapseAllAgentSections">
          {{ t("conversation.collapseAll") }}
        </button>
      </div>

      <section class="sidebar__list">
        <template v-if="activePane === 'recent'">
          <div v-if="recentLoading" class="sidebar__empty">{{ t("conversation.loadingConversations") }}</div>
          <div v-else-if="!filteredRecentConversations.length" class="sidebar__empty">{{ t("conversation.noMatchingConversations") }}</div>
          <button
            v-for="item in filteredRecentConversations"
            :key="item.id"
            class="sidebar__item"
            :class="{
              'sidebar__item--active': currentConversationId === item.id,
              'sidebar__item--group': item.type === 'group',
              'sidebar__item--direct': item.type === 'direct',
            }"
            type="button"
            @contextmenu.prevent="openRecentConversationMenu($event, item.id)"
            @click="openConversation(item.id)"
          >
            <div class="sidebar__item-body">
              <div v-if="item.type === 'direct'" class="sidebar__recent-direct">
                <div class="sidebar__row sidebar__row--recent-direct">
                  <div
                    class="sidebar__item-title sidebar__item-title--recent sidebar__item-title--instance"
                    :title="item.instance_name ?? conversationDisplayName(item)"
                  >
                    {{ item.instance_name ?? conversationDisplayName(item) }}
                  </div>
                  <div class="sidebar__meta sidebar__meta--recent">
                    <span class="sidebar__conversation-kind">
                      {{ conversationKindLabel(item.type) }}
                    </span>
                    <span class="sidebar__item-time">
                      {{ item.last_message_at ? formatRelativeTime(item.last_message_at) : "" }}
                    </span>
                  </div>
                </div>
                <div
                  class="sidebar__item-title sidebar__item-title--recent sidebar__item-title--agent"
                  :title="item.agent_display_name ?? conversationDisplayName(item)"
                >
                  {{ item.agent_display_name ?? conversationDisplayName(item) }}
                </div>
              </div>
              <div v-else class="sidebar__row">
                <div
                  class="sidebar__item-title sidebar__item-title--recent"
                  :title="conversationDisplayName(item)"
                >
                  {{ conversationDisplayName(item) }}
                </div>
                <div class="sidebar__meta sidebar__meta--recent">
                  <span
                    class="sidebar__conversation-kind"
                    :class="{
                      'sidebar__conversation-kind--group': item.type === 'group',
                      'sidebar__conversation-kind--agent-dialogue': item.type === 'agent_dialogue',
                    }"
                  >
                    {{ conversationKindLabel(item.type) }}
                  </span>
                  <span class="sidebar__item-time">
                    {{ item.last_message_at ? formatRelativeTime(item.last_message_at) : "" }}
                  </span>
                </div>
              </div>
              <div class="sidebar__item-preview">{{ item.last_message_preview ?? t("conversation.noMessages") }}</div>
            </div>
          </button>
        </template>

        <template v-else-if="activePane === 'agents'">
          <div v-if="!filteredAgentGroups.length" class="sidebar__empty">{{ t("conversation.noMatchingAgents") }}</div>
          <ElCollapse
            v-else
            class="sidebar__agent-groups"
            :model-value="visibleExpandedAgentSections"
            expand-icon-position="left"
            @update:model-value="handleAgentSectionsChange"
          >
            <ElCollapseItem
              v-for="group in filteredAgentGroups"
              :key="group.instanceId"
              :name="String(group.instanceId)"
              class="sidebar__agent-group"
            >
              <template #title>
                <div class="sidebar__agent-group-title">
                  <span class="sidebar__agent-group-name">{{ group.instanceName }}</span>
                  <span class="sidebar__agent-group-count">{{ group.agents.length }}</span>
                </div>
              </template>

              <div class="sidebar__agent-children">
                <button
                  v-for="item in group.agents"
                  :key="`${item.instanceId}:${item.agentId}`"
                  class="sidebar__item sidebar__item--agent"
                  :class="{
                    'sidebar__item--active':
                      currentConversation?.type === 'direct'
                      && currentConversation.direct_instance_id === item.instanceId
                      && currentConversation.direct_agent_id === item.agentId,
                  }"
                  type="button"
                  @click="openDirect(item.instanceId, item.agentId)"
                >
                  <div class="sidebar__item-body">
                    <div class="sidebar__item-title" :title="item.displayName">{{ item.displayName }}</div>
                    <div class="sidebar__item-preview">{{ item.roleName || t("conversation.roleUnset") }} · {{ item.csId }}</div>
                  </div>
                </button>
              </div>
            </ElCollapseItem>
          </ElCollapse>
        </template>

        <template v-else>
          <div v-if="!filteredGroups.length" class="sidebar__empty">{{ t("conversation.noMatchingGroups") }}</div>
          <button
            v-for="group in filteredGroups"
            :key="group.id"
            class="sidebar__item"
            type="button"
            @click="openGroup(group.id)"
          >
            <div class="sidebar__item-body">
              <div class="sidebar__row">
                <div class="sidebar__item-title" :title="group.name">{{ group.name }}</div>
                <button class="sidebar__ghost-button" type="button" @click.stop="manageGroup(group.id)">
                  {{ t("conversation.manage") }}
                </button>
              </div>
              <div class="sidebar__item-preview">{{ t("conversation.membersCount", { count: group.members.length }) }}</div>
            </div>
          </button>
        </template>
      </section>
    </section>

    <teleport to="body">
      <div
        v-if="recentMenu.visible"
        class="sidebar__context-menu"
        :style="{ left: `${recentMenu.x}px`, top: `${recentMenu.y}px` }"
      >
        <button class="sidebar__context-menu-item" type="button" @click="hideRecentConversation">
          {{ t("conversation.removeFromRecent") }}
        </button>
      </div>
    </teleport>

    <GroupCreateDrawer
      v-model:visible="createDrawerVisible"
      :instances="instances"
      :submitting="groupStore.creating"
      @submit="handleCreateGroup"
    />

    <AgentDialogueCreateDrawer
      v-model:visible="agentDialogueDrawerVisible"
      :agent-options="agentOptions"
      @submit="handleCreateAgentDialogue"
    />

    <GroupMemberDrawer
      v-model:visible="memberDrawerVisible"
      :group="groupStore.currentGroupDetail"
      :instances="instances"
      :saving="groupStore.savingMembers"
      @add-members="handleAddMembers"
      @delete-group="handleDeleteGroup"
      @remove-member="handleRemoveMember"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 这个侧栏把“最近会话 + 通讯录 + 群组”统一放在一起。
 *
 * 第一阶段先保证消息页能直接用；
 * 后面如果要做更复杂的最近/所有切换、搜索、未读状态，
 * 可以在这个组件内部继续扩展，而不用替换整个左侧栏。
 */
import { Collection, ChatRound, Plus, RefreshRight, User } from "@element-plus/icons-vue";
import type { CollapseModelValue } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import GroupCreateDrawer from "@/components/group/GroupCreateDrawer.vue";
import GroupMemberDrawer from "@/components/group/GroupMemberDrawer.vue";
import AgentDialogueCreateDrawer from "@/components/conversation/AgentDialogueCreateDrawer.vue";
import { useI18n } from "@/composables/useI18n";
import { useAddressBookStore } from "@/stores/addressBook";
import { useConversationStore } from "@/stores/conversation";
import { useGroupStore } from "@/stores/group";
import type { ConversationListItemApi } from "@/types/api/conversation";
import { parseServerDateTime } from "@/utils/datetime";

const router = useRouter();
const addressBookStore = useAddressBookStore();
const conversationStore = useConversationStore();
const groupStore = useGroupStore();
const createDrawerVisible = ref(false);
const agentDialogueDrawerVisible = ref(false);
const memberDrawerVisible = ref(false);
const searchQuery = ref("");
const activePane = ref<"recent" | "agents" | "groups">("recent");
const recentMenu = ref({
    visible: false,
    x: 0,
    y: 0,
    conversationId: null as number | null,
});
const { t } = useI18n();

const instances = computed(() => addressBookStore.instances);
const groups = computed(() => addressBookStore.groups);
const recentConversations = computed(() => addressBookStore.visibleRecentConversations);
const recentLoading = computed(() => addressBookStore.recentLoading);
const currentConversationId = computed(() => conversationStore.currentConversationId);
const currentConversation = computed(() => conversationStore.currentConversation);
const navItems = [
    { key: "recent", labelKey: "conversation.recentContacts", icon: ChatRound },
    { key: "agents", labelKey: "conversation.allContacts", icon: User },
    { key: "groups", labelKey: "conversation.groups", icon: Collection },
] as const;
const keyword = computed(() => searchQuery.value.trim().toLowerCase());
const filteredRecentConversations = computed(() =>
    recentConversations.value.filter((item) => {
        if (!keyword.value) {
            return true;
        }
        return (
            item.display_title.toLowerCase().includes(keyword.value)
            || (item.last_message_preview ?? "").toLowerCase().includes(keyword.value)
        );
    }),
);
const filteredAgentGroups = computed(() =>
    instances.value
        .map((instance) => {
            const enabledAgents = instance.agents.filter((agent) => agent.enabled);
            const instanceMatched = keyword.value ? instance.name.toLowerCase().includes(keyword.value) : true;
            const agentMatched = enabledAgents.some((agent) =>
                agent.display_name.toLowerCase().includes(keyword.value)
                || (agent.role_name ?? "").toLowerCase().includes(keyword.value)
                || agent.cs_id.toLowerCase().includes(keyword.value),
            );
            if (!enabledAgents.length) {
                return null;
            }
            if (keyword.value && !instanceMatched && !agentMatched) {
                return null;
            }
            return {
                instanceId: instance.id,
                instanceName: instance.name,
                agents: enabledAgents.map((agent) => ({
                    instanceId: instance.id,
                    instanceName: instance.name,
                    agentId: agent.id,
                    displayName: agent.display_name,
                    roleName: agent.role_name,
                    csId: agent.cs_id,
                })),
            };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
);
const expandedAgentSections = ref<string[]>([]);
const visibleExpandedAgentSections = computed(() =>
    keyword.value ? filteredAgentGroups.value.map((group) => String(group.instanceId)) : expandedAgentSections.value,
);
const filteredGroups = computed(() =>
    groups.value.filter((group) => {
        if (!keyword.value) {
            return true;
        }
        return (
            group.name.toLowerCase().includes(keyword.value)
            || (group.description ?? "").toLowerCase().includes(keyword.value)
        );
    }),
);
const agentOptions = computed(() =>
    instances.value.flatMap((instance) =>
        instance.agents
            .filter((agent) => agent.enabled)
            .map((agent) => ({
                value: agent.id,
                label: `${agent.display_name} / ${instance.name}`,
            })),
    ),
);

onMounted(async () => {
    if (!addressBookStore.addressBook) {
        await addressBookStore.loadAll();
    }
    window.addEventListener("click", closeRecentConversationMenu);
    window.addEventListener("resize", closeRecentConversationMenu);
    window.addEventListener("blur", closeRecentConversationMenu);
    expandedAgentSections.value = filteredAgentGroups.value.map((group) => String(group.instanceId));
});

onBeforeUnmount(() => {
    window.removeEventListener("click", closeRecentConversationMenu);
    window.removeEventListener("resize", closeRecentConversationMenu);
    window.removeEventListener("blur", closeRecentConversationMenu);
});

async function openDirect(instanceId: number, agentId: number) {
    const currentConversation = conversationStore.currentConversation;
    if (
        currentConversation
        && currentConversation.type === "direct"
        && currentConversation.direct_instance_id === instanceId
        && currentConversation.direct_agent_id === agentId
    ) {
        return;
    }
    await conversationStore.openDirectConversation(instanceId, agentId);
    if (conversationStore.currentConversationId) {
        await router.push(`/messages/conversation/${conversationStore.currentConversationId}`);
    }
}

async function openGroup(groupId: number) {
    const currentConversation = conversationStore.currentConversation;
    if (
        currentConversation
        && currentConversation.type === "group"
        && currentConversation.group_id === groupId
    ) {
        return;
    }
    await conversationStore.openGroupConversation(groupId);
    if (conversationStore.currentConversationId) {
        await router.push(`/messages/conversation/${conversationStore.currentConversationId}`);
    }
}

async function openConversation(conversationId: number) {
    closeRecentConversationMenu();
    if (conversationStore.currentConversationId === conversationId) {
        return;
    }
    await conversationStore.openConversation(conversationId);
    await router.push(`/messages/conversation/${conversationId}`);
}

function openRecentConversationMenu(event: MouseEvent, conversationId: number) {
    recentMenu.value = {
        visible: true,
        x: event.clientX,
        y: event.clientY,
        conversationId,
    };
}

function closeRecentConversationMenu() {
    if (!recentMenu.value.visible) {
        return;
    }
    recentMenu.value = {
        visible: false,
        x: 0,
        y: 0,
        conversationId: null,
    };
}

function hideRecentConversation() {
    if (recentMenu.value.conversationId === null) {
        closeRecentConversationMenu();
        return;
    }
    addressBookStore.hideRecentConversation(recentMenu.value.conversationId);
    closeRecentConversationMenu();
    ElMessage.success(t("conversation.removedFromRecent"));
}

async function handleCreateGroup(payload: {
    name: string;
    description: string;
    members: Array<{ instance_id: number; agent_id: number }>;
}) {
    const group = await groupStore.createNewGroup(payload);
    createDrawerVisible.value = false;
    ElMessage.success(t("conversation.creatingGroupSuccess", { name: group.name }));
    await openGroup(group.id);
}

async function manageGroup(groupId: number) {
    await groupStore.loadGroupDetail(groupId);
    groupStore.startEditing(groupId);
    memberDrawerVisible.value = true;
}

async function handleAddMembers(payload: Array<{ instance_id: number; agent_id: number }>) {
    if (!groupStore.currentGroupDetail) {
        return;
    }
    await groupStore.appendMembers(groupStore.currentGroupDetail.id, payload);
    ElMessage.success(t("conversation.groupMembersUpdated"));
}

async function handleRemoveMember(memberId: number) {
    if (!groupStore.currentGroupDetail) {
        return;
    }
    await groupStore.removeMember(groupStore.currentGroupDetail.id, memberId);
    ElMessage.success(t("conversation.groupMemberRemoved"));
}

async function handleDeleteGroup() {
    const currentGroup = groupStore.currentGroupDetail;
    if (!currentGroup) {
        return;
    }
    const confirmed = window.confirm(t("conversation.deleteGroupConfirm", { name: currentGroup.name }));
    if (!confirmed) {
        return;
    }

    const deletingOpenConversation =
        currentConversation.value?.type === "group" && currentConversation.value.group_id === currentGroup.id;

    await groupStore.deleteCurrentGroup(currentGroup.id);
    memberDrawerVisible.value = false;
    ElMessage.success(t("conversation.groupDeleted"));

    if (deletingOpenConversation) {
        conversationStore.currentConversationId = null;
        conversationStore.currentConversation = null;
        conversationStore.messages = [];
        conversationStore.dispatches = [];
        groupStore.currentGroupDetail = null;
        await router.replace("/messages");
    }
}

async function handleCreateAgentDialogue(payload: {
    source_agent_id: number;
    target_agent_id: number;
    topic: string;
    window_seconds: number;
    soft_message_limit: number;
    hard_message_limit: number;
}) {
    const dialogue = await conversationStore.createAndOpenAgentDialogue(payload);
    agentDialogueDrawerVisible.value = false;
    ElMessage.success(t("conversation.agentDialogueCreated"));
    await router.push(`/messages/conversation/${dialogue.conversation_id}`);
}

function normalizeMessageStatus(status: string) {
    if (status === "completed") {
        return "completed";
    }
    if (status === "failed") {
        return "failed";
    }
    if (status === "streaming") {
        return "streaming";
    }
    return "pending";
}

function messageStatusLabel(status: string) {
    if (status === "completed") {
        return t("conversation.statusCompleted");
    }
    if (status === "failed") {
        return t("conversation.statusFailed");
    }
    if (status === "streaming") {
        return t("conversation.statusStreaming");
    }
    if (status === "accepted") {
        return t("conversation.statusAccepted");
    }
    return t("conversation.statusPending");
}

function avatarText(value: string) {
    return value
        .replace(/\s+/g, "")
        .slice(0, 2)
        .toUpperCase();
}

function conversationDisplayName(item: ConversationListItemApi) {
    if (item.type === "direct" && item.agent_display_name && item.instance_name) {
        return `${item.agent_display_name} / ${item.instance_name}`;
    }
    return item.display_title;
}

function conversationKindLabel(type: string) {
    if (type === "group") {
        return t("conversation.group");
    }
    if (type === "agent_dialogue") {
        return t("conversation.agentDialogue");
    }
    return t("conversation.direct");
}

function cyclePane() {
    const keys: Array<"recent" | "agents" | "groups"> = ["recent", "agents", "groups"];
    const index = keys.indexOf(activePane.value);
    activePane.value = keys[(index + 1) % keys.length];
}

async function refreshAgentsPane() {
    await addressBookStore.loadAddressBook();
}

function handleAgentSectionsChange(value: CollapseModelValue) {
    expandedAgentSections.value = (Array.isArray(value) ? value : [value]).map((item) => String(item));
}

function expandAllAgentSections() {
    expandedAgentSections.value = filteredAgentGroups.value.map((group) => String(group.instanceId));
}

function collapseAllAgentSections() {
    expandedAgentSections.value = [];
}

function formatRelativeTime(value: string) {
    const date = parseServerDateTime(value);
    const diffMs = Date.now() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    if (diffMinutes < 1) {
        return "刚刚";
    }
    if (diffMinutes < 60) {
        return `${diffMinutes} 分钟前`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return `${diffHours} 小时前`;
    }
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
        return `${diffDays} 天前`;
    }
    return new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
    }).format(date);
}

watch(
    filteredAgentGroups,
    (groups) => {
        const available = new Set(groups.map((group) => String(group.instanceId)));
        expandedAgentSections.value = expandedAgentSections.value.filter((name) => available.has(name));
        if (!expandedAgentSections.value.length && !keyword.value) {
            expandedAgentSections.value = groups.map((group) => String(group.instanceId));
        }
    },
    { immediate: true },
);
</script>

<style scoped>
.sidebar {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

.sidebar__rail {
  display: grid;
  align-content: start;
  gap: 12px;
  padding: 14px 10px;
  border-right: 1px solid #e5e5e8;
  background: #ededf0;
}

.sidebar__rail-item {
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 16px;
  background: transparent;
  color: #7d828b;
  cursor: pointer;
  font-size: 0.95rem;
  font-weight: 700;
}

.sidebar__rail-item--active {
  background: #ffffff;
  color: #2b3038;
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.06);
}

.sidebar__panel {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-height: 0;
  background: #f7f7f8;
}

.sidebar__panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: var(--page-shell-pad-top) 14px 12px;
}

.sidebar__search {
  flex: 1;
}

.sidebar__search-input {
  width: 100%;
}

.sidebar__plus {
  flex-shrink: 0;
}

.sidebar__plus--muted {
  --el-button-bg-color: #ffffff;
  --el-button-border-color: #d5d7db;
  --el-button-hover-bg-color: #f3f4f6;
  --el-button-hover-border-color: #cfd3d8;
  --el-button-text-color: #6d737c;
}

.sidebar__toolbar {
  display: flex;
  gap: 8px;
  padding: 0 14px 10px;
}

.sidebar__list {
  display: grid;
  align-content: start;
  gap: 2px;
  min-height: 0;
  padding: 0 8px var(--page-shell-pad-bottom);
  overflow: auto;
}

.sidebar__context-menu {
  position: fixed;
  z-index: 2000;
  min-width: 168px;
  padding: 6px;
  border: 1px solid #dfdfe3;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.16);
}

.sidebar__context-menu-item {
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  font-size: 0.92rem;
}

.sidebar__context-menu-item:hover {
  background: #f4f4f7;
}

.sidebar__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: 14px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.18s ease, box-shadow 0.18s ease;
}

.sidebar__item:hover {
  background: rgba(255, 255, 255, 0.82);
}

.sidebar__item--active {
  background: #ffffff;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.05);
}

.sidebar__item-body {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.sidebar__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
}

.sidebar__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sidebar__item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9rem;
  font-weight: 700;
}

.sidebar__item-title--recent {
  white-space: nowrap;
}

.sidebar__item-title--instance {
  color: var(--el-color-primary);
}

.sidebar__item-title--agent {
  color: var(--color-text-primary);
  font-size: 0.92rem;
  font-weight: 600;
}

.sidebar__recent-direct {
  display: grid;
  gap: 2px;
}

.sidebar__row--recent-direct {
  align-items: center;
}

.sidebar__item--agent {
  padding: 10px 12px;
  border: 1px solid transparent;
  background: #ffffff;
}

.sidebar__agent-children .sidebar__item--active {
  border-color: #c8d4f6;
  background: #eef3ff;
  box-shadow: inset 0 0 0 1px rgba(108, 138, 214, 0.12);
}

.sidebar__agent-children .sidebar__item--active .sidebar__item-title {
  color: #24438a;
}

.sidebar__agent-children .sidebar__item--active .sidebar__item-preview {
  color: #5b6f9e;
}

.sidebar__item-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #9499a2;
  font-size: 0.84rem;
}

.sidebar__item-time {
  flex: 0 0 auto;
  color: #9ca1aa;
  font-size: 0.7rem;
  line-height: 1.3;
  white-space: nowrap;
}

.sidebar__conversation-kind {
  color: #5a6f96;
  font-size: 0.66rem;
  line-height: 1.5;
  font-weight: 700;
}

.sidebar__conversation-kind--group {
  color: #9a5757;
}

.sidebar__conversation-kind--agent-dialogue {
  color: #0d7d73;
}

.sidebar__meta--recent .sidebar__conversation-kind,
.sidebar__meta--recent .sidebar__item-time {
  flex: 0 0 auto;
}

.sidebar__badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-bg-soft);
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.sidebar__badge--muted {
  opacity: 0.7;
}

.sidebar__ghost-button {
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: #ffffff;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.sidebar__ghost-button {
  padding: 4px 8px;
  font-size: 0.74rem;
}

.sidebar__agent-groups {
  display: grid;
  gap: 12px;
}

.sidebar__agent-group {
  border: 1px solid #e5e5e8;
  border-radius: 18px;
  overflow: hidden;
  background: #f3f4f7;
}

.sidebar__agent-group :deep(.el-collapse-item__header) {
  padding: 0 16px;
  border-bottom: none;
  background: #f3f4f7;
  min-height: 54px;
}

.sidebar__agent-group :deep(.el-collapse-item__wrap) {
  border-bottom: none;
}

.sidebar__agent-group :deep(.el-collapse-item__content) {
  padding-bottom: 0;
}

.sidebar__agent-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}

.sidebar__agent-group-name {
  font-size: 1rem;
  font-weight: 800;
  color: #2b3038;
}

.sidebar__agent-group-count {
  color: #8d93a0;
  font-size: 0.82rem;
  font-weight: 600;
}

.sidebar__agent-children {
  display: grid;
  gap: 4px;
  padding: 0 10px 10px;
  background: #ffffff;
}

.sidebar__empty {
  padding: 18px 14px;
  color: var(--color-text-secondary);
  font-size: 0.9rem;
  line-height: 1.6;
}

@media (max-width: 960px) {
  .sidebar {
    grid-template-columns: 48px minmax(0, 1fr);
  }
}
</style>
