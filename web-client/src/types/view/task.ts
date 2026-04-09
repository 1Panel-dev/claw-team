/**
 * 任务模块在前端展示层使用的 ViewModel。
 */

export type TaskStatus = "in_progress" | "completed" | "terminated";

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type TaskSource = "local-demo" | "server";

export interface TaskAssigneeView {
    instanceId: number;
    instanceName: string;
    agentId: number;
    agentName: string;
    roleName?: string | null;
}

export interface TaskTimelineEntryView {
    id: string;
    type: "system" | "user" | "agent";
    label: string;
    content: string;
    at: string;
}

export interface TaskView {
    id: string;
    parentTaskId?: string | null;
    title: string;
    description: string;
    priority: TaskPriority;
    status: TaskStatus;
    source: TaskSource;
    assignee: TaskAssigneeView;
    tags: string[];
    startedAt: string;
    endedAt: string | null;
    createdAt: string;
    updatedAt: string;
    commentCount: number;
    timeline: TaskTimelineEntryView[];
    children: TaskView[];
    level?: number;
}

export interface TaskFilterState {
    keyword: string;
    status: TaskStatus | "all";
    priority: TaskPriority | "all";
}

export interface TaskCreatePayload {
    title: string;
    description: string;
    priority: TaskPriority;
    tags: string[];
    assignee: TaskAssigneeView;
    children: Array<{
        title: string;
        description: string;
        priority: TaskPriority;
        tags: string[];
    }>;
}
