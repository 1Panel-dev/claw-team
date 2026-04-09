<template>
  <div class="page-container">
    <section class="page-header page-container__header">
      <h1 class="page-header__title page-container__title">{{ t("tasks.title") }}</h1>

      <el-tabs :model-value="activeStatusTab" class="tasks-tabs" @tab-change="handleTabChange">
        <el-tab-pane
          v-for="tab in statusTabs"
          :key="tab.value"
          :label="tab.label"
          :name="tab.value"
        />
      </el-tabs>
    </section>

    <section class="table-shell page-container__body">
      <header class="toolbar">
        <div class="toolbar__left">
          <el-button type="primary" @click="createDrawerVisible = true">
            {{ t("tasks.createTask") }}
          </el-button>
        </div>

        <div class="toolbar__right">
          <el-input
            :model-value="filters.keyword"
            clearable
            class="toolbar__search"
            :placeholder="t('tasks.searchPlaceholder')"
            @update:model-value="handleKeywordChange"
          />
          <el-button :loading="taskLoading" @click="reloadTasks">
            {{ t("tasks.refresh") }}
          </el-button>
          <span class="toolbar__mode" :class="`toolbar__mode--${backendMode}`">
            {{ backendModeLabel }}
          </span>
        </div>
      </header>

      <div class="table-wrap">
        <div v-if="loadError" class="table-banner table-banner--warning">
          {{ loadError }}
        </div>
        <div v-if="taskLoading" class="table-empty">
          {{ t("tasks.loading") }}
        </div>
        <div v-else class="task-table-v2">
          <el-auto-resizer>
            <template #default="{ height, width }">
              <el-table-v2
                :columns="columns"
                :data="loadedTasks"
                :header-height="48"
                :height="Math.max(height, tableViewportHeight)"
                :width="width"
                class="task-table-v2__table"
                @rows-rendered="handleRowsRendered"
              >
                <template #empty>
                  <el-empty :description="emptyStateText" />
                </template>
              </el-table-v2>
            </template>
          </el-auto-resizer>
        </div>
      </div>

    </section>

    <TaskCreateDrawer
      v-model:visible="createDrawerVisible"
      :instances="instances"
      @submit="handleCreateTask"
    />

    <el-drawer
      :model-value="detailDrawerVisible"
      :title="t('tasks.detailTitle')"
      size="760px"
      destroy-on-close
      @close="detailDrawerVisible = false"
    >
      <TaskDetailPane
        :task="detailTask"
        @complete="handleCompleteTask"
        @terminate="handleTerminateTask"
      />
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
/**
 * 任务页容器。
 *
 * 负责组织任务筛选、列表、创建入口和详情抽屉。
 */
import { computed, h, onMounted, ref } from "vue";
import ElButton from "element-plus/es/components/button/index";
import type { Column } from "element-plus/es/components/table-v2/index";

import TaskDetailPane from "@/pages/tasks/components/TaskDetailPane.vue";
import TaskCreateDrawer from "@/pages/tasks/components/TaskCreateDrawer.vue";
import { useI18n } from "@/composables/useI18n";
import { useOpenClawStore } from "@/stores/openclaw";
import { useTaskStore } from "@/stores/task";
import type { TaskCreatePayload, TaskStatus } from "@/types/view/task";
import { formatServerDateTime } from "@/utils/datetime";

const taskStore = useTaskStore();
const openClawStore = useOpenClawStore();
const createDrawerVisible = ref(false);
const detailDrawerVisible = ref(false);
const detailTaskId = ref<string | null>(null);
const activeStatusTab = ref<TaskStatus | "all">("in_progress");
const virtualLoadStep = 500;
const virtualPreloadThresholdRows = 120;
const loadedTaskCount = ref(virtualLoadStep);
const tableViewportHeight = 460;
const { t } = useI18n();

const filters = computed(() => taskStore.filters);
const instances = computed(() => openClawStore.instances);
const taskLoading = computed(() => taskStore.loading);
const loadError = computed(() => taskStore.loadError);
const backendMode = computed(() => taskStore.backendMode);
const filteredTasks = computed(() => taskStore.filteredTasks);
const detailTask = computed(() => taskStore.selectedTask);
const loadedTasks = computed(() =>
    filteredTasks.value.slice(0, Math.min(filteredTasks.value.length, loadedTaskCount.value)),
);
const backendModeLabel = computed(() => {
    if (backendMode.value === "server") {
        return t("tasks.serverMode");
    }
    if (backendMode.value === "demo") {
        return t("tasks.demoMode");
    }
    return t("tasks.initializing");
});
const emptyStateText = computed(() => {
    if (backendMode.value === "server") {
        return t("tasks.noServerTasks");
    }
    return t("tasks.noFilteredTasks");
});
const statusTabs = [
    { value: "in_progress", label: t("tasks.tabInProgress") },
    { value: "completed", label: t("tasks.tabCompleted") },
    { value: "terminated", label: t("tasks.tabTerminated") },
    { value: "all", label: t("tasks.tabAll") },
] as const;
const columns = computed<Column[]>(() => [
    {
        key: "title",
        title: t("tasks.columnTitle"),
        dataKey: "title",
        width: 260,
        flexGrow: 2.6,
        cellRenderer: ({ rowData }) =>
            h(
                "div",
                {
                    class: "task-cell task-cell--title",
                    // 在同一张虚拟表里用缩进表达层级。
                    style: { paddingInlineStart: `${12 + (rowData.level ?? 0) * 22}px` },
                    title: rowData.title,
                },
                [
                    h(
                        "span",
                        {
                            class: [
                                "task-cell__kind",
                                (rowData.level ?? 0) > 0 ? "task-cell__kind--child" : "task-cell__kind--parent",
                            ],
                        },
                        (rowData.level ?? 0) > 0 ? "子" : "父",
                    ),
                    h("span", { class: "task-cell__title-text" }, rowData.title),
                ],
            ),
    },
    {
        key: "agent",
        title: t("tasks.columnAgent"),
        dataKey: "agent",
        width: 120,
        flexGrow: 1,
        cellRenderer: ({ rowData }) => h("div", rowData.assignee.agentName),
    },
    {
        key: "instance",
        title: t("tasks.columnInstance"),
        dataKey: "instance",
        width: 180,
        flexGrow: 1.5,
        cellRenderer: ({ rowData }) => h("div", rowData.assignee.instanceName),
    },
    {
        key: "status",
        title: t("tasks.columnStatus"),
        dataKey: "status",
        width: 100,
        cellRenderer: ({ rowData }) =>
            h("span", { class: `status-pill status-pill--${rowData.status}` }, statusLabel(rowData.status)),
    },
    {
        key: "startedAt",
        title: t("tasks.columnStartedAt"),
        dataKey: "startedAt",
        width: 150,
        flexGrow: 1.1,
        cellRenderer: ({ rowData }) => h("div", formatDateTime(rowData.startedAt)),
    },
    {
        key: "endedAt",
        title: t("tasks.columnEndedAt"),
        dataKey: "endedAt",
        width: 140,
        flexGrow: 1,
        cellRenderer: ({ rowData }) => h("div", rowData.endedAt ? formatDateTime(rowData.endedAt) : "-"),
    },
    {
        key: "actions",
        title: t("tasks.columnActions"),
        dataKey: "actions",
        width: 180,
        flexGrow: 1,
        cellRenderer: ({ rowData }) =>
            h("div", { class: "actions" }, [
                h(
                    ElButton,
                    {
                        class: "actions__button",
                        size: "small",
                        onClick: () => openTaskDetail(rowData.id),
                    },
                    { default: () => t("tasks.view") },
                ),
                ...(rowData.status === "in_progress"
                    ? [
                        h(
                            ElButton,
                            {
                                class: "actions__button",
                                size: "small",
                                onClick: () => handleCompleteTask(rowData.id),
                            },
                            { default: () => t("tasks.complete") },
                        ),
                        h(
                            ElButton,
                            {
                                class: "actions__button",
                                size: "small",
                                type: "danger",
                                plain: true,
                                onClick: () => handleTerminateTask(rowData.id),
                            },
                            { default: () => t("tasks.terminate") },
                        ),
                    ]
                    : []),
            ]),
    },
]);

onMounted(() => {
    void taskStore.initialize();
    taskStore.setPriorityFilter("all");
    taskStore.setStatusFilter(activeStatusTab.value);
    if (!openClawStore.instances.length) {
        void openClawStore.loadInstances();
    }
});

async function handleCreateTask(payload: TaskCreatePayload) {
    try {
        const task = await taskStore.createTask(payload);
        createDrawerVisible.value = false;
        activeStatusTab.value = "in_progress";
        taskStore.setStatusFilter("in_progress");
        detailTaskId.value = task.id;
        detailDrawerVisible.value = true;
        ElMessage.success(`任务“${task.title}”已创建`);
    } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : "创建任务失败");
    }
}

async function handleCompleteTask(taskId: string) {
    try {
        const task = await taskStore.completeTask(taskId);
        if (!task) {
            return;
        }
        ElMessage.success(`任务“${task.title}”已完成`);
    } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : "完成任务失败");
    }
}

async function handleTerminateTask(taskId: string) {
    try {
        const task = await taskStore.terminateTask(taskId);
        if (!task) {
            return;
        }
        ElMessage.success(`任务“${task.title}”已终止`);
    } catch (error) {
        ElMessage.error(error instanceof Error ? error.message : "终止任务失败");
    }
}

function openTaskDetail(taskId: string) {
    detailTaskId.value = taskId;
    // 详情抽屉需要支持父子任务切换，统一复用 store 的递归查找结果。
    taskStore.selectTask(taskId);
    detailDrawerVisible.value = true;
}

function switchStatusTab(status: TaskStatus | "all") {
    activeStatusTab.value = status;
    taskStore.setStatusFilter(status);
    resetVirtualWindow();
}

function handleTabChange(value: string | number) {
    switchStatusTab(String(value) as TaskStatus | "all");
}

function handleKeywordChange(value: string | number) {
    taskStore.setKeyword(String(value ?? ""));
    resetVirtualWindow();
}

function handleRowsRendered(params: { rowCacheEnd: number }) {
    maybeLoadMore(params.rowCacheEnd);
}

function maybeLoadMore(renderedRowEnd: number) {
    const remainingRows = loadedTasks.value.length - renderedRowEnd;
    if (remainingRows > virtualPreloadThresholdRows) {
        return;
    }
    if (loadedTaskCount.value >= filteredTasks.value.length) {
        return;
    }
    loadedTaskCount.value = Math.min(filteredTasks.value.length, loadedTaskCount.value + virtualLoadStep);
}

function resetVirtualWindow() {
    loadedTaskCount.value = Math.min(filteredTasks.value.length, virtualLoadStep);
}

async function reloadTasks() {
    await taskStore.reload();
    resetVirtualWindow();
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
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}
</script>

<style scoped>
.page-header {
  width: 100%;
  gap: 18px;
}

.tasks-tabs {
  width: 100%;
}

.tasks-tabs :deep(.el-tabs__header) {
  margin: 0;
}

.tasks-tabs :deep(.el-tabs__nav-wrap::after) {
  background-color: var(--color-border);
}

.tasks-tabs :deep(.el-tabs__item) {
  height: 42px;
  font-size: 1.02rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.tasks-tabs :deep(.el-tabs__item.is-active) {
  color: var(--color-text-primary);
}

.tasks-tabs :deep(.el-tabs__active-bar) {
  background-color: var(--color-accent);
}

.table-shell {
  display: grid;
  justify-items: stretch;
  gap: 14px;
  align-content: start;
  width: 100%;
  padding: 0;
  background: transparent;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 16px;
}

.toolbar__left,
.toolbar__right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.toolbar__left {
  flex: 0 0 auto;
}

.toolbar__right {
  flex: 1 1 auto;
  justify-content: flex-end;
}

.toolbar__mode {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-bg-panel) 90%, white);
}

.toolbar__mode--server {
  color: #2f7b42;
  background: #edf7f0;
}

.toolbar__mode--demo {
  color: #9f6b00;
  background: #fff4df;
}

.toolbar__search {
  width: min(420px, 100%);
  max-width: 100%;
}

.table-wrap {
  width: 100%;
  min-width: 0;
  border: none;
  border-radius: 0;
  background: #ffffff;
  overflow: hidden;
}

.table-banner {
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
  font-size: 0.92rem;
}

.table-banner--warning {
  color: #8a5b00;
  background: #fff8e8;
}

.task-table-v2 {
  width: 100%;
  height: min(52vh, 520px);
  min-height: 360px;
}

.task-table-v2__table {
  width: 100% !important;
}

.task-table-v2 :deep(.el-table-v2__header-row) {
  background: #ffffff;
  color: var(--color-text-secondary);
  font-weight: 600;
}

.table-empty {
  display: grid;
  place-items: center;
  min-height: 280px;
  padding: 24px;
  color: var(--color-text-secondary);
  text-align: center;
  line-height: 1.8;
}

.task-table-v2 :deep(.el-table-v2__row-cell) {
  border-bottom: 1px solid var(--color-border);
  background: #ffffff;
}

.task-table-v2 :deep(.el-table-v2__header-cell) {
  border-bottom: 1px solid var(--color-border);
  background: #ffffff;
  font-size: 0.94rem;
}

.task-table-v2 :deep(.el-table-v2__header-cell-text),
.task-table-v2 :deep(.el-table-v2__cell-text) {
  min-width: 0;
}

.task-table-v2 :deep(.el-table-v2__row:hover .el-table-v2__row-cell) {
  background: color-mix(in srgb, var(--color-accent) 3%, white);
}

.task-cell--title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 0;
  font-weight: 700;
}

.task-cell__kind {
  flex: 0 0 auto;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-border) 55%, white);
}

.task-cell__kind--parent {
  color: color-mix(in srgb, var(--color-accent) 85%, black);
  background: color-mix(in srgb, var(--color-accent) 12%, white);
}

.task-cell__kind--child {
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-border) 70%, white);
}

.task-cell__title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag,
.status-pill {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 0.8rem;
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

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-start;
  white-space: nowrap;
}

.actions__button {
  min-width: 52px;
}

.table-empty {
  padding: var(--space-6);
  color: var(--color-text-secondary);
  text-align: center;
}

@media (max-width: 960px) {
  .page {
    padding: 16px;
  }

  .page-header {
    gap: 14px;
  }

  .tabs,
  .toolbar {
    flex-wrap: wrap;
  }

  .toolbar__right,
  .toolbar__search {
    width: 100%;
  }

  .task-table-v2 {
    height: 420px;
  }
}
</style>
