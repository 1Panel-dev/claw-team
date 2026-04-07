import crypto from "node:crypto";

import { sendEventWithRetry } from "../callback/retry.js";
import type { ClawSwarmCallbackClient, ClawSwarmEvent } from "../callback/client.js";
import type { AccountConfig } from "../config.js";
import type { Logger } from "../observability/logger.js";
import type { InboundMessage } from "../router/resolveRoute.js";

// emitDirectEvent 统一负责构造事件对象并走带重试的回调发送。
export async function emitDirectEvent(params: {
    clawSwarm: ClawSwarmCallbackClient;
    baseLog: Logger;
    accountConfig: AccountConfig;
    eventType: ClawSwarmEvent["eventType"];
    inbound: InboundMessage;
    agentId: string;
    sessionKey: string;
    payload: Record<string, unknown>;
}): Promise<void> {
    const ev: ClawSwarmEvent = {
        // eventId 是回调事件自身的唯一标识，不等同于 messageId。
        eventId: crypto.randomUUID(),
        eventType: params.eventType,
        correlation: {
            messageId: params.inbound.messageId,
            chatId: params.inbound.chat.chatId,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
        },
        payload: params.payload,
        timestamp: Date.now(),
    };

    await sendEventWithRetry({
        client: params.clawSwarm,
        event: ev,
        policy: params.accountConfig.retry,
        logger: params.baseLog,
    });
}
