import type { GatewayRuntimeConfig } from "../config.js";

// 上层 dispatcher 统一消费“文本 chunk 流”，不关心底层到底是 HTTP 还是 plugin runtime。
export type OpenClawRunChunk = { text: string; isFinal?: boolean };

export interface OpenClawRuntimeAdapter {
    // 每次 turn 都按“指定 agent + 指定 session”执行，并持续产出 chunk。
    runAgentTextTurn(params: {
        agentId: string;
        channelId: string;
        accountId: string;
        sessionKey: string;
        peer: { kind: "direct" | "group"; id: string; threadId?: string };
        from: { userId: string; displayName?: string };
        text: string;
        gateway: GatewayRuntimeConfig;
    }): AsyncIterable<OpenClawRunChunk>;
}

// 这里只声明当前 adapter 真正依赖到的最小宿主能力，避免上层到处透传 any。
export type RuntimeLike = { logger?: any; runtime?: any };

export type AgentTurnParams = Parameters<OpenClawRuntimeAdapter["runAgentTextTurn"]>[0];
