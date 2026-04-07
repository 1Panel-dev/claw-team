import type { Logger } from "../observability/logger.js";
import { CHANNEL_ID, type AccountConfig } from "../config.js";
import { AGENT_DIALOGUE_START_KIND, parseAgentDialogueStartPayload } from "./sendTextContract.js";
import { postClawSwarmSendText } from "./sendTextHttp.js";
import { normalizeTargetCsId } from "./sendTextTarget.js";

type SendTextContext = {
    cfg: unknown;
    to: string;
    text: string;
    accountId?: string | null;
    replyToId?: string | null;
    threadId?: string | number | null;
    identity?: unknown;
    deps?: unknown;
    silent?: boolean;
};

type SendTextResult = {
    messageId: string;
    conversationId?: string;
    meta?: Record<string, unknown>;
};

export async function sendClawSwarmText(params: {
    ctx: SendTextContext;
    account: AccountConfig;
    logger: Logger;
}): Promise<SendTextResult> {
    let targetCsId = "";
    try {
        targetCsId = normalizeTargetCsId(params.ctx.to);
    } catch {
        params.logger.warn(
            {
                rawTarget: String(params.ctx.to ?? ""),
            },
            "ClawSwarm sendText received an invalid CT target",
        );
        throw new Error("clawswarm_invalid_target_cs_id");
    }

    const payload = parseAgentDialogueStartPayload(params.ctx.text);

    try {
        const response = await postClawSwarmSendText({
            account: params.account,
            payload: {
                kind: payload.kind,
                sourceCsId: payload.sourceCsId,
                targetCsId,
                topic: payload.topic,
                message: payload.message,
                ...(payload.windowSeconds !== undefined ? { windowSeconds: payload.windowSeconds } : {}),
                ...(payload.softMessageLimit !== undefined ? { softMessageLimit: payload.softMessageLimit } : {}),
                ...(payload.hardMessageLimit !== undefined ? { hardMessageLimit: payload.hardMessageLimit } : {}),
            },
        });

        return {
            messageId: response.openingMessageId || `clawswarm:${CHANNEL_ID}:${response.dialogueId || "unknown"}`,
            ...(response.conversationId > 0 ? { conversationId: String(response.conversationId) } : {}),
            meta: {
                kind: AGENT_DIALOGUE_START_KIND,
                dialogueId: response.dialogueId,
                conversationId: response.conversationId,
                targetCsId,
            },
        };
    } catch (error) {
        const detail =
            error instanceof Error && "detail" in error && typeof error.detail === "string"
                ? error.detail
                : undefined;
        params.logger.warn(
            {
                targetCsId,
                sourceCsId: payload.sourceCsId,
                body: detail,
                error: error instanceof Error ? error.message : String(error),
            },
            "ClawSwarm sendText request failed",
        );
        throw error;
    }
}
