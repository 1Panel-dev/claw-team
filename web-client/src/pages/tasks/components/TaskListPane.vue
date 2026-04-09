<template>
  <article class="pane">
    <header class="pane__header">
      <div>
        <h2 class="pane__title">任务列表</h2>
        <p class="pane__description">先把筛选、列表和选择结构搭稳，后续再接真实任务接口。</p>
      </div>
      <span class="pane__meta">{{ tasks.length }} 项</span>
    </header>

    <div class="filters">
      <label class="field">
        <span class="field__label">搜索</span>
        <input
          :value="filters.keyword"
          class="field__control"
          placeholder="标题 / 标签 / Agent"
          type="text"
          @input="emit('update:keyword', ($event.target as HTMLInputElement).value)"
        />
      </label>

      <label class="field">
        <span class="field__label">状态</span>
        <select
          :value="filters.status"
          class="field__control"
          @change="handleStatusChange"
        >
          <option value="all">全部状态</option>
          <option value="in_progress">进行中</option>
          <option value="completed">已完成</option>
          <option value="terminated">已终止</option>
        </select>
      </label>

      <label class="field">
        <span class="field__label">优先级</span>
        <select
          :value="filters.priority"
          class="field__control"
          @change="handlePriorityChange"
        >
          <option value="all">全部优先级</option>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
          <option value="urgent">紧急</option>
        </select>
      </label>
    </div>

    <div v-if="!tasks.length" class="empty">
      当前筛选条件下还没有任务。
    </div>

    <div v-else class="task-list">
      <button
        v-for="task in tasks"
        :key="task.id"
        class="task-card"
        :class="{ 'task-card--active': task.id === selectedTaskId }"
        type="button"
        @click="emit('select', task.id)"
      >
        <div class="task-card__top">
          <span class="priority-pill" :class="`priority-pill--${task.priority}`">
            {{ priorityLabel(task.priority) }}
          </span>
          <span class="status-pill" :class="`status-pill--${task.status}`">
            {{ statusLabel(task.status) }}
          </span>
        </div>

        <div class="task-card__title">{{ task.title }}</div>
        <div class="task-card__meta">
          {{ task.assignee.agentName }} · {{ task.assignee.instanceName }}
        </div>
        <div class="task-card__description">{{ task.description }}</div>

        <div class="task-card__footer">
          <div class="task-card__tags">
            <span
              v-for="tag in task.tags.slice(0, 3)"
              :key="tag"
              class="tag"
            >
              #{{ tag }}
            </span>
          </div>
          <span class="task-card__time">{{ formatTime(task.updatedAt) }}</span>
        </div>
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
/**
 * 任务列表面板。
 *
 * 负责承接筛选、搜索和选择动作。
 */
import type { TaskFilterState, TaskPriority, TaskStatus, TaskView } from "@/types/view/task";
import { formatServerDateTime } from "@/utils/datetime";

defineProps<{
    filters: TaskFilterState;
    tasks: TaskView[];
    selectedTaskId: string | null;
}>();

const emit = defineEmits<{
    (event: "select", taskId: string): void;
    (event: "update:keyword", value: string): void;
    (event: "update:status", value: TaskStatus | "all"): void;
    (event: "update:priority", value: TaskPriority | "all"): void;
}>();

function priorityLabel(priority: TaskPriority) {
    if (priority === "low") {
        return "低";
    }
    if (priority === "medium") {
        return "中";
    }
    if (priority === "high") {
        return "高";
    }
    return "紧急";
}

function statusLabel(status: TaskStatus) {
    if (status === "in_progress") {
        return "进行中";
    }
    if (status === "completed") {
        return "已完成";
    }
    return "已终止";
}

function formatTime(value: string) {
    return formatServerDateTime(value, "zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function handleStatusChange(event: Event) {
    emit("update:status", (event.target as HTMLSelectElement).value as TaskStatus | "all");
}

function handlePriorityChange(event: Event) {
    emit("update:priority", (event.target as HTMLSelectElement).value as TaskPriority | "all");
}
</script>

<style scoped>
.pane {
  display: grid;
  align-content: start;
  gap: var(--space-4);
  min-height: 0;
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-app);
}

.pane__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.pane__title {
  margin: 0;
  font-size: 1.15rem;
}

.pane__description,
.pane__meta {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
  font-size: 0.92rem;
}

.filters {
  display: grid;
  grid-template-columns: 1.4fr repeat(2, minmax(0, 0.8fr));
  gap: var(--space-3);
}

.field {
  display: grid;
  gap: 8px;
}

.field__label {
  font-size: 0.82rem;
  color: var(--color-text-secondary);
}

.field__control {
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-panel);
  color: var(--color-text-primary);
}

.task-list {
  display: grid;
  gap: var(--space-3);
  min-height: 0;
  overflow: auto;
}

.task-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-panel);
  text-align: left;
  cursor: pointer;
}

.task-card--active {
  border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 22%, transparent);
}

.task-card__top,
.task-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.task-card__title {
  font-size: 1rem;
  font-weight: 700;
}

.task-card__meta,
.task-card__description,
.task-card__time {
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.task-card__description {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.task-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag,
.priority-pill,
.status-pill {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  white-space: nowrap;
}

.tag {
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.priority-pill--low {
  background: #eef5ef;
  color: #3f7b47;
}

.priority-pill--medium {
  background: #f4efe2;
  color: #9b6a06;
}

.priority-pill--high {
  background: #f8e9df;
  color: #be5720;
}

.priority-pill--urgent {
  background: #f7dede;
  color: #9f2222;
}

.status-pill--in_progress {
  background: color-mix(in srgb, var(--color-accent) 12%, white);
  color: var(--color-accent);
}

.status-pill--completed {
  background: #edf7f0;
  color: #2f7b42;
}

.status-pill--terminated {
  background: #f4f4f4;
  color: #676767;
}

.empty {
  padding: var(--space-5);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-text-secondary);
  text-align: center;
}

@media (max-width: 1200px) {
  .filters {
    grid-template-columns: 1fr;
  }
}
</style>
