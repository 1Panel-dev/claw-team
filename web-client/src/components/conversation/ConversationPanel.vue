<template>
  <div class="panel">
    <header class="panel__header">
      <div class="panel__header-main">
        <h1 class="panel__title">{{ title }}</h1>
      </div>
    </header>

    <div v-if="errorMessage" class="panel__error">{{ errorMessage }}</div>
    <MessageList
      :messages="messages"
      :loading="loading"
      :show-typing-indicator="showTypingIndicator"
    />
    <MessageComposer
      :sending="sending"
      :is-group="isGroupConversation"
      :mention-options="mentionOptions"
      @send="handleSend"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * ConversationPanel 是聊天主区域。
 *
 * 它只组合消息列表和输入框，不把轮询和数据请求直接写死在这里，
 * 这样后面如果要增加右侧详情栏、文件面板或任务面板，会更容易拆。
 */
import { computed } from "vue";

import MessageComposer from "@/components/conversation/MessageComposer.vue";
import MessageList from "@/components/conversation/MessageList.vue";
import { useAddressBookStore } from "@/stores/addressBook";
import { useConversationStore } from "@/stores/conversation";
import { useGroupStore } from "@/stores/group";

defineProps<{
    loading: boolean;
    errorMessage: string | null;
}>();

const conversationStore = useConversationStore();
const groupStore = useGroupStore();
const addressBookStore = useAddressBookStore();

const messages = computed(() => conversationStore.messages);
const dispatches = computed(() => conversationStore.dispatches);
const sending = computed(() => conversationStore.sending);
const title = computed(() => {
    const conversation = conversationStore.currentConversation;
    if (!conversation) {
        return "请选择一个会话";
    }
    if (conversation.type === "direct" && conversation.direct_instance_id && conversation.direct_agent_id) {
        const instance = addressBookStore.instances.find((item) => item.id === conversation.direct_instance_id);
        const agent = instance?.agents.find((item) => item.id === conversation.direct_agent_id);
        if (instance && agent) {
            return `${agent.display_name} / ${instance.name}`;
        }
    }
    return conversation.title ?? "请选择一个会话";
});
const isGroupConversation = computed(() => conversationStore.currentConversation?.type === "group");
const mentionOptions = computed(() =>
    (groupStore.currentGroupDetail?.members ?? []).map((member) => ({
        value: `${member.instance_id}:${member.agent_id}`,
        label: `${member.display_name} / ${member.instance_name}`,
    })),
);
const showTypingIndicator = computed(() =>
    dispatches.value.some((item) => item.status === "accepted" || item.status === "streaming"),
);

async function handleSend(payload: {
    content: string;
    mentions: string[];
    useDedicatedDirectSession: boolean;
}) {
    await conversationStore.sendMessage(payload.content, payload.mentions, payload.useDedicatedDirectSession);
}
</script>

<style scoped>
.panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.panel__header {
  padding: var(--page-shell-pad-top) var(--page-shell-pad-x) 14px;
  border-bottom: 1px solid var(--color-border);
  background: #ffffff;
}

.panel__header-main {
  display: grid;
  gap: 0;
}

.panel__title {
  margin: 0;
  font-size: 1.14rem;
  font-weight: 700;
  line-height: 1.3;
}

.panel__error {
  margin: var(--page-shell-section-gap) var(--page-shell-pad-x) 0;
  padding: var(--space-3);
  border: 1px solid color-mix(in srgb, var(--color-danger) 28%, var(--color-border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-danger) 8%, var(--color-bg-app));
  color: var(--color-text-primary);
}

@media (max-width: 960px) {
  .panel__header {
    padding: 16px;
  }
}
</style>
