<template>
  <div class="attachment-card">
    <div class="attachment-card__icon">{{ extensionLabel }}</div>
    <div class="attachment-card__body">
      <div class="attachment-card__name">{{ name }}</div>
      <div class="attachment-card__meta">
        <span class="attachment-card__meta-pill">{{ t("conversation.attachment") }}</span>
        <span>{{ displayMimeType }}</span>
      </div>
    </div>
    <a class="attachment-card__action" :href="url" target="_blank" rel="noreferrer">
      {{ t("conversation.openAttachment") }}
    </a>
  </div>
</template>

<script setup lang="ts">
/**
 * 附件卡片先做前端占位样式。
 *
 * 第一阶段后端还没把附件真正传过来，
 * 所以前端先把消息卡片样式定下来。
 * 后面协议升级后，这个组件可以直接复用。
 */
import { computed } from "vue";
import { useI18n } from "@/composables/useI18n";

const props = defineProps<{
    name: string;
    mimeType: string | null;
    url: string;
}>();
const { t } = useI18n();

const extensionLabel = computed(() => {
    const ext = props.name.split(".").at(-1)?.trim().toUpperCase();
    return ext && ext.length <= 4 ? ext : "FILE";
});

const displayMimeType = computed(() => props.mimeType || t("conversation.genericFile"));
</script>

<style scoped>
.attachment-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--color-border) 82%, white);
  border-radius: 18px;
  background: linear-gradient(180deg, #ffffff 0%, #fafafb 100%);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
}

.attachment-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 46px;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--color-accent) 12%, white);
  color: var(--color-accent);
  font-weight: 700;
  font-size: 0.78rem;
  letter-spacing: 0.04em;
}

.attachment-card__body {
  display: grid;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.attachment-card__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.attachment-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8f949d;
  font-size: 0.84rem;
}

.attachment-card__meta-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: #f3f4f6;
  color: #6b7280;
  font-size: 0.76rem;
}

.attachment-card__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 72px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--color-border) 85%, white);
  border-radius: 999px;
  background: #ffffff;
  color: #394150;
  text-decoration: none;
  white-space: nowrap;
  font-weight: 600;
  transition:
    border-color 0.18s ease,
    color 0.18s ease,
    transform 0.18s ease;
}

.attachment-card__action:hover {
  border-color: color-mix(in srgb, var(--color-accent) 30%, white);
  color: var(--color-accent);
  text-decoration: none;
  transform: translateY(-1px);
}
</style>
