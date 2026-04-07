<template>
  <div class="panel">
    <header class="panel__header">
      <div class="panel__header-main">
        <div class="panel__title-row">
          <h1 class="panel__title">{{ title }}</h1>
          <span v-if="directConversationCsId" class="panel__cs-id">{{ directConversationCsId }}</span>
        </div>
        <AgentDialogueToolbar
          v-if="currentAgentDialogue"
          :dialogue="currentAgentDialogue"
          :messages="messages"
          @pause="pauseDialogue"
          @resume="resumeDialogue"
          @stop="stopDialogue"
        />
      </div>
    </header>

    <div v-if="errorMessage" class="panel__error">{{ errorMessage }}</div>
    <MessageList
      :key="conversationStore.currentConversationId ?? 'empty'"
      :messages="messages"
      :loading="loading"
      :has-more-messages="conversationStore.hasMoreMessages"
      :loading-older-messages="conversationStore.loadingOlderMessages"
      :show-typing-indicator="showTypingIndicator"
      :sender-meta-map="senderMetaMap"
      @load-older="handleLoadOlderMessages"
    />
    <MessageComposer
      :sending="sending"
      :is-group="isGroupConversation"
      :is-agent-dialogue="isAgentDialogueConversation"
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

import AgentDialogueToolbar from "@/components/conversation/AgentDialogueToolbar.vue";
import MessageComposer from "@/components/conversation/MessageComposer.vue";
import MessageList from "@/components/conversation/MessageList.vue";
import { useI18n } from "@/composables/useI18n";
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
const { t } = useI18n();

const messages = computed(() => conversationStore.messages);
const currentAgentDialogue = computed(() => conversationStore.currentAgentDialogue);
const dispatches = computed(() => conversationStore.dispatches);
const sending = computed(() => conversationStore.sending);
const title = computed(() => {
    const conversation = conversationStore.currentConversation;
    if (!conversation) {
        return t("conversation.selectConversation");
    }
    if (conversation.type === "agent_dialogue" && currentAgentDialogue.value) {
        const sourceLabel = currentAgentDialogue.value.source_agent_instance_name
            ? `${currentAgentDialogue.value.source_agent_display_name} / ${currentAgentDialogue.value.source_agent_instance_name}`
            : currentAgentDialogue.value.source_agent_display_name;
        const targetLabel = currentAgentDialogue.value.target_agent_instance_name
            ? `${currentAgentDialogue.value.target_agent_display_name} / ${currentAgentDialogue.value.target_agent_instance_name}`
            : currentAgentDialogue.value.target_agent_display_name;
        return `${sourceLabel} ↔ ${targetLabel}`;
    }
    if (conversation.type === "direct" && conversation.direct_instance_id && conversation.direct_agent_id) {
        const instance = addressBookStore.instances.find((item) => item.id === conversation.direct_instance_id);
        const agent = instance?.agents.find((item) => item.id === conversation.direct_agent_id);
        if (instance && agent) {
            return `${agent.display_name} / ${instance.name}`;
        }
    }
    return conversation.title ?? t("conversation.selectConversation");
});
const directConversationCsId = computed(() => {
    const conversation = conversationStore.currentConversation;
    if (!conversation || conversation.type !== "direct" || !conversation.direct_instance_id || !conversation.direct_agent_id) {
        return "";
    }
    const instance = addressBookStore.instances.find((item) => item.id === conversation.direct_instance_id);
    const agent = instance?.agents.find((item) => item.id === conversation.direct_agent_id);
    return agent?.cs_id ?? "";
});
const isGroupConversation = computed(() => conversationStore.currentConversation?.type === "group");
const isAgentDialogueConversation = computed(() => conversationStore.currentConversation?.type === "agent_dialogue");
const mentionOptions = computed(() =>
    (groupStore.currentGroupDetail?.members ?? []).map((member) => ({
        value: `${member.instance_id}:${member.agent_id}`,
        label: `${member.display_name} / ${member.instance_name}`,
    })),
);
const showTypingIndicator = computed(() =>
    dispatches.value.some((item) => item.status === "accepted" || item.status === "streaming"),
);
type SenderMeta = {
    roleName?: string | null;
    csId?: string | null;
    instanceName?: string | null;
};

const senderMetaMap = computed<Record<string, SenderMeta>>(() => {
    const map: Record<string, SenderMeta> = {};

    const assignMeta = (label: string | null | undefined, meta: SenderMeta) => {
        const normalizedLabel = label?.trim();
        const normalizedCsId = meta.csId?.trim();
        const normalizedMeta: SenderMeta = {
            roleName: meta.roleName ?? null,
            csId: normalizedCsId ?? null,
            instanceName: meta.instanceName ?? null,
        };
        if (normalizedCsId) {
            map[normalizedCsId] = normalizedMeta;
        }
        if (normalizedLabel) {
            map[normalizedLabel] = normalizedMeta;
        }
    };

    // 优先使用当前群详情，避免群成员展示时漏掉角色名。
    for (const member of groupStore.currentGroupDetail?.members ?? []) {
        const instance = addressBookStore.instances.find((item) => item.id === member.instance_id);
        const agent = instance?.agents.find((item) => item.id === member.agent_id);
        assignMeta(member.display_name, {
            roleName: member.role_name,
            csId: agent?.cs_id ?? null,
            instanceName: member.instance_name,
        });
    }

    if (currentAgentDialogue.value) {
        const sourceLabel = currentAgentDialogue.value.source_agent_display_name.trim();
        if (sourceLabel) {
            assignMeta(sourceLabel, {
                roleName: map[currentAgentDialogue.value.source_agent_cs_id ?? ""]?.roleName ?? map[sourceLabel]?.roleName ?? null,
                csId: currentAgentDialogue.value.source_agent_cs_id,
                instanceName: currentAgentDialogue.value.source_agent_instance_name ?? null,
            });
        }
        const targetLabel = currentAgentDialogue.value.target_agent_display_name.trim();
        if (targetLabel) {
            assignMeta(targetLabel, {
                roleName: map[currentAgentDialogue.value.target_agent_cs_id ?? ""]?.roleName ?? map[targetLabel]?.roleName ?? null,
                csId: currentAgentDialogue.value.target_agent_cs_id,
                instanceName: currentAgentDialogue.value.target_agent_instance_name ?? null,
            });
        }
    }

    // 再补一层通讯录里的实例 Agent，覆盖单聊和普通对话展示。
    for (const instance of addressBookStore.instances) {
        for (const agent of instance.agents) {
            assignMeta(agent.display_name, { roleName: agent.role_name, csId: agent.cs_id, instanceName: instance.name });
        }
    }

    return map;
});

async function handleSend(payload: {
    content: string;
    mentions: string[];
    useDedicatedDirectSession: boolean;
}) {
    if (isAgentDialogueConversation.value && currentAgentDialogue.value) {
        await conversationStore.sendAgentDialogueIntervention(currentAgentDialogue.value.id, payload.content);
        return;
    }
    await conversationStore.sendMessage(payload.content, payload.mentions, payload.useDedicatedDirectSession);
}

async function pauseDialogue() {
    if (!currentAgentDialogue.value) {
        return;
    }
    await conversationStore.pauseCurrentAgentDialogue(currentAgentDialogue.value.id);
}

async function resumeDialogue() {
    if (!currentAgentDialogue.value) {
        return;
    }
    await conversationStore.resumeCurrentAgentDialogue(currentAgentDialogue.value.id);
}

async function stopDialogue() {
    if (!currentAgentDialogue.value) {
        return;
    }
    await conversationStore.stopCurrentAgentDialogue(currentAgentDialogue.value.id);
}

async function handleLoadOlderMessages() {
    await conversationStore.loadOlderMessages();
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

.panel__title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.panel__title {
  margin: 0;
  font-size: 1.14rem;
  font-weight: 700;
  line-height: 1.3;
}

.panel__cs-id {
  flex: 0 0 auto;
  padding: 3px 10px;
  border: 1px solid #d9dde6;
  border-radius: 999px;
  background: #f7f8fb;
  color: #64748b;
  font-size: 0.84rem;
  font-weight: 600;
  line-height: 1;
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
