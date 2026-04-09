<template>
  <article class="pane">
    <template v-if="task">
      <header class="pane__header">
        <div class="pane__header-main">
          <div class="pane__eyebrow">任务详情</div>
          <h2 class="pane__title">{{ task.title }}</h2>
          <p class="pane__description">{{ task.description }}</p>
        </div>
        <div class="pane__header-side">
          <span class="status-pill" :class="`status-pill--${task.status}`">
            {{ statusLabel(task.status) }}
          </span>
          <span class="priority-pill" :class="`priority-pill--${task.priority}`">
            {{ priorityLabel(task.priority) }}
          </span>
        </div>
      </header>

      <section v-if="task.status === 'in_progress'" class="action-bar">
        <div class="action-bar__copy">
          当前任务仍在进行中。第一阶段先把“完成 / 终止”动作收顺，后续再接真实任务接口。
        </div>
        <div class="action-bar__buttons">
          <el-button plain type="danger" @click="emit('terminate', task.id)">
            终止任务
          </el-button>
          <el-button type="primary" @click="emit('complete', task.id)">
            完成任务
          </el-button>
        </div>
      </section>

      <section class="detail-grid">
        <div class="detail-card">
          <div class="detail-card__label">执行者</div>
          <div class="detail-card__value">{{ task.assignee.agentName }}</div>
          <div class="detail-card__meta">
            {{ task.assignee.instanceName }}<span v-if="task.assignee.roleName"> · {{ task.assignee.roleName }}</span>
          </div>
        </div>

        <div class="detail-card">
          <div class="detail-card__label">开始时间</div>
          <div class="detail-card__value">{{ formatDateTime(task.startedAt) }}</div>
          <div class="detail-card__meta">创建于 {{ formatDateTime(task.createdAt) }}</div>
        </div>

        <div class="detail-card">
          <div class="detail-card__label">结束时间</div>
          <div class="detail-card__value">{{ task.endedAt ? formatDateTime(task.endedAt) : "未结束" }}</div>
          <div class="detail-card__meta">{{ durationLabel(task.startedAt, task.endedAt) }}</div>
        </div>

        <div class="detail-card">
          <div class="detail-card__label">来源</div>
          <div class="detail-card__value">{{ task.source === "server" ? "服务端" : "前端示例" }}</div>
          <div class="detail-card__meta">{{ task.commentCount }} 条评论 / 事件</div>
        </div>
      </section>

      <section class="detail-section">
        <h3 class="detail-section__title">标签</h3>
        <div class="tag-list">
          <span
            v-for="tag in task.tags"
            :key="tag"
            class="tag"
          >
            #{{ tag }}
          </span>
        </div>
      </section>

      <section class="detail-section">
        <div class="detail-section__header">
          <h3 class="detail-section__title">任务时间线</h3>
          <div class="detail-section__meta">先用示例事件把结构铺好，后面可直接接任务评论和系统事件。</div>
        </div>

        <div class="timeline">
          <div
            v-for="entry in task.timeline"
            :key="entry.id"
            class="timeline__item"
          >
            <div class="timeline__dot" :class="`timeline__dot--${entry.type}`" />
            <div class="timeline__content">
              <div class="timeline__top">
                <div class="timeline__label">{{ entry.label }}</div>
                <div class="timeline__time">{{ formatDateTime(entry.at) }}</div>
              </div>
              <div class="timeline__text">{{ entry.content }}</div>
            </div>
          </div>
        </div>
      </section>
    </template>

    <div v-else class="empty">
      请选择左侧任务，右侧会显示详情、状态和时间线。
    </div>
  </article>
</template>

<script setup lang="ts">
/**
 * 任务详情面板。
 *
 * 展示基础信息、执行者、时间、标签和时间线。
 */
import type { TaskPriority, TaskStatus, TaskView } from "@/types/view/task";
import { formatServerDateTime, parseServerDateTime } from "@/utils/datetime";

defineProps<{
    task: TaskView | null;
}>();

const emit = defineEmits<{
    (event: "complete", taskId: string): void;
    (event: "terminate", taskId: string): void;
}>();

function priorityLabel(priority: TaskPriority) {
    if (priority === "low") {
        return "低优先级";
    }
    if (priority === "medium") {
        return "中优先级";
    }
    if (priority === "high") {
        return "高优先级";
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

function formatDateTime(value: string) {
    return formatServerDateTime(value, "zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function durationLabel(startedAt: string, endedAt: string | null) {
    if (!endedAt) {
        return "任务仍在进行中";
    }
    const durationMs = parseServerDateTime(endedAt).getTime() - parseServerDateTime(startedAt).getTime();
    const hours = Math.floor(durationMs / (1000 * 60 * 60));
    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
    return `持续 ${hours} 小时 ${minutes} 分钟`;
}
</script>

<style scoped>
.pane {
  display: grid;
  align-content: start;
  gap: var(--space-5);
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
  gap: var(--space-4);
}

.pane__eyebrow {
  color: var(--color-text-secondary);
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.pane__title {
  margin: 10px 0 12px;
  font-size: 1.5rem;
}

.pane__description {
  margin: 0;
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.pane__header-side {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--color-accent) 20%, var(--color-border));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-accent) 5%, var(--color-bg-panel));
}

.action-bar__copy {
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.action-bar__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.detail-card {
  display: grid;
  gap: 10px;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-panel);
}

.detail-card__label {
  color: var(--color-text-secondary);
  font-size: 0.84rem;
}

.detail-card__value {
  font-size: 1.02rem;
  font-weight: 700;
}

.detail-card__meta {
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.detail-section {
  display: grid;
  gap: var(--space-3);
}

.detail-section__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.detail-section__title {
  margin: 0;
  font-size: 1.05rem;
}

.detail-section__meta {
  color: var(--color-text-secondary);
  font-size: 0.9rem;
}

.tag-list {
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

.timeline {
  display: grid;
  gap: var(--space-4);
}

.timeline__item {
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: var(--space-3);
}

.timeline__dot {
  width: 12px;
  height: 12px;
  margin-top: 6px;
  border-radius: 999px;
  background: var(--color-border);
}

.timeline__dot--system {
  background: var(--color-accent);
}

.timeline__dot--user {
  background: #3557b7;
}

.timeline__dot--agent {
  background: #2f7b42;
}

.timeline__content {
  display: grid;
  gap: 8px;
}

.timeline__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.timeline__label {
  font-weight: 700;
}

.timeline__time,
.timeline__text {
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.empty {
  padding: var(--space-6);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-text-secondary);
  text-align: center;
}

@media (max-width: 1200px) {
  .pane__header,
  .action-bar,
  .detail-section__header {
    flex-direction: column;
  }

  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>
