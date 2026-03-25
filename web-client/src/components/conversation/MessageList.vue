<template>
  <div ref="containerRef" class="message-list">
    <div v-if="loading && !messages.length" class="message-list__empty">
      {{ t("conversation.loadingMessages") }}
    </div>
    <div v-else-if="!messages.length" class="message-list__empty">
      {{ t("conversation.emptyMessages") }}
    </div>
    <div
      v-for="message in messageViews"
      :key="message.id"
      class="message-list__item"
      :class="{
        'message-list__item--user': message.senderType === 'user',
      }"
    >
      <div class="message-list__meta">
        <div class="message-list__meta-main">
          <span class="message-list__sender">{{ message.senderLabel }}</span>
          <span
            v-if="message.source === 'webchat'"
            class="message-list__source-badge"
          >
            {{ t("conversation.sourceWebchat") }}
          </span>
        </div>
        <div class="message-list__meta-side">
          <span>{{ formatDateTime(message.updatedAt) }}</span>
          <ElButton
            class="message-list__copy-button"
            text
            @click="copyMessage(message)"
            :title="copiedMessageId === message.id ? t('conversation.copied') : t('conversation.copy')"
            :aria-label="copiedMessageId === message.id ? t('conversation.copied') : t('conversation.copy')"
          >
            <el-icon class="message-list__copy-icon" aria-hidden="true">
              <CopyDocument />
            </el-icon>
          </ElButton>
        </div>
      </div>
      <div class="message-list__parts">
        <template v-for="(part, index) in message.parts" :key="`${message.id}-${part.kind}-${index}`">
          <MessageMarkdown
            v-if="part.kind === 'markdown'"
            class="message-list__content"
            :content="part.content"
          />
          <MessageAttachmentCard
            v-else-if="part.kind === 'attachment'"
            :name="part.name"
            :mime-type="part.mimeType"
            :url="part.url"
          />
          <MessageToolCard
            v-else-if="part.kind === 'tool_card'"
            :title="part.title"
            :status="part.status"
            :summary="part.summary"
          />
        </template>
      </div>
      <div class="message-list__actions">
        <ElButton
          class="message-list__copy-button"
          text
          @click="copyMessage(message)"
          :title="copiedMessageId === message.id ? t('conversation.copied') : t('conversation.copy')"
          :aria-label="copiedMessageId === message.id ? t('conversation.copied') : t('conversation.copy')"
        >
          <el-icon class="message-list__copy-icon" aria-hidden="true">
            <CopyDocument />
          </el-icon>
        </ElButton>
      </div>
    </div>
    <div v-if="showTypingIndicator" class="message-list__typing">
      <span class="message-list__typing-dot" />
      <span class="message-list__typing-dot" />
      <span class="message-list__typing-dot" />
      <span class="message-list__typing-text">{{ t("conversation.replying") }}</span>
    </div>
    <div ref="bottomRef" class="message-list__bottom-anchor" />
  </div>
</template>

<script setup lang="ts">
import { CopyDocument } from "@element-plus/icons-vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import MessageAttachmentCard from "@/components/conversation/MessageAttachmentCard.vue";
import MessageMarkdown from "@/components/conversation/MessageMarkdown.vue";
import MessageToolCard from "@/components/conversation/MessageToolCard.vue";
import { useI18n } from "@/composables/useI18n";
import type { MessageReadApi } from "@/types/api/conversation";
import type { MessagePartView, MessageView } from "@/types/view/message";
import { toMessageView } from "@/types/view/message";

const props = defineProps<{
    messages: MessageReadApi[];
    loading: boolean;
    showTypingIndicator?: boolean;
}>();

const containerRef = ref<HTMLElement | null>(null);
const bottomRef = ref<HTMLElement | null>(null);
const messageViews = computed(() => props.messages.map((item) => toMessageView(item)));
const hasInitializedScroll = ref(false);
const copiedMessageId = ref<string | null>(null);
const { locale, t } = useI18n();
let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;
const scrollTrigger = computed(() => {
    const lastMessage = props.messages.at(-1);
    return [
        props.loading ? "loading" : "ready",
        props.messages.length,
        props.showTypingIndicator ? "typing" : "idle",
        lastMessage?.id ?? "",
        lastMessage?.updated_at ?? "",
        lastMessage?.content ?? "",
    ].join("|");
});

async function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    await nextTick();
    if (bottomRef.value) {
        bottomRef.value.scrollIntoView({ behavior, block: "end" });
        return;
    }
    if (containerRef.value) {
        containerRef.value.scrollTop = containerRef.value.scrollHeight;
    }
}

async function syncScrollPosition() {
    // 首次进入会话时，消息通常是异步拉取的。
    // 只有等第一批数据真正落地后，才把位置直接定到底部；
    // 后续新增消息或流式更新，再使用平滑滚动。
    if (!hasInitializedScroll.value) {
        if (props.loading && !props.messages.length) {
            return;
        }
        await scrollToBottom("auto");
        hasInitializedScroll.value = true;
        return;
    }

    await scrollToBottom("smooth");
}

watch(
    scrollTrigger,
    () => {
        void syncScrollPosition();
    },
    { immediate: true, flush: "post" },
);

function formatDateTime(value: string) {
    return new Intl.DateTimeFormat(locale.value, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(value));
}

function formatMessagePart(part: MessagePartView): string {
    if (part.kind === "markdown") {
        return part.content.trim();
    }
    if (part.kind === "attachment") {
        return [part.name, part.url].filter(Boolean).join("\n");
    }
    return [part.title, part.summary].filter(Boolean).join("\n");
}

function serializeMessage(message: MessageView): string {
    return message.parts
        .map((part) => formatMessagePart(part))
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

async function copyMessage(message: MessageView) {
    const text = serializeMessage(message);
    if (!text) {
        return;
    }
    await navigator.clipboard.writeText(text);
    copiedMessageId.value = message.id;
    if (copiedResetTimer) {
        clearTimeout(copiedResetTimer);
    }
    copiedResetTimer = setTimeout(() => {
        copiedMessageId.value = null;
        copiedResetTimer = null;
    }, 1800);
}

onBeforeUnmount(() => {
    if (copiedResetTimer) {
        clearTimeout(copiedResetTimer);
    }
});
</script>

<style scoped>
.message-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px var(--page-shell-pad-x);
  min-height: 0;
  overflow: auto;
  background: #ffffff;
}

.message-list__item {
  width: min(84%, 1040px);
  max-width: 1040px;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--color-border) 82%, white);
  border-radius: 18px;
  background: #f7f7f8;
}

.message-list__item--user {
  margin-left: auto;
  width: min(56%, 760px);
  border-color: transparent;
  background: color-mix(in srgb, var(--color-accent) 12%, white);
}

.message-list__empty {
  display: grid;
  place-items: center;
  min-height: 100%;
  color: #c7c7cb;
  text-align: center;
}

.message-list__meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: 8px;
  color: #91959d;
  font-size: 0.82rem;
}

.message-list__meta-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.message-list__sender {
  font-weight: 600;
}

.message-list__source-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  background: #eef3ff;
  color: #5f6f95;
  font-size: 0.72rem;
  line-height: 1.45;
  white-space: nowrap;
}

.message-list__meta-side {
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-list__copy-button {
  --el-button-hover-text-color: #6f7784;
  --el-button-hover-bg-color: #f4f5f7;
  --el-button-active-text-color: #5f6773;
  --el-button-active-bg-color: #eceef2;
  width: 34px;
  height: 34px;
  min-height: 34px;
  padding: 0;
  border: 1px solid #e3e6eb;
  border-radius: 12px;
  background: #ffffff;
  color: #8d95a3;
  box-shadow: 0 1px 1px rgba(15, 23, 42, 0.03);
}

.message-list__copy-icon {
  font-size: 16px;
}

.message-list__content {
  min-width: 0;
}

.message-list__parts {
  display: grid;
  gap: 10px;
}

.message-list__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.message-list__bottom-anchor {
  width: 100%;
  height: 1px;
}

.message-list__typing {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--color-border) 82%, white);
  border-radius: 18px;
  background: #f7f7f8;
  color: #8f949d;
}

.message-list__typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #c2c6ce;
  animation: message-list-typing 1.2s infinite ease-in-out;
}

.message-list__typing-dot:nth-child(2) {
  animation-delay: 0.15s;
}

.message-list__typing-dot:nth-child(3) {
  animation-delay: 0.3s;
}

.message-list__typing-text {
  margin-left: 2px;
  font-size: 0.9rem;
}

@keyframes message-list-typing {
  0%, 80%, 100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-1px);
  }
}

@media (max-width: 720px) {
  .message-list__meta {
    flex-direction: column;
    align-items: flex-start;
  }

  .message-list__meta-side {
    flex-wrap: wrap;
  }
}
</style>
