import fs from "node:fs";
import crypto from "node:crypto";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { Logger } from "../observability/logger.js";
import { clearLocalOriginSession, isLocalOriginSession } from "./mirrorOriginRegistry.js";

const WEBCHAT_MIRROR_LOG_PATH = "/tmp/claw-team-webchat-mirror.log";
const CHANNEL_ID = "claw-team";
const WEBCHAT_CHANNEL_ID = "webchat";
const AGENT_SESSION_PREFIX = "agent:";
const WEBCHAT_MIRROR_PATH = "/api/v1/claw-team/webchat-mirror";
const ASSISTANT_SENDER_TYPE = "assistant";
const USER_SENDER_TYPE = "user";
const INTERNAL_DIALOGUE_USER_PREFIX = "[Claw Team Agent Dialogue]";
const PENDING_WEBCHAT_TURN_TTL_MS = 60_000;
const ACTIVE_SESSION_TTL_MS = 10 * 60_000;

const MIRROR_HOOK_EVENTS = [
    "message_received",
    "before_dispatch",
    "before_tool_call",
    "tool_result_persist",
    "before_message_write",
    "llm_output",
] as const;

type ClawTeamAccountConfig = {
    baseUrl?: string;
    outboundToken?: string;
    webchatMirror?: {
        includeIntermediateMessages?: boolean;
    };
};

type HookEvent = {
    type?: string;
    action?: string;
    sessionKey?: string;
    content?: string;
    channel?: string;
    toolName?: string;
    toolCallId?: string;
    params?: Record<string, unknown>;
    runId?: string;
    sessionId?: string;
    provider?: string;
    model?: string;
    assistantTexts?: string[];
    lastAssistant?: unknown;
    usage?: Record<string, unknown>;
    success?: boolean;
    error?: string;
    durationMs?: number;
    message?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    from?: string;
    context?: {
        cfg?: Record<string, any>;
        channelId?: string;
        content?: string;
        messageId?: string;
        conversationId?: string;
    };
};

type HookContext = {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    senderId?: string;
    agentId?: string;
    sessionId?: string;
    runId?: string;
    toolName?: string;
    toolCallId?: string;
};

type TranscriptRecord = {
    id?: string;
    parentId?: string;
    message?: {
        role?: string;
        stopReason?: string;
        content?: Array<{
            type?: string;
            text?: string;
        }>;
        [key: string]: unknown;
    };
};

type TranscriptContentPart = {
    type?: string;
    text?: string;
    name?: string;
    arguments?: unknown;
    [key: string]: unknown;
};

type CompletedAssistantMessage = {
    messageId: string;
    content: string;
    parentId: string;
};

type CompletedUserMessage = {
    messageId: string;
    content: string;
};

type MirrorableTranscriptMessage = {
    messageId: string;
    content: string;
    isTerminalAssistant: boolean;
};

type PendingInboundTurn = {
    content: string;
    messageId: string;
    conversationId?: string;
    receivedAt: number;
};

type MirrorPayload = {
    channelId: string;
    sessionKey: string;
    messageId: string;
    senderType: "user" | "assistant";
    content: string;
    timestamp: number;
};

type MirrorRuntimeState = {
    pendingInboundTurns: PendingInboundTurn[];
    activeWebchatSessions: Map<string, number>;
    sentMirrorMessageIds: Set<string>;
    sessionQueues: Map<string, Promise<void>>;
};

function createMirrorRuntimeState(): MirrorRuntimeState {
    return {
        pendingInboundTurns: [],
        activeWebchatSessions: new Map(),
        sentMirrorMessageIds: new Set(),
        sessionQueues: new Map(),
    };
}

function appendMirrorLog(stage: string, fields: Record<string, unknown> = {}) {
    try {
        fs.appendFileSync(
            WEBCHAT_MIRROR_LOG_PATH,
            `${JSON.stringify({
                ts: new Date().toISOString(),
                stage,
                ...fields,
            })}\n`,
            "utf8",
        );
    } catch {
        return;
    }
}

function sanitizeForJson(value: unknown, depth = 0): unknown {
    if (value == null) {
        return value;
    }
    if (depth >= 6) {
        return "[max-depth]";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "function") {
        return `[function:${value.name || "anonymous"}]`;
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForJson(item, depth + 1));
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
                key,
                sanitizeForJson(item, depth + 1),
            ]),
        );
    }
    return String(value);
}

function readAccountFromConfig(config: any, accountId?: string): ClawTeamAccountConfig | null {
    const account =
        config?.channels?.[CHANNEL_ID]?.accounts?.[accountId ?? "default"] &&
        typeof config.channels[CHANNEL_ID].accounts[accountId ?? "default"] === "object"
            ? (config.channels[CHANNEL_ID].accounts[accountId ?? "default"] as Record<string, unknown>)
            : null;

    if (!account) {
        return null;
    }

    return {
        baseUrl: typeof account.baseUrl === "string" ? account.baseUrl.trim() : undefined,
        outboundToken: typeof account.outboundToken === "string" ? account.outboundToken.trim() : undefined,
        webchatMirror:
            account.webchatMirror && typeof account.webchatMirror === "object"
                ? {
                      includeIntermediateMessages:
                          typeof (account.webchatMirror as Record<string, unknown>).includeIntermediateMessages === "boolean"
                              ? ((account.webchatMirror as Record<string, unknown>)
                                    .includeIntermediateMessages as boolean)
                              : undefined,
                  }
                : undefined,
    };
}

function normalizeText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeSessionKey(value: unknown): string {
    const sessionKey = normalizeText(value);
    return sessionKey.startsWith(AGENT_SESSION_PREFIX) ? sessionKey : "";
}

function getEventContent(event: HookEvent): string {
    return normalizeText(event.content ?? event.context?.content);
}

function getEventMessageId(event: HookEvent): string {
    if (typeof event.context?.messageId === "string" && event.context.messageId.trim()) {
        return event.context.messageId.trim();
    }
    if (typeof event.metadata?.messageId === "string" && event.metadata.messageId.trim()) {
        return event.metadata.messageId.trim();
    }
    return "";
}

function isWebchatContext(event: HookEvent, ctx: HookContext | undefined): boolean {
    return (
        normalizeText(ctx?.channelId) === WEBCHAT_CHANNEL_ID ||
        normalizeText(event.context?.channelId) === WEBCHAT_CHANNEL_ID ||
        normalizeText(event.channel) === WEBCHAT_CHANNEL_ID
    );
}

function buildSha1(input: string): string {
    return crypto.createHash("sha1").update(input).digest("hex");
}

function buildMirrorMessageId(prefix: string, ...parts: Array<string | number | undefined | null>): string {
    return [prefix, ...parts.filter((part) => part != null && String(part).trim().length > 0).map(String)].join(":");
}

function summarizeToolArguments(value: unknown): string {
    if (typeof value === "string") {
        return value.trim();
    }
    try {
        return JSON.stringify(value, null, 2).trim();
    } catch {
        return String(value ?? "").trim();
    }
}

function summarizeUnknownPart(type: string, payload: unknown): string {
    const body = summarizeToolArguments(payload) || "{}";
    return `Transcript part (${type}):\n\`\`\`json\n${body}\n\`\`\``;
}

function buildToolCardMarker(title: string, status: string, summary: string): string {
    const safeTitle = title.replace(/[|\]]/g, " ").trim();
    const safeSummary = summary.replace(/[|\]]/g, " ").trim();
    return `[[tool:${safeTitle}|${status}|${safeSummary}]]`;
}

function extractAssistantText(record: TranscriptRecord | null): CompletedAssistantMessage | null {
    if (!record?.id || record.message?.role !== "assistant" || !Array.isArray(record.message.content)) {
        return null;
    }
    const stopReason = String(record.message.stopReason ?? "");
    if (stopReason && stopReason !== "stop") {
        return null;
    }
    const chunks = record.message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text!.trim())
        .filter(Boolean);
    if (!chunks.length) {
        return null;
    }
    return {
        messageId: record.id.trim(),
        content: chunks.join("\n\n"),
        parentId: typeof record.parentId === "string" ? record.parentId.trim() : "",
    };
}

function extractTextChunks(parts: TranscriptContentPart[] | undefined): string[] {
    if (!Array.isArray(parts)) {
        return [];
    }
    return parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text!.trim())
        .filter(Boolean);
}

function buildMirrorableTranscriptMessage(record: TranscriptRecord | null): MirrorableTranscriptMessage | null {
    if (!record?.id || !record.message) {
        return null;
    }

    const role = record.message.role;
    const contentParts = record.message.content;
    const chunks: string[] = [];

    if (role === "assistant") {
        if (Array.isArray(contentParts)) {
            for (const part of contentParts as TranscriptContentPart[]) {
                if (!part || typeof part !== "object") {
                    continue;
                }
                const type = part.type;
                if (!type || type === "thinking") {
                    continue;
                }
                if (type === "text") {
                    const text = typeof part.text === "string" ? part.text.trim() : "";
                    if (text) {
                        chunks.push(text);
                    }
                    continue;
                }
                if (type !== "toolCall") {
                    chunks.push(summarizeUnknownPart(type, part));
                    continue;
                }
                const toolName = String(part.name ?? "tool").trim();
                const argumentsSummary = summarizeToolArguments(part.arguments);
                chunks.push(buildToolCardMarker(toolName || "tool", "running", argumentsSummary || "tool call"));
            }
        }

        if (!chunks.length) {
            return null;
        }

        return {
            messageId: record.id.trim(),
            content: chunks.join("\n\n"),
            isTerminalAssistant: String(record.message.stopReason ?? "") === "stop",
        };
    }

    if (role === "toolResult") {
        const toolName = String((record.message as Record<string, unknown>).toolName ?? "tool").trim();
        const textChunks = extractTextChunks(contentParts as TranscriptContentPart[] | undefined);
        const details = (record.message as Record<string, unknown>).details;
        const detailsStatus =
            details && typeof details === "object"
                ? String((details as Record<string, unknown>).status ?? "").trim().toLowerCase()
                : "";
        const extraParts = Array.isArray(contentParts)
            ? contentParts
                  .filter((part) => part?.type && part.type !== "text" && part.type !== "thinking")
                  .map((part) => summarizeUnknownPart(String(part?.type ?? "unknown"), part))
            : [];
        const summary =
            [textChunks.join("\n\n"), extraParts.join("\n\n"), summarizeToolArguments(details)]
                .filter(Boolean)
                .join("\n\n") || "tool result";
        const status = detailsStatus === "error" ? "failed" : "completed";

        return {
            messageId: record.id.trim(),
            content: buildToolCardMarker(toolName || "tool", status, summary),
            isTerminalAssistant: false,
        };
    }

    return null;
}

function extractUserMessageId(record: TranscriptRecord | null): CompletedUserMessage | null {
    if (!record?.id || record.message?.role !== "user") {
        return null;
    }
    const chunks = Array.isArray(record.message.content)
        ? record.message.content
              .filter((part) => part?.type === "text" && typeof part.text === "string")
              .map((part) => part.text!.trim())
              .filter(Boolean)
        : [];
    return {
        messageId: record.id.trim(),
        content: chunks.join("\n\n"),
    };
}

function isInternalDialogueUserMessage(content: string): boolean {
    return content.trim().startsWith(INTERNAL_DIALOGUE_USER_PREFIX);
}

export function findAssistantReplyForTranscriptUser(
    transcript: string,
    transcriptUserMessageId: string,
): CompletedAssistantMessage | null {
    const lines = transcript.split(/\r?\n/).filter((line) => line.trim());
    const parsedRecords: TranscriptRecord[] = [];
    for (const line of lines) {
        try {
            parsedRecords.push(JSON.parse(line) as TranscriptRecord);
        } catch {
            continue;
        }
    }

    const sourceIndex = parsedRecords.findIndex((record) => record.id?.trim() === transcriptUserMessageId);
    if (sourceIndex < 0) {
        return null;
    }

    let latestAssistant: CompletedAssistantMessage | null = null;
    for (let i = sourceIndex + 1; i < parsedRecords.length; i += 1) {
        const record = parsedRecords[i];
        const userMessage = extractUserMessageId(record);
        if (userMessage && !isInternalDialogueUserMessage(userMessage.content)) {
            break;
        }

        const assistantMessage = extractAssistantText(record);
        if (assistantMessage) {
            latestAssistant = assistantMessage;
        }
    }

    return latestAssistant;
}

export function findMirrorableMessagesForTranscriptUser(
    transcript: string,
    transcriptUserMessageId: string,
): MirrorableTranscriptMessage[] {
    const lines = transcript.split(/\r?\n/).filter((line) => line.trim());
    const parsedRecords: TranscriptRecord[] = [];
    for (const line of lines) {
        try {
            parsedRecords.push(JSON.parse(line) as TranscriptRecord);
        } catch {
            continue;
        }
    }

    const sourceIndex = parsedRecords.findIndex((record) => record.id?.trim() === transcriptUserMessageId);
    if (sourceIndex < 0) {
        return [];
    }

    const messages: MirrorableTranscriptMessage[] = [];
    for (let i = sourceIndex + 1; i < parsedRecords.length; i += 1) {
        const record = parsedRecords[i];
        const userMessage = extractUserMessageId(record);
        if (userMessage && !isInternalDialogueUserMessage(userMessage.content)) {
            break;
        }

        const mirrorable = buildMirrorableTranscriptMessage(record);
        if (mirrorable) {
            messages.push(mirrorable);
        }
    }

    return messages;
}

function prunePendingInboundTurns(state: MirrorRuntimeState, now = Date.now()): void {
    state.pendingInboundTurns = state.pendingInboundTurns.filter((turn) => now - turn.receivedAt <= PENDING_WEBCHAT_TURN_TTL_MS);
}

function pruneActiveWebchatSessions(state: MirrorRuntimeState, now = Date.now()): void {
    for (const [sessionKey, lastSeenAt] of state.activeWebchatSessions.entries()) {
        if (now - lastSeenAt > ACTIVE_SESSION_TTL_MS) {
            state.activeWebchatSessions.delete(sessionKey);
        }
    }
}

function markWebchatSessionActive(state: MirrorRuntimeState, sessionKey: string, now = Date.now()): void {
    if (!sessionKey) {
        return;
    }
    pruneActiveWebchatSessions(state, now);
    state.activeWebchatSessions.set(sessionKey, now);
}

function isTrackedWebchatSession(state: MirrorRuntimeState, sessionKey: string, now = Date.now()): boolean {
    pruneActiveWebchatSessions(state, now);
    const lastSeenAt = state.activeWebchatSessions.get(sessionKey);
    return typeof lastSeenAt === "number";
}

function trackInboundWebchatTurn(state: MirrorRuntimeState, event: HookEvent): void {
    const content = getEventContent(event);
    const messageId = getEventMessageId(event);
    if (!content || !messageId) {
        return;
    }
    prunePendingInboundTurns(state);
    state.pendingInboundTurns.push({
        content,
        messageId,
        conversationId: normalizeText(event.context?.conversationId),
        receivedAt: Date.now(),
    });
}

function consumePendingInboundTurn(state: MirrorRuntimeState, content: string): PendingInboundTurn | null {
    prunePendingInboundTurns(state);
    for (let i = state.pendingInboundTurns.length - 1; i >= 0; i -= 1) {
        const candidate = state.pendingInboundTurns[i];
        if (candidate.content === content) {
            state.pendingInboundTurns.splice(i, 1);
            return candidate;
        }
    }
    return null;
}

function buildBeforeToolCallPayload(event: HookEvent, ctx: HookContext): MirrorPayload | null {
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    const toolName = normalizeText(event.toolName ?? ctx.toolName) || "tool";
    if (!sessionKey) {
        return null;
    }
    return {
        channelId: WEBCHAT_CHANNEL_ID,
        sessionKey,
        messageId:
            buildMirrorMessageId("tool-call", sessionKey, event.toolCallId ?? ctx.toolCallId) ||
            buildMirrorMessageId("tool-call", sessionKey, buildSha1(JSON.stringify(event.params ?? {}))),
        senderType: ASSISTANT_SENDER_TYPE,
        content: buildToolCardMarker(toolName, "running", summarizeToolArguments(event.params ?? {})),
        timestamp: Date.now(),
    };
}

function buildToolResultPayload(event: HookEvent, ctx: HookContext): MirrorPayload | null {
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    if (!sessionKey || !event.message) {
        return null;
    }
    const fakeRecord: TranscriptRecord = {
        id:
            buildMirrorMessageId("tool-result", sessionKey, event.toolCallId ?? ctx.toolCallId) ||
            buildMirrorMessageId("tool-result", sessionKey, buildSha1(JSON.stringify(event.message))),
        message: event.message as TranscriptRecord["message"],
    };
    const mirrorable = buildMirrorableTranscriptMessage(fakeRecord);
    if (!mirrorable) {
        return null;
    }
    return {
        channelId: WEBCHAT_CHANNEL_ID,
        sessionKey,
        messageId: mirrorable.messageId,
        senderType: ASSISTANT_SENDER_TYPE,
        content: mirrorable.content,
        timestamp: Date.now(),
    };
}

function buildBeforeMessageWritePayload(event: HookEvent, ctx: HookContext): MirrorPayload | null {
    const sessionKey = normalizeSessionKey(event.sessionKey ?? ctx.sessionKey);
    const message = event.message;
    if (!sessionKey || !message || typeof message !== "object") {
        return null;
    }
    const role = normalizeText(message.role);
    if (!role || role === "user") {
        return null;
    }
    if (role === "toolResult") {
        return null;
    }
    if (role === "assistant" && normalizeText(message.stopReason) === "stop") {
        return null;
    }
    const transcriptTextChunks = Array.isArray(message.content)
        ? message.content
              .filter((part) => part?.type === "text" && typeof part.text === "string")
              .map((part) => part.text!.trim())
              .filter(Boolean)
        : [];
    if (!transcriptTextChunks.length) {
        return null;
    }
    const fakeRecord: TranscriptRecord = {
        id: buildMirrorMessageId(
            "transcript-write",
            sessionKey,
            role,
            buildSha1(JSON.stringify(sanitizeForJson(message))),
        ),
        message: {
            role,
            stopReason: normalizeText(message.stopReason) || undefined,
            content: transcriptTextChunks.map((text) => ({ type: "text", text })),
        },
    };
    const mirrorable = buildMirrorableTranscriptMessage(fakeRecord);
    if (!mirrorable) {
        return null;
    }
    return {
        channelId: WEBCHAT_CHANNEL_ID,
        sessionKey,
        messageId: mirrorable.messageId,
        senderType: ASSISTANT_SENDER_TYPE,
        content: mirrorable.content,
        timestamp: Date.now(),
    };
}

function buildLlmOutputPayloads(event: HookEvent, ctx: HookContext): MirrorPayload[] {
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    if (!sessionKey || !Array.isArray(event.assistantTexts) || !event.assistantTexts.length) {
        return [];
    }
    const normalizedTexts = event.assistantTexts.map((text) => normalizeText(text)).filter(Boolean);
    const lastContent = normalizedTexts.at(-1);
    if (!lastContent) {
        return [];
    }
    return [
        {
            channelId: WEBCHAT_CHANNEL_ID,
            sessionKey,
            messageId: buildMirrorMessageId("llm-output", sessionKey, event.runId, normalizedTexts.length - 1),
            senderType: ASSISTANT_SENDER_TYPE,
            content: lastContent,
            timestamp: Date.now(),
        },
    ];
}

function shouldIncludeIntermediateMessages(api: OpenClawPluginApi, event: HookEvent, ctx: HookContext): boolean {
    const config = event.context?.cfg ?? api.runtime?.config?.loadConfig?.() ?? api.config;
    return readAccountFromConfig(config, ctx.accountId)?.webchatMirror?.includeIntermediateMessages ?? true;
}

function readMirrorConfig(api: OpenClawPluginApi, event: HookEvent, ctx: HookContext): {
    baseUrl: string;
    outboundToken: string;
} | null {
    const config = event.context?.cfg ?? api.runtime?.config?.loadConfig?.() ?? api.config;
    const account = readAccountFromConfig(config);
    const baseUrl = account?.baseUrl?.replace(/\/+$/, "") ?? "";
    const outboundToken = account?.outboundToken ?? "";
    appendMirrorLog("config_loaded", {
        configSource: event.context?.cfg ? "event.context.cfg" : api.runtime?.config?.loadConfig ? "api.runtime.config" : "api.config",
        hasBaseUrl: Boolean(baseUrl),
        hasOutboundToken: Boolean(outboundToken),
        ctxChannelId: ctx.channelId ?? null,
        ctxSessionKey: ctx.sessionKey ?? null,
    });
    if (!baseUrl || !outboundToken) {
        return null;
    }
    return { baseUrl, outboundToken };
}

async function postMirrorPayload(
    api: OpenClawPluginApi,
    logger: Logger,
    state: MirrorRuntimeState,
    event: HookEvent,
    ctx: HookContext,
    payload: MirrorPayload | null,
): Promise<void> {
    if (!payload) {
        return;
    }
    if (state.sentMirrorMessageIds.has(payload.messageId)) {
        appendMirrorLog("mirror_payload_deduped", {
            messageId: payload.messageId,
            sessionKey: payload.sessionKey,
        });
        return;
    }
    const config = readMirrorConfig(api, event, ctx);
    if (!config) {
        logger.warn({}, "Missing claw-team account config for webchat mirror");
        return;
    }

    const previousQueue = state.sessionQueues.get(payload.sessionKey) ?? Promise.resolve();
    const nextQueue = previousQueue
        .catch(() => undefined)
        .then(async () => {
            const response = await fetch(`${config.baseUrl}${WEBCHAT_MIRROR_PATH}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${config.outboundToken}`,
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                appendMirrorLog("mirror_payload_failed", {
                    messageId: payload.messageId,
                    sessionKey: payload.sessionKey,
                    status: response.status,
                    detail,
                });
                logger.warn(
                    {
                        status: response.status,
                        detail,
                        sessionKey: payload.sessionKey,
                        messageId: payload.messageId,
                    },
                    "Webchat mirror request failed",
                );
                return;
            }

            state.sentMirrorMessageIds.add(payload.messageId);
            appendMirrorLog("mirror_payload_sent", {
                messageId: payload.messageId,
                sessionKey: payload.sessionKey,
                senderType: payload.senderType,
            });
        });
    state.sessionQueues.set(payload.sessionKey, nextQueue);
    await nextQueue;
}

async function handleMessageReceived(event: HookEvent, ctx: HookContext, state: MirrorRuntimeState): Promise<void> {
    if (!isWebchatContext(event, ctx)) {
        return;
    }
    trackInboundWebchatTurn(state, event);
    appendMirrorLog("message_received_tracked", {
        messageId: getEventMessageId(event) || null,
        contentLength: getEventContent(event).length,
        pendingCount: state.pendingInboundTurns.length,
    });
}

async function handleBeforeDispatch(
    api: OpenClawPluginApi,
    logger: Logger,
    event: HookEvent,
    ctx: HookContext,
    state: MirrorRuntimeState,
): Promise<void> {
    if (!isWebchatContext(event, ctx)) {
        return;
    }
    const sessionKey = normalizeSessionKey(event.sessionKey ?? ctx.sessionKey);
    const content = getEventContent(event);
    if (!sessionKey || !content) {
        return;
    }
    markWebchatSessionActive(state, sessionKey);
    const pendingTurn = consumePendingInboundTurn(state, content);
    if (!pendingTurn) {
        appendMirrorLog("before_dispatch_pending_turn_missing", {
            sessionKey,
            contentLength: content.length,
        });
        return;
    }
    await postMirrorPayload(api, logger, state, event, ctx, {
        channelId: WEBCHAT_CHANNEL_ID,
        sessionKey,
        messageId: pendingTurn.messageId,
        senderType: USER_SENDER_TYPE,
        content,
        timestamp: Date.now(),
    });
}

async function handleBeforeToolCall(
    api: OpenClawPluginApi,
    logger: Logger,
    event: HookEvent,
    ctx: HookContext,
    state: MirrorRuntimeState,
): Promise<void> {
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    if (
        !sessionKey ||
        (!isWebchatContext(event, ctx) &&
            !isTrackedWebchatSession(state, sessionKey) &&
            !isLocalOriginSession(sessionKey))
    ) {
        return;
    }
    if (!shouldIncludeIntermediateMessages(api, event, ctx)) {
        return;
    }
    markWebchatSessionActive(state, sessionKey);
    await postMirrorPayload(api, logger, state, event, ctx, buildBeforeToolCallPayload(event, ctx));
}

async function handleToolResultPersist(
    api: OpenClawPluginApi,
    logger: Logger,
    event: HookEvent,
    ctx: HookContext,
    state: MirrorRuntimeState,
): Promise<void> {
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    if (!sessionKey || (!isTrackedWebchatSession(state, sessionKey) && !isLocalOriginSession(sessionKey))) {
        return;
    }
    if (!shouldIncludeIntermediateMessages(api, event, ctx)) {
        return;
    }
    await postMirrorPayload(api, logger, state, event, ctx, buildToolResultPayload(event, ctx));
}

async function handleBeforeMessageWrite(
    api: OpenClawPluginApi,
    logger: Logger,
    event: HookEvent,
    ctx: HookContext,
    state: MirrorRuntimeState,
): Promise<void> {
    const sessionKey = normalizeSessionKey(event.sessionKey ?? ctx.sessionKey);
    if (!sessionKey || (!isTrackedWebchatSession(state, sessionKey) && !isLocalOriginSession(sessionKey))) {
        return;
    }
    if (!shouldIncludeIntermediateMessages(api, event, ctx)) {
        return;
    }
    await postMirrorPayload(api, logger, state, event, ctx, buildBeforeMessageWritePayload(event, ctx));
}

async function handleLlmOutput(
    api: OpenClawPluginApi,
    logger: Logger,
    event: HookEvent,
    ctx: HookContext,
    state: MirrorRuntimeState,
): Promise<void> {
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    if (!sessionKey || (!isWebchatContext(event, ctx) && !isTrackedWebchatSession(state, sessionKey))) {
        return;
    }
    if (isLocalOriginSession(sessionKey)) {
        appendMirrorLog("llm_output_suppressed_local_origin", { sessionKey });
        clearLocalOriginSession(sessionKey);
        return;
    }
    markWebchatSessionActive(state, sessionKey);
    for (const payload of buildLlmOutputPayloads(event, ctx)) {
        await postMirrorPayload(api, logger, state, event, ctx, payload);
    }
}

export function registerWebchatTranscriptMirror(api: OpenClawPluginApi, logger: Logger): void {
    if (typeof api.on !== "function") {
        appendMirrorLog("register_hook_unavailable");
        logger.warn({}, "Plugin-managed webchat transcript mirror is unavailable because api.on is missing");
        return;
    }

    const state = createMirrorRuntimeState();

    for (const eventName of MIRROR_HOOK_EVENTS) {
        api.on(eventName, async (event: HookEvent, ctx: HookContext | undefined) => {
            const safeCtx = ctx ?? {};

            switch (eventName) {
                case "message_received":
                    await handleMessageReceived(event, safeCtx, state);
                    return;
                case "before_dispatch":
                    await handleBeforeDispatch(api, logger, event, safeCtx, state);
                    return;
                case "before_tool_call":
                    await handleBeforeToolCall(api, logger, event, safeCtx, state);
                    return;
                case "tool_result_persist":
                    await handleToolResultPersist(api, logger, event, safeCtx, state);
                    return;
                case "before_message_write":
                    await handleBeforeMessageWrite(api, logger, event, safeCtx, state);
                    return;
                case "llm_output":
                    await handleLlmOutput(api, logger, event, safeCtx, state);
                    return;
                default:
                    return;
            }
        });
    }
}
