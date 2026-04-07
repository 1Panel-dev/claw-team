<template>
  <div ref="containerRef" class="message-list" @scroll="handleScroll">
    <div v-if="loading && !messages.length" class="message-list__empty">
      {{ t("conversation.loadingMessages") }}
    </div>
    <div v-else-if="!messages.length" class="message-list__empty">
      {{ t("conversation.emptyMessages") }}
    </div>
    <template v-else>
      <div
        v-for="message in visibleMessageViews"
        :key="message.id"
        class="message-list__item"
        :class="messageItemClass(message)"
        :style="speakerStyleFor(message)"
      >
        <div class="message-list__meta" :class="{ 'message-list__meta--process': isCompactProcessMessage(message) }">
          <div class="message-list__meta-main">
            <span
              v-if="!isCompactProcessMessage(message) && senderMetaFor(message)?.instanceName"
              class="message-list__sender-instance"
            >
              {{ senderMetaFor(message)?.instanceName }}
            </span>
            <span class="message-list__sender">{{ displaySenderLabel(message) }}</span>
            <span
              v-if="!isCompactProcessMessage(message) && senderMetaFor(message)?.roleName"
              class="message-list__sender-role"
            >
              / {{ senderMetaFor(message)?.roleName }}
            </span>
            <span v-if="message.source === 'webchat'" class="message-list__source-badge">
              {{ t("conversation.sourceWebchat") }}
            </span>
          </div>
          <div class="message-list__meta-side">
            <span>{{ formatDateTime(message.updatedAt) }}</span>
            <ElButton
              v-if="!isCompactProcessMessage(message)"
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
              v-if="part.kind === 'markdown' && !shouldHideMarkdownPart(message, part)"
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
              :compact="isCompactProcessMessage(message)"
              :compact-title="compactToolTitle(message, part)"
            />
          </template>
        </div>

        <div v-if="!isCompactProcessMessage(message)" class="message-list__actions">
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
    </template>
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
import { formatServerDateTime } from "@/utils/datetime";

type SenderMeta = {
    roleName?: string | null;
    csId?: string | null;
    instanceName?: string | null;
};

const props = defineProps<{
    messages: MessageReadApi[];
    loading: boolean;
    hasMoreMessages?: boolean;
    loadingOlderMessages?: boolean;
    showTypingIndicator?: boolean;
    senderMetaMap?: Record<string, SenderMeta>;
}>();

const emit = defineEmits<{
    loadOlder: [];
}>();

const { locale, t } = useI18n();
const containerRef = ref<HTMLElement | null>(null);
const bottomRef = ref<HTMLElement | null>(null);
const copiedMessageId = ref<string | null>(null);
const hasInitializedScroll = ref(false);
const pendingOlderAnchor = ref<{ scrollHeight: number; scrollTop: number } | null>(null);
const waitingOlderRequest = ref(false);
const shouldStickToBottom = ref(true);

let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;

const OLDER_MESSAGES_TRIGGER_PX = 300;
const SPEAKER_COLORS = [
    "#c05621",
    "#2b6cb0",
    "#2f855a",
    "#9b2c2c",
    "#7b2cbf",
    "#0f766e",
    "#b45309",
    "#1d4ed8",
];

const resolvedSenderMetaMap = computed(() => props.senderMetaMap ?? {});
const messageViews = computed(() => props.messages.map((item) => toMessageView(item)));
const visibleMessageViews = computed(() => messageViews.value.filter((item) => item.parts.length > 0));

const latestMessageTrigger = computed(() => {
    const lastMessage = props.messages.at(-1);
    return [
        props.loading ? "loading" : "ready",
        lastMessage?.id ?? "",
        lastMessage?.updated_at ?? "",
        lastMessage?.content ?? "",
        props.showTypingIndicator ? "typing" : "idle",
    ].join("|");
});

const speakerColorMap = computed<Record<string, string>>(() => {
    const speakerKeys = Array.from(
        new Set(
            messageViews.value
                .filter((message) => message.senderType !== "user" && message.senderType !== "system")
                .map((message) => speakerKeyFor(message))
                .filter((value): value is string => Boolean(value)),
        ),
    );

    return Object.fromEntries(
        speakerKeys.map((key, index) => [key, SPEAKER_COLORS[index % SPEAKER_COLORS.length]]),
    );
});

const shouldAccentSpeakers = computed(() => Object.keys(speakerColorMap.value).length > 1);

watch(
    latestMessageTrigger,
    () => {
        if (pendingOlderAnchor.value) {
            return;
        }
        void syncLatestScrollPosition();
    },
    { immediate: true, flush: "post" },
);

watch(
    () => props.messages.length,
    async (currentLength, previousLength) => {
        if (!pendingOlderAnchor.value || currentLength <= previousLength) {
            return;
        }
        await nextTick();
        const container = containerRef.value;
        if (!container) {
            pendingOlderAnchor.value = null;
            waitingOlderRequest.value = false;
            return;
        }
        const delta = container.scrollHeight - pendingOlderAnchor.value.scrollHeight;
        container.scrollTop = pendingOlderAnchor.value.scrollTop + delta;
        pendingOlderAnchor.value = null;
        waitingOlderRequest.value = false;
    },
);

watch(
    () => props.loadingOlderMessages,
    (loadingOlderMessages) => {
        if (!loadingOlderMessages && waitingOlderRequest.value && !pendingOlderAnchor.value) {
            waitingOlderRequest.value = false;
        }
    },
);

function normalizedSenderCsId(message: MessageView) {
    return message.senderCsId?.trim() || "";
}

function normalizedSenderLabel(message: MessageView) {
    return message.senderLabel.trim();
}

function speakerKeyFor(message: MessageView) {
    return normalizedSenderCsId(message) || normalizedSenderLabel(message) || message.id;
}

function senderMetaFor(message: MessageView) {
    const csId = normalizedSenderCsId(message);
    if (csId && resolvedSenderMetaMap.value[csId]) {
        return resolvedSenderMetaMap.value[csId];
    }
    const label = normalizedSenderLabel(message);
    if (label && resolvedSenderMetaMap.value[label]) {
        return resolvedSenderMetaMap.value[label];
    }
    return undefined;
}

function messageItemClass(message: MessageView) {
    return {
        "message-list__item--user": message.senderType === "user",
        "message-list__item--process": isCompactProcessMessage(message),
        "message-list__item--speaker-accented": shouldAccentSpeakers.value && Boolean(speakerColorMap.value[speakerKeyFor(message)]),
    };
}

function speakerStyleFor(message: MessageView) {
    if (!shouldAccentSpeakers.value) {
        return undefined;
    }
    const color = speakerColorMap.value[speakerKeyFor(message)];
    if (!color) {
        return undefined;
    }
    return {
        "--message-speaker-color": color,
    } as Record<string, string>;
}

function formatDateTime(value: string) {
    return formatServerDateTime(value, locale.value, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function isNearBottom() {
    if (!containerRef.value) {
        return true;
    }
    return containerRef.value.scrollHeight - (containerRef.value.scrollTop + containerRef.value.clientHeight) < 160;
}

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

async function syncLatestScrollPosition() {
    if (!hasInitializedScroll.value) {
        if (props.loading && !props.messages.length) {
            return;
        }
        await scrollToBottom("auto");
        hasInitializedScroll.value = true;
        return;
    }
    if (shouldStickToBottom.value) {
        await scrollToBottom("smooth");
    }
}

function isCompactProcessMessage(message: MessageView) {
    if (message.senderType === "user") {
        return false;
    }
    const toolParts = message.parts.filter((part) => part.kind === "tool_card");
    if (toolParts.length !== 1) {
        return false;
    }
    if (message.parts.some((part) => part.kind === "attachment")) {
        return false;
    }
    const markdownParts = message.parts.filter((part) => part.kind === "markdown");
    return markdownParts.every((part) => part.content.trim().length <= 220);
}

function isTranscriptSummaryMarkdown(part: MessagePartView) {
    return part.kind === "markdown" && part.content.trim().startsWith("Transcript part (");
}

function shouldHideMarkdownPart(message: MessageView, part: MessagePartView) {
    if (!isCompactProcessMessage(message) || part.kind !== "markdown") {
        return false;
    }
    return !isTranscriptSummaryMarkdown(part) && part.content.trim().length > 0;
}

function displaySenderLabel(message: MessageView) {
    if (!isCompactProcessMessage(message)) {
        return message.senderLabel;
    }
    const toolPart = message.parts.find((part) => part.kind === "tool_card");
    if (!toolPart || toolPart.kind !== "tool_card") {
        return message.senderLabel;
    }
    return toolPart.status === "running" || toolPart.status === "pending" ? "Assistant" : "Tool";
}

function compactToolTitle(message: MessageView, part: Extract<MessagePartView, { kind: "tool_card" }>) {
    if (!isCompactProcessMessage(message)) {
        return part.title;
    }
    return part.status === "running" || part.status === "pending"
        ? `1 tool ${part.title}`
        : `Tool output ${part.title}`;
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

function serializeMessage(message: MessageView) {
    return message.parts.map((part) => formatMessagePart(part)).filter(Boolean).join("\n\n").trim();
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

function requestOlderMessages() {
    if (!props.hasMoreMessages || props.loadingOlderMessages || waitingOlderRequest.value || !containerRef.value) {
        return;
    }
    pendingOlderAnchor.value = {
        scrollHeight: containerRef.value.scrollHeight,
        scrollTop: containerRef.value.scrollTop,
    };
    waitingOlderRequest.value = true;
    emit("loadOlder");
}

function handleScroll() {
    if (!containerRef.value || pendingOlderAnchor.value) {
        return;
    }
    shouldStickToBottom.value = isNearBottom();
    if (containerRef.value.scrollTop <= OLDER_MESSAGES_TRIGGER_PX) {
        requestOlderMessages();
    }
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

.message-list__item--process {
  width: min(62%, 760px);
  padding: 8px 10px;
  border-radius: 14px;
  background: #fafafa;
}

.message-list__item--speaker-accented {
  border-left: 4px solid var(--message-speaker-color);
  padding-left: 13px;
}

.message-list__item--process.message-list__item--speaker-accented {
  padding-left: 9px;
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

.message-list__meta--process {
  margin-bottom: 6px;
  font-size: 0.78rem;
}

.message-list__meta-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.message-list__sender {
  font-size: 0.93rem;
  font-weight: 700;
}

.message-list__meta--process .message-list__sender {
  font-size: 0.82rem;
  font-weight: 600;
  color: #8b8f97;
}

.message-list__sender-role {
  font-size: 0.9rem;
  font-weight: 600;
  color: #7b8190;
}

.message-list__sender-instance {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--el-color-primary);
}

.message-list__item--speaker-accented .message-list__sender {
  color: var(--message-speaker-color);
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

.message-list__item--process .message-list__copy-button {
  width: 30px;
  height: 30px;
  min-height: 30px;
  border-radius: 10px;
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

.message-list__item--process .message-list__actions {
  margin-top: 4px;
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
    transform: translateY(-3px);
  }
}

@media (max-width: 960px) {
  .message-list {
    gap: 12px;
    padding: 14px 16px;
  }

  .message-list__item,
  .message-list__item--user,
  .message-list__item--process {
    width: 100%;
  }

  .message-list__meta {
    flex-direction: column;
    align-items: flex-start;
  }

  .message-list__meta-side {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
