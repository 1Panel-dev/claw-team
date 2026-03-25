<template>
  <div class="page-shell page-shell--conversation">
    <div class="messages-shell">
      <aside class="messages-shell__sidebar">
        <ConversationSidebar />
      </aside>
      <section class="messages-shell__content">
        <ConversationPanel
          v-if="conversationStore.currentConversationId"
          :loading="conversationStore.loading"
          :error-message="conversationStore.lastErrorMessage"
        />
        <EmptyStateCard
          v-else
          :eyebrow="t('messagesPage.eyebrow')"
          :title="t('messagesPage.title')"
          :description="t('messagesPage.description')"
        />
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 消息页是第一阶段真正落地的核心页面。
 *
 * 它尽量只承担页面级组织职责，
 * 真正的数据拉取、轮询和状态管理都放在 store / composable 中。
 */
import { onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useRouter } from "vue-router";

import EmptyStateCard from "@/components/common/EmptyStateCard.vue";
import ConversationPanel from "@/components/conversation/ConversationPanel.vue";
import ConversationSidebar from "@/components/conversation/ConversationSidebar.vue";
import { useI18n } from "@/composables/useI18n";
import { useConversationTransport } from "@/composables/useConversationTransport";
import { useAddressBookStore } from "@/stores/addressBook";
import { useConversationStore } from "@/stores/conversation";
import { useGroupStore } from "@/stores/group";

const route = useRoute();
const router = useRouter();
const conversationStore = useConversationStore();
const addressBookStore = useAddressBookStore();
const groupStore = useGroupStore();
const transport = useConversationTransport();
const initialized = ref(false);
const { t } = useI18n();

onMounted(async () => {
    try {
        if (!addressBookStore.addressBook || !addressBookStore.visibleRecentConversations.length) {
            await addressBookStore.loadAll();
        }
        initialized.value = true;
        await handleRouteConversation(route.params.conversationId);
    } catch (error) {
        console.error("failed to initialize messages page", error);
    }
});

watch(
    () => conversationStore.currentConversationId,
    async (value) => {
        const routeConversationId = Number(route.params.conversationId);
        if (!value || routeConversationId === value) {
            return;
        }
        await router.replace(`/messages/conversation/${value}`);
    },
);

watch(
    () => route.params.conversationId,
    async (value) => {
        await handleRouteConversation(value);
    },
    { immediate: true },
);

async function handleRouteConversation(value: unknown) {
    if (!initialized.value) {
        return;
    }
    if (!value) {
        await ensureConversationSelection();
        return;
    }
    const conversationId = Number(value);
    if (Number.isFinite(conversationId) && conversationStore.currentConversationId !== conversationId) {
        try {
            await conversationStore.openConversation(conversationId);
        } catch (error) {
            conversationStore.currentConversationId = null;
            conversationStore.currentConversation = null;
            await router.replace("/messages");
            await ensureConversationSelection();
            return;
        }
    }
    if (conversationStore.currentConversation?.type === "group" && conversationStore.currentConversation.group_id) {
        await groupStore.loadGroupDetail(conversationStore.currentConversation.group_id);
    } else {
        groupStore.currentGroupDetail = null;
    }
}

async function ensureConversationSelection() {
    if (route.params.conversationId) {
        return;
    }
    // 单用户模式下，消息入口直接回到后端最近一条会话。
    // 不再优先群聊，也不依赖浏览器本地状态，
    // 这样不同访问地址仍然会落到同一份最新对话。
    const targetConversationId = addressBookStore.visibleRecentConversations[0]?.id;

    if (targetConversationId) {
        if (conversationStore.currentConversationId !== targetConversationId) {
            await conversationStore.openConversation(targetConversationId);
        }
        await router.replace(`/messages/conversation/${targetConversationId}`);
    }
}
</script>

<style scoped>
.messages-shell {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  width: 100%;
  min-width: 0;
  min-height: 0;
  border: 1px solid #dddddf;
  border-radius: var(--page-shell-card-radius);
  background: #f5f5f7;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.03);
  overflow: hidden;
}

.messages-shell__sidebar {
  min-width: 0;
  min-height: 0;
  background: #f3f3f5;
  border-right: 1px solid #e9e9ec;
}

.messages-shell__content {
  min-width: 0;
  min-height: 0;
  background: #ffffff;
  overflow: hidden;
}

@media (max-width: 960px) {
  .messages-shell {
    grid-template-columns: 1fr;
  }

  .messages-shell__sidebar {
    display: none;
  }
}
</style>
