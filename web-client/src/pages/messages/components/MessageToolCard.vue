<template>
  <div
    class="tool-card"
    :class="[`tool-card--${status}`, compact ? 'tool-card--compact' : '']"
  >
    <button
      v-if="compact"
      type="button"
      class="tool-card__compact-trigger"
      @click="expanded = !expanded"
    >
      <span class="tool-card__compact-left">
        <span class="tool-card__chevron">{{ expanded ? "▾" : "▸" }}</span>
        <span class="tool-card__dot" />
        <span class="tool-card__title">{{ compactTitle }}</span>
      </span>
      <span class="tool-card__status">{{ statusLabel }}</span>
    </button>

    <div v-else class="tool-card__header">
      <div class="tool-card__title-wrap">
        <span class="tool-card__dot" />
        <div class="tool-card__title">{{ title }}</div>
      </div>
      <span class="tool-card__status">{{ statusLabel }}</span>
    </div>

    <div v-if="!compact || expanded" class="tool-card__body">
      <div class="tool-card__summary">{{ summary }}</div>
      <div v-if="!compact" class="tool-card__footer">工具执行结果</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = defineProps<{
    title: string;
    status: "pending" | "running" | "completed" | "failed";
    summary: string;
    compact?: boolean;
    compactTitle?: string;
}>();

const expanded = ref(false);

const statusLabel = computed(() => {
    if (props.status === "pending") return "等待中";
    if (props.status === "running") return "执行中";
    if (props.status === "completed") return "已完成";
    return "失败";
});

const compactTitle = computed(() => props.compactTitle?.trim() || props.title);

watch(
    () => props.summary,
    () => {
        expanded.value = false;
    },
);
</script>

<style scoped>
.tool-card {
  display: grid;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--color-border) 82%, white);
  border-radius: 18px;
  background: linear-gradient(180deg, #ffffff 0%, #fafbfc 100%);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
}

.tool-card--compact {
  gap: 8px;
  padding: 8px 10px;
  border-radius: 16px;
  background: #ffffff;
  box-shadow: none;
}

.tool-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.tool-card__compact-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.tool-card__compact-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tool-card__body {
  display: grid;
  gap: 8px;
}

.tool-card__chevron {
  color: #98a2b3;
  font-size: 0.82rem;
}

.tool-card__title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.tool-card__dot {
  flex: 0 0 10px;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #98a2b3;
}

.tool-card__title {
  font-weight: 700;
  min-width: 0;
}

.tool-card--compact .tool-card__title {
  font-size: 0.92rem;
  font-weight: 600;
}

.tool-card__status {
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  white-space: nowrap;
}

.tool-card--compact .tool-card__status {
  padding: 3px 8px;
  font-size: 0.76rem;
}

.tool-card--pending .tool-card__dot {
  background: #98a2b3;
}

.tool-card--pending .tool-card__status {
  background: #f2f4f7;
  color: #667085;
}

.tool-card--running .tool-card__dot {
  background: #f59e0b;
}

.tool-card--running .tool-card__status {
  background: #fff2df;
  color: #b26600;
}

.tool-card--completed .tool-card__dot {
  background: #22c55e;
}

.tool-card--completed .tool-card__status {
  background: #e9f8ef;
  color: #277a4f;
}

.tool-card--failed .tool-card__dot {
  background: #ef4444;
}

.tool-card--failed .tool-card__status {
  background: #fdecea;
  color: #c0392b;
}

.tool-card__summary {
  color: #4d5561;
  line-height: 1.68;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-card--compact .tool-card__summary {
  font-size: 0.84rem;
  line-height: 1.55;
}

.tool-card__footer {
  color: #98a2b3;
  font-size: 0.8rem;
}
</style>
