/**
 * 这个文件集中放置跨模块共享的业务类型。
 * 维护时优先在这里统一术语，避免 http/router/dispatcher 各自定义一套名字。
 */
export type RoutingMode = "DIRECT" | "GROUP_BROADCAST" | "GROUP_MENTION";

// 这是消息在插件内部流转时的状态机。
export type MessageStage =
    | "RECEIVED"
    | "VALIDATED"
    | "ROUTED"
    | "DISPATCHED"
    | "RESPONDED"
    | "CALLBACK_SENT"
    | "FAILED";

// 对外展示 Agent 列表时使用的稳定结构。
export interface AgentDescriptor {
    id: string;
    name: string;
    openclawAgentRef: string;
}

// 对外展示群组信息时使用的稳定结构。
export interface GroupDescriptor {
    groupId: string;
    name: string;
    members: string[];
}

// 这是消息状态表的单条记录结构，主要用于调试、排障和后续落持久化存储。
export interface MessageStateRecord {
    messageId: string;
    traceId: string;
    accountId: string;
    conversationId: string;
    groupId?: string;
    routingMode?: RoutingMode;
    targetAgentIds: string[];
    sessionKeys: string[];
    status: MessageStage;
    error?: string;
    createdAt: string;
    lastUpdated: string;
}

// 这是 channel 回推给 ClawSwarm 调度中心的富内容片段结构。
// 当前先支持 markdown / attachment / tool_card，后面如果 OpenClaw
// 回调里要补图片、音频或更多工具卡片，也沿着这里扩展即可。
export type CallbackMessagePart =
    | {
          kind: "markdown";
          content: string;
      }
    | {
          kind: "attachment";
          name: string;
          mimeType: string | null;
          url: string;
      }
    | {
          kind: "tool_card";
          title: string;
          status: "pending" | "running" | "completed" | "failed";
          summary: string;
      };
