<template>
  <div class="sidebar">
    <aside class="sidebar__rail">
      <button
        v-for="item in navItems"
        :key="item.key"
        class="sidebar__rail-item"
        :class="{ 'sidebar__rail-item--active': activePane === item.key }"
        type="button"
        :title="item.label"
        @click="activePane = item.key"
      >
        <span>{{ item.icon }}</span>
      </button>
    </aside>

    <section class="sidebar__panel">
      <header class="sidebar__panel-header">
        <div class="sidebar__search">
          <input
            v-model="searchQuery"
            class="sidebar__search-input"
            type="text"
            placeholder="搜索"
          />
        </div>

        <button
          v-if="activePane === 'groups'"
          class="sidebar__plus"
          type="button"
          title="新建群组"
          @click="createDrawerVisible = true"
        >
          +
        </button>
        <button
          v-else
          class="sidebar__plus sidebar__plus--muted"
          type="button"
          title="切换视图"
          @click="cyclePane"
        >
          +
        </button>
      </header>

      <section class="sidebar__list">
        <template v-if="activePane === 'recent'">
          <div v-if="recentLoading" class="sidebar__empty">正在加载会话...</div>
          <div v-else-if="!filteredRecentConversations.length" class="sidebar__empty">没有匹配的会话。</div>
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
            @click="openConversation(item.id)"
          >
            <div class="sidebar__item-body">
              <div
                class="sidebar__item-title sidebar__item-title--recent"
                :title="conversationDisplayName(item)"
              >
                {{ conversationDisplayName(item) }}
              </div>
              <div class="sidebar__item-preview">{{ item.last_message_preview ?? "暂无消息" }}</div>
              <div class="sidebar__meta sidebar__meta--recent">
                <span class="sidebar__conversation-kind" :class="{ 'sidebar__conversation-kind--group': item.type === 'group' }">
                  {{ item.type === "group" ? "群组" : "单聊" }}
                </span>
                <span class="sidebar__item-time">
                  {{ item.last_message_at ? formatRelativeTime(item.last_message_at) : "" }}
                </span>
              </div>
            </div>
          </button>
        </template>

        <template v-else-if="activePane === 'agents'">
          <div v-if="!filteredAgentRows.length" class="sidebar__empty">没有匹配的 Agent。</div>
          <button
            v-for="item in filteredAgentRows"
            :key="`${item.instanceId}:${item.agentId}`"
            class="sidebar__item"
            type="button"
            @click="openDirect(item.instanceId, item.agentId)"
          >
            <div class="sidebar__item-body">
              <div class="sidebar__row">
                <div class="sidebar__item-title" :title="item.displayName">{{ item.displayName }}</div>
                <span class="sidebar__badge" :class="{ 'sidebar__badge--muted': !item.enabled }">
                  {{ item.enabled ? "启用" : "禁用" }}
                </span>
              </div>
              <div class="sidebar__item-preview">{{ item.instanceName }} · {{ item.roleName || "未设置角色" }}</div>
            </div>
          </button>
        </template>

        <template v-else>
          <div v-if="!filteredGroups.length" class="sidebar__empty">没有匹配的群组。</div>
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
                  管理
                </button>
              </div>
              <div class="sidebar__item-preview">{{ group.members.length }} 位成员</div>
            </div>
          </button>
        </template>
      </section>
    </section>

    <GroupCreateDrawer
      v-model:visible="createDrawerVisible"
      :submitting="groupStore.creating"
      @submit="handleCreateGroup"
    />

    <GroupMemberDrawer
      v-model:visible="memberDrawerVisible"
      :group="groupStore.currentGroupDetail"
      :instances="instances"
      :saving="groupStore.savingMembers"
      @add-members="handleAddMembers"
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
import { computed, onMounted } from "vue";
import ElMessage from "element-plus/es/components/message/index";
import { useRouter } from "vue-router";

import GroupCreateDrawer from "@/components/group/GroupCreateDrawer.vue";
import GroupMemberDrawer from "@/components/group/GroupMemberDrawer.vue";
import { useAddressBookStore } from "@/stores/addressBook";
import { useConversationStore } from "@/stores/conversation";
import { useGroupStore } from "@/stores/group";
import type { ConversationListItemApi } from "@/types/api/conversation";
import { ref } from "vue";

const router = useRouter();
const addressBookStore = useAddressBookStore();
const conversationStore = useConversationStore();
const groupStore = useGroupStore();
const createDrawerVisible = ref(false);
const memberDrawerVisible = ref(false);
const searchQuery = ref("");
const activePane = ref<"recent" | "agents" | "groups">("recent");

const instances = computed(() => addressBookStore.instances);
const groups = computed(() => addressBookStore.groups);
const recentConversations = computed(() => addressBookStore.recentConversations);
const recentLoading = computed(() => addressBookStore.recentLoading);
const currentConversationId = computed(() => conversationStore.currentConversationId);
const navItems = [
    { key: "recent", label: "最近联系人", icon: "◷" },
    { key: "agents", label: "所有联系人", icon: "◉" },
    { key: "groups", label: "群组", icon: "◎" },
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
const filteredAgentRows = computed(() =>
    instances.value.flatMap((instance) =>
        instance.agents
            .filter((agent) => agent.enabled)
            .filter((agent) => {
                if (!keyword.value) {
                    return true;
                }
                return (
                    agent.display_name.toLowerCase().includes(keyword.value)
                    || (agent.role_name ?? "").toLowerCase().includes(keyword.value)
                    || instance.name.toLowerCase().includes(keyword.value)
                );
            })
            .map((agent) => ({
                instanceId: instance.id,
                instanceName: instance.name,
                agentId: agent.id,
                displayName: agent.display_name,
                roleName: agent.role_name,
                enabled: agent.enabled,
            })),
    ),
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

onMounted(async () => {
    if (!addressBookStore.addressBook) {
        await addressBookStore.loadAll();
    }
});

async function openDirect(instanceId: number, agentId: number) {
    await conversationStore.openDirectConversation(instanceId, agentId);
    if (conversationStore.currentConversationId) {
        await router.push(`/messages/conversation/${conversationStore.currentConversationId}`);
    }
}

async function openGroup(groupId: number) {
    await conversationStore.openGroupConversation(groupId);
    if (conversationStore.currentConversationId) {
        await router.push(`/messages/conversation/${conversationStore.currentConversationId}`);
    }
}

async function openConversation(conversationId: number) {
    await conversationStore.openConversation(conversationId);
    await router.push(`/messages/conversation/${conversationId}`);
}

async function handleCreateGroup(payload: { name: string; description: string }) {
    const group = await groupStore.createNewGroup(payload);
    createDrawerVisible.value = false;
    ElMessage.success(`群组“${group.name}”已创建`);
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
    ElMessage.success("群成员已更新");
}

async function handleRemoveMember(memberId: number) {
    if (!groupStore.currentGroupDetail) {
        return;
    }
    await groupStore.removeMember(groupStore.currentGroupDetail.id, memberId);
    ElMessage.success("已移除群成员");
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
        return "已完成";
    }
    if (status === "failed") {
        return "失败";
    }
    if (status === "streaming") {
        return "回复中";
    }
    if (status === "accepted") {
        return "已接受";
    }
    return "处理中";
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

function cyclePane() {
    const keys: Array<"recent" | "agents" | "groups"> = ["recent", "agents", "groups"];
    const index = keys.indexOf(activePane.value);
    activePane.value = keys[(index + 1) % keys.length];
}

function formatRelativeTime(value: string) {
    const date = new Date(value);
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
  grid-template-rows: auto minmax(0, 1fr);
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
  height: 44px;
  padding: 0 16px;
  border: none;
  border-radius: 14px;
  background: #ffffff;
  color: var(--color-text-primary);
  outline: none;
  font-size: 0.98rem;
}

.sidebar__plus {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 42px;
  height: 42px;
  border: 1px solid #d5d7db;
  border-radius: 50%;
  background: #ffffff;
  color: var(--color-text-primary);
  cursor: pointer;
  font-size: 1.45rem;
  line-height: 1;
}

.sidebar__plus--muted {
  color: #6d737c;
}

.sidebar__list {
  display: grid;
  align-content: start;
  gap: 2px;
  min-height: 0;
  padding: 0 8px var(--page-shell-pad-bottom);
  overflow: auto;
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
  font-size: 0.98rem;
  font-weight: 700;
}

.sidebar__item-title--recent {
  white-space: nowrap;
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
