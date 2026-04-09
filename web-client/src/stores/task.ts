import { defineStore } from "pinia";

import {
    completeTask as completeTaskRequest,
    createTask as createTaskRequest,
    fetchTasks,
    terminateTask as terminateTaskRequest,
} from "@/api/tasks";
import type { TaskReadApi } from "@/types/api/task";
import type { TaskCreatePayload, TaskFilterState, TaskPriority, TaskStatus, TaskView } from "@/types/view/task";
import { parseServerDateTime } from "@/utils/datetime";

function createDemoTasks(): TaskView[] {
    return [
        {
            id: "task_ui_login",
            parentTaskId: null,
            title: "重构登录页交互与表单校验",
            description: "整理登录页输入反馈、提交态和错误提示，确保移动端和桌面端交互一致。",
            priority: "high",
            status: "in_progress",
            source: "local-demo",
            assignee: {
                instanceId: 1,
                instanceName: "OpenClaw 主节点",
                agentId: 1,
                agentName: "程序员",
                roleName: "前端开发",
            },
            tags: ["前端", "表单", "登录"],
            startedAt: "2026-03-20T08:30:00+08:00",
            endedAt: null,
            createdAt: "2026-03-20T08:30:00+08:00",
            updatedAt: "2026-03-20T10:10:00+08:00",
            commentCount: 3,
            timeline: [
                {
                    id: "task_ui_login_1",
                    type: "system",
                    label: "任务已创建",
                    content: "系统已将任务分配给 Agent[程序员]。",
                    at: "2026-03-20T08:30:00+08:00",
                },
                {
                    id: "task_ui_login_2",
                    type: "agent",
                    label: "Agent 更新",
                    content: "已完成表单校验规则整理，正在处理错误提示样式。",
                    at: "2026-03-20T09:20:00+08:00",
                },
                {
                    id: "task_ui_login_3",
                    type: "user",
                    label: "用户评论",
                    content: "请优先保证移动端输入框在软键盘弹出时不抖动。",
                    at: "2026-03-20T10:10:00+08:00",
                },
            ],
            children: [],
        },
        {
            id: "task_content_plan",
            parentTaskId: null,
            title: "整理产品介绍页文案结构",
            description: "为官网首页输出更清晰的分区文案，包括标题、卖点和 CTA 区域说明。",
            priority: "medium",
            status: "completed",
            source: "local-demo",
            assignee: {
                instanceId: 1,
                instanceName: "OpenClaw 主节点",
                agentId: 2,
                agentName: "作家",
                roleName: "内容策划",
            },
            tags: ["文案", "官网"],
            startedAt: "2026-03-19T13:00:00+08:00",
            endedAt: "2026-03-19T15:40:00+08:00",
            createdAt: "2026-03-19T13:00:00+08:00",
            updatedAt: "2026-03-19T15:40:00+08:00",
            commentCount: 2,
            timeline: [
                {
                    id: "task_content_plan_1",
                    type: "system",
                    label: "任务已创建",
                    content: "系统已将任务分配给 Agent[作家]。",
                    at: "2026-03-19T13:00:00+08:00",
                },
                {
                    id: "task_content_plan_2",
                    type: "system",
                    label: "任务已完成",
                    content: "任务已完成，耗时 2 小时 40 分钟。",
                    at: "2026-03-19T15:40:00+08:00",
                },
            ],
            children: [],
        },
        {
            id: "task_ops_report",
            parentTaskId: null,
            title: "排查统计报表同步延迟",
            description: "检查调度中心到报表服务的同步链路，定位为什么昨日数据延迟入库。",
            priority: "urgent",
            status: "terminated",
            source: "local-demo",
            assignee: {
                instanceId: 2,
                instanceName: "OpenClaw 数据节点",
                agentId: 7,
                agentName: "数据分析师",
                roleName: "数据分析",
            },
            tags: ["报表", "数据", "排障"],
            startedAt: "2026-03-18T17:20:00+08:00",
            endedAt: "2026-03-18T18:05:00+08:00",
            createdAt: "2026-03-18T17:20:00+08:00",
            updatedAt: "2026-03-18T18:05:00+08:00",
            commentCount: 4,
            timeline: [
                {
                    id: "task_ops_report_1",
                    type: "system",
                    label: "任务已创建",
                    content: "系统已将任务分配给 Agent[数据分析师]。",
                    at: "2026-03-18T17:20:00+08:00",
                },
                {
                    id: "task_ops_report_2",
                    type: "agent",
                    label: "Agent 更新",
                    content: "初步确认延迟来自上游源数据缺失，不是同步程序阻塞。",
                    at: "2026-03-18T17:48:00+08:00",
                },
                {
                    id: "task_ops_report_3",
                    type: "system",
                    label: "任务已终止",
                    content: "需求方向变更，当前任务已终止，等待新的排查范围确认。",
                    at: "2026-03-18T18:05:00+08:00",
                },
            ],
            children: [],
        },
    ];
}

function byUpdatedDesc(a: TaskView, b: TaskView) {
    return parseServerDateTime(b.updatedAt).getTime() - parseServerDateTime(a.updatedAt).getTime();
}

function replaceTask(items: TaskView[], nextTask: TaskView): TaskView[] {
    // 父任务和子任务共用同一套递归替换逻辑。
    return items
        .map((task) => {
            if (task.id === nextTask.id) {
                return nextTask;
            }
            if (task.children.length) {
                return {
                    ...task,
                    children: replaceTask(task.children, nextTask),
                };
            }
            return task;
        })
        .sort(byUpdatedDesc);
}

function findTask(items: TaskView[], taskId: string | null): TaskView | null {
    if (!taskId) {
        return null;
    }
    for (const task of items) {
        if (task.id === taskId) {
            return task;
        }
        const child = findTask(task.children, taskId);
        if (child) {
            return child;
        }
    }
    return null;
}

function flattenTasks(items: TaskView[], level = 0): TaskView[] {
    // 列表组件使用扁平行数据，通过 level 表达层级。
    return items.flatMap((task) => [
        { ...task, level },
        ...flattenTasks(task.children, level + 1),
    ]);
}

function toTaskView(task: TaskReadApi): TaskView {
    return {
        id: task.id,
        parentTaskId: task.parent_task_id ?? null,
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
        source: task.source,
        assignee: {
            instanceId: task.assignee.instance_id,
            instanceName: task.assignee.instance_name,
            agentId: task.assignee.agent_id,
            agentName: task.assignee.agent_name,
            roleName: task.assignee.role_name,
        },
        tags: task.tags,
        startedAt: task.started_at,
        endedAt: task.ended_at,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        commentCount: task.comment_count,
        timeline: task.timeline.map((entry) => ({
            id: entry.id,
            type: entry.type,
            label: entry.label,
            content: entry.content,
            at: entry.at,
        })),
        // 递归转换后端层级结构，供列表和详情共用。
        children: task.children.map(toTaskView).sort(byUpdatedDesc),
    };
}

export const useTaskStore = defineStore("task", {
    state: () => ({
        items: [] as TaskView[],
        loading: false,
        creating: false,
        loadError: "" as string,
        backendMode: "unknown" as "unknown" | "server" | "demo",
        selectedTaskId: null as string | null,
        filters: {
            keyword: "",
            status: "all",
            priority: "all",
        } as TaskFilterState,
    }),
    getters: {
        filteredTasks(state): TaskView[] {
            const keyword = state.filters.keyword.trim().toLowerCase();
            return flattenTasks(state.items)
                .filter((task) => {
                    if (state.filters.status !== "all" && task.status !== state.filters.status) {
                        return false;
                    }
                    if (state.filters.priority !== "all" && task.priority !== state.filters.priority) {
                        return false;
                    }
                    if (!keyword) {
                        return true;
                    }
                    const haystacks = [
                        task.title,
                        task.description,
                        task.assignee.agentName,
                        task.assignee.instanceName,
                        ...task.tags,
                    ];
                    return haystacks.some((value) => value.toLowerCase().includes(keyword));
                });
        },
        selectedTask(state): TaskView | null {
            return findTask(state.items, state.selectedTaskId);
        },
        stats(state) {
            return {
                total: state.items.length,
                inProgress: state.items.filter((item) => item.status === "in_progress").length,
                completed: state.items.filter((item) => item.status === "completed").length,
                urgent: state.items.filter((item) => item.priority === "urgent").length,
            };
        },
    },
    actions: {
        async initialize() {
            await this.reload();
        },
        async reload() {
            this.loading = true;
            this.loadError = "";
            try {
                const tasks = await fetchTasks({
                    status: "all",
                    keyword: "",
                });
                this.items = tasks.map(toTaskView).sort(byUpdatedDesc);
                this.backendMode = "server";
                this.selectedTaskId = this.items[0]?.id ?? null;
            } catch (error) {
                this.items = createDemoTasks().sort(byUpdatedDesc);
                this.backendMode = "demo";
                this.selectedTaskId = this.items[0]?.id ?? null;
                this.loadError = error instanceof Error ? error.message : "加载真实任务失败，已切换到本地演示数据。";
            } finally {
                this.loading = false;
            }
        },
        selectTask(taskId: string) {
            this.selectedTaskId = taskId;
        },
        setKeyword(keyword: string) {
            this.filters.keyword = keyword;
        },
        setStatusFilter(status: TaskStatus | "all") {
            this.filters.status = status;
        },
        setPriorityFilter(priority: TaskPriority | "all") {
            this.filters.priority = priority;
        },
        async createTask(payload: TaskCreatePayload) {
            this.creating = true;
            try {
                if (this.backendMode === "server") {
                    const created = await createTaskRequest({
                        title: payload.title,
                        description: payload.description,
                        priority: payload.priority,
                        tags: payload.tags,
                        assignee_instance_id: payload.assignee.instanceId,
                        assignee_agent_id: payload.assignee.agentId,
                        children: payload.children,
                    });
                    const task = toTaskView(created);
                    this.items = [task, ...this.items.filter((item) => item.id !== task.id)].sort(byUpdatedDesc);
                    this.selectedTaskId = task.id;
                    return task;
                }

                if (this.backendMode !== "demo") {
                    try {
                        const created = await createTaskRequest({
                            title: payload.title,
                            description: payload.description,
                            priority: payload.priority,
                            tags: payload.tags,
                            assignee_instance_id: payload.assignee.instanceId,
                            assignee_agent_id: payload.assignee.agentId,
                            children: payload.children,
                        });
                        const task = toTaskView(created);
                        this.items = [task, ...this.items.filter((item) => item.id !== task.id)].sort(byUpdatedDesc);
                        this.selectedTaskId = task.id;
                        this.backendMode = "server";
                        this.loadError = "";
                        return task;
                    } catch {
                        this.backendMode = "demo";
                    }
                }
                const now = new Date().toISOString();
                const task: TaskView = {
                    id: `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                    parentTaskId: null,
                    title: payload.title,
                    description: payload.description,
                    priority: payload.priority,
                    status: "in_progress",
                    source: "local-demo",
                    assignee: payload.assignee,
                    tags: payload.tags,
                    startedAt: now,
                    endedAt: null,
                    createdAt: now,
                    updatedAt: now,
                    commentCount: 1,
                    timeline: [
                        {
                            id: `timeline_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                            type: "system",
                            label: "任务已创建",
                            content: `系统已将任务分配给 Agent[${payload.assignee.agentName}]。`,
                            at: now,
                        },
                    ],
                    children: payload.children.map((child) => ({
                        id: `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                        parentTaskId: null,
                        title: child.title,
                        description: child.description,
                        priority: child.priority,
                        status: "in_progress",
                        source: "local-demo",
                        assignee: payload.assignee,
                        tags: child.tags,
                        startedAt: now,
                        endedAt: null,
                        createdAt: now,
                        updatedAt: now,
                        commentCount: 1,
                        timeline: [
                            {
                                id: `timeline_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                                type: "system",
                                label: "任务已创建",
                                content: `系统已将任务分配给 Agent[${payload.assignee.agentName}]。`,
                                at: now,
                            },
                        ],
                        children: [],
                    })),
                };
                task.children = task.children.map((child) => ({
                    ...child,
                    parentTaskId: task.id,
                }));
                this.items = [task, ...this.items].sort(byUpdatedDesc);
                this.selectedTaskId = task.id;
                return task;
            } finally {
                this.creating = false;
            }
        },
        async completeTask(taskId: string, comment?: string) {
            if (this.backendMode === "server") {
                const updated = await completeTaskRequest(taskId, comment);
                const nextTask = toTaskView(updated);
                this.items = replaceTask(this.items, nextTask);
                this.selectedTaskId = nextTask.id;
                return nextTask;
            }
            if (this.backendMode !== "demo") {
                try {
                    const updated = await completeTaskRequest(taskId, comment);
                    const nextTask = toTaskView(updated);
                    this.items = replaceTask(this.items, nextTask);
                    this.selectedTaskId = nextTask.id;
                    this.backendMode = "server";
                    this.loadError = "";
                    return nextTask;
                } catch {
                    this.backendMode = "demo";
                }
            }
            const task = this.items.find((item) => item.id === taskId);
            if (!task || task.status !== "in_progress") {
                return null;
            }
            const now = new Date().toISOString();
            const nextTask: TaskView = {
                ...task,
                status: "completed",
                endedAt: now,
                updatedAt: now,
                commentCount: task.commentCount + 1,
                timeline: [
                    ...task.timeline,
                    {
                        id: `timeline_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                        type: "system",
                        label: "任务已完成",
                        content: comment?.trim()
                            ? `任务已完成。备注：${comment.trim()}`
                            : "任务已完成，等待后续结果确认。",
                        at: now,
                    },
                ],
            };
            this.items = replaceTask(this.items, nextTask);
            this.selectedTaskId = nextTask.id;
            return nextTask;
        },
        async terminateTask(taskId: string, reason?: string) {
            if (this.backendMode === "server") {
                const updated = await terminateTaskRequest(taskId, reason);
                const nextTask = toTaskView(updated);
                this.items = replaceTask(this.items, nextTask);
                this.selectedTaskId = nextTask.id;
                return nextTask;
            }
            if (this.backendMode !== "demo") {
                try {
                    const updated = await terminateTaskRequest(taskId, reason);
                    const nextTask = toTaskView(updated);
                    this.items = replaceTask(this.items, nextTask);
                    this.selectedTaskId = nextTask.id;
                    this.backendMode = "server";
                    this.loadError = "";
                    return nextTask;
                } catch {
                    this.backendMode = "demo";
                }
            }
            const task = this.items.find((item) => item.id === taskId);
            if (!task || task.status !== "in_progress") {
                return null;
            }
            const now = new Date().toISOString();
            const nextTask: TaskView = {
                ...task,
                status: "terminated",
                endedAt: now,
                updatedAt: now,
                commentCount: task.commentCount + 1,
                timeline: [
                    ...task.timeline,
                    {
                        id: `timeline_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
                        type: "system",
                        label: "任务已终止",
                        content: reason?.trim()
                            ? `任务已终止。原因：${reason.trim()}`
                            : "任务已终止，等待新的需求安排。",
                        at: now,
                    },
                ],
            };
            this.items = replaceTask(this.items, nextTask);
            this.selectedTaskId = nextTask.id;
            return nextTask;
        },
    },
});
