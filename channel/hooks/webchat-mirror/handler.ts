/**
 * 这是 Web UI transcript 镜像 hook。
 *
 * 作用：
 * 1. 监听 OpenClaw WebChat 的用户消息。
 * 2. 立即把用户输入镜像到 Claw Team。
 * 3. 再从 transcript 中跟踪这一轮后续产生的 assistant/tool 输出，并逐步镜像过去。
 *
 * 目录为什么在 hooks/ 下：
 * - OpenClaw 的内部 hook 发现机制要求目录中存在 HOOK.md + handler.ts。
 * - 这是给宿主直接加载的运行时入口，不是普通的插件源码模块。
 * - src/ 下放的是插件本体构建产物；hooks/ 下放的是宿主按约定发现的 hook 目录。
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const CHANNEL_ID = "claw-team";
const WEBCHAT_CHANNEL_ID = "webchat";
const AGENT_SESSION_PREFIX = "agent:";
const WEBCHAT_MIRROR_PATH = "/api/v1/claw-team/webchat-mirror";
const ASSISTANT_SENDER_TYPE = "assistant";
const USER_SENDER_TYPE = "user";
const ASSISTANT_MIRROR_POLL_INTERVAL_MS = 1000;
const ASSISTANT_MIRROR_MAX_WAIT_MS = 10 * 60 * 1000;

type HookEvent = {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: {
    channelId?: string;
    content?: string;
    messageId?: string;
    conversationId?: string;
  };
};

type ClawTeamAccountConfig = {
  baseUrl?: string;
  outboundToken?: string;
};

type SessionStoreEntry = {
  sessionFile?: string;
  sessionId?: string;
};

type TranscriptRecord = {
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    stopReason?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
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

const INTERNAL_DIALOGUE_USER_PREFIX = "[Claw Team Agent Dialogue]";

type MirrorableTranscriptMessage = {
  messageId: string;
  content: string;
  isTerminalAssistant: boolean;
};

function getSkipReason(event: HookEvent): string | null {
  if (event.type !== "message") {
    return "not_message_event";
  }
  if (event.action !== "received") {
    return "not_received_action";
  }
  if (event.context?.channelId !== WEBCHAT_CHANNEL_ID) {
    return `unsupported_channel:${event.context?.channelId ?? "unknown"}`;
  }
  if (typeof event.sessionKey !== "string" || !event.sessionKey.startsWith(AGENT_SESSION_PREFIX)) {
    return `invalid_session:${String(event.sessionKey ?? "")}`;
  }
  if (typeof event.context?.content !== "string" || event.context.content.trim().length === 0) {
    return "empty_content";
  }
  return null;
}

function resolveConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return explicit;
  }

  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

async function readClawTeamAccountConfig(): Promise<ClawTeamAccountConfig | null> {
  try {
    const raw = await fsPromises.readFile(resolveConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, any>;
    const account =
      parsed?.channels?.[CHANNEL_ID]?.accounts?.default &&
      typeof parsed.channels[CHANNEL_ID].accounts.default === "object"
        ? (parsed.channels[CHANNEL_ID].accounts.default as Record<string, unknown>)
        : null;

    if (!account) {
      return null;
    }

    return {
      baseUrl: typeof account.baseUrl === "string" ? account.baseUrl.trim() : undefined,
      outboundToken:
        typeof account.outboundToken === "string" ? account.outboundToken.trim() : undefined,
    };
  } catch (error) {
    console.warn("[webchat-mirror] failed to read OpenClaw config", error);
    return null;
  }
}

function buildFallbackMessageId(event: HookEvent): string {
  const base = [
    event.context?.conversationId ?? "",
    event.sessionKey ?? "",
    event.context?.content ?? "",
  ].join("|");
  return `fallback-${crypto.createHash("sha1").update(base).digest("hex")}`;
}

function parseAgentKeyFromSessionKey(sessionKey: string): string | null {
  const raw = sessionKey.trim();
  if (!raw.startsWith(AGENT_SESSION_PREFIX)) {
    return null;
  }
  const parts = raw.split(":");
  return parts[1]?.trim() || null;
}

function resolveStateDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(os.homedir(), ".openclaw");
}

// 运行时只知道 sessionKey，需要先回到 sessions.json 里反查 transcript 文件位置。
// 不同 agent 的 workspace/stateDir 不同，所以这里不能写死目录。
async function resolveTranscriptPath(sessionKey: string): Promise<string | null> {
  const agentKey = parseAgentKeyFromSessionKey(sessionKey);
  if (!agentKey) {
    return null;
  }
  const sessionsDir = path.join(resolveStateDir(), "agents", agentKey, "sessions");
  const sessionsStorePath = path.join(sessionsDir, "sessions.json");
  try {
    const raw = await fsPromises.readFile(sessionsStorePath, "utf-8");
    const store = JSON.parse(raw) as Record<string, SessionStoreEntry>;
    const normalizedKey = sessionKey.trim().toLowerCase();
    const entry = store[normalizedKey] ?? store[sessionKey.trim()] ?? null;
    if (!entry) {
      return null;
    }
    if (typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
      return entry.sessionFile.trim();
    }
    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      return path.join(sessionsDir, `${entry.sessionId.trim()}.jsonl`);
    }
  } catch {
    return null;
  }
  return null;
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
    const textChunks = extractTextChunks(contentParts);
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

async function readLatestCompletedAssistantMessage(sessionFile: string): Promise<CompletedAssistantMessage | null> {
  try {
    const raw = await fsPromises.readFile(sessionFile, "utf-8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as TranscriptRecord;
        const message = extractAssistantText(parsed);
        if (message) {
          return message;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
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

async function readLatestUserMessageFromTranscript(sessionFile: string): Promise<CompletedUserMessage | null> {
  try {
    const raw = await fsPromises.readFile(sessionFile, "utf-8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as TranscriptRecord;
        const message = extractUserMessageId(parsed);
        if (message) {
          return message;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
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

function isInternalDialogueUserMessage(content: string): boolean {
  return content.trim().startsWith(INTERNAL_DIALOGUE_USER_PREFIX);
}

function findTranscriptUserMessageIdByContent(
  transcript: string,
  expectedContent: string,
): string | null {
  const normalizedExpectedContent = expectedContent.trim();
  if (!normalizedExpectedContent) {
    return null;
  }
  const lines = transcript.split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as TranscriptRecord;
      const userMessage = extractUserMessageId(parsed);
      if (userMessage && userMessage.content === normalizedExpectedContent) {
        return userMessage.messageId;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function findAssistantReplyForUserMessage(
  sessionFile: string,
  userMessageId: string,
): Promise<CompletedAssistantMessage | null> {
  try {
    const raw = await fsPromises.readFile(sessionFile, "utf-8");
    return findAssistantReplyForTranscriptUser(raw, userMessageId);
  } catch {
    return null;
  }
  return null;
}

async function findMirrorableMessagesForUserMessage(
  sessionFile: string,
  userMessageId: string,
): Promise<MirrorableTranscriptMessage[]> {
  try {
    const raw = await fsPromises.readFile(sessionFile, "utf-8");
    return findMirrorableMessagesForTranscriptUser(raw, userMessageId);
  } catch {
    return [];
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function mirrorAssistantReplyFromTranscript(params: {
  event: HookEvent;
  baseUrl: string;
  outboundToken: string;
  mirroredUserMessageId: string;
}): Promise<void> {
  const sessionKey = typeof params.event.sessionKey === "string" ? params.event.sessionKey.trim() : "";
  if (!sessionKey) {
    return;
  }
  const userMessageId =
    (typeof params.event.context?.messageId === "string" && params.event.context.messageId.trim()) ||
    params.mirroredUserMessageId;
  let transcriptUserMessageId = "";
  let transcriptPath = "";
  const expectedUserContent =
    typeof params.event.context?.content === "string" ? params.event.context.content.trim() : "";
  const mirroredTranscriptMessageIds = new Set<string>();

  // Web UI 里的一轮回复可能会走很长的工具链，尤其是代码搜索、外部调用或 Agent 对话场景。
  // 这里不能只等几十秒，否则主会话最终已经有成文回复，镜像却提前超时放弃。
  const maxAttempts = Math.ceil(ASSISTANT_MIRROR_MAX_WAIT_MS / ASSISTANT_MIRROR_POLL_INTERVAL_MS);
  for (let i = 0; i < maxAttempts; i += 1) {
    await sleep(ASSISTANT_MIRROR_POLL_INTERVAL_MS);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      transcriptPath = (await resolveTranscriptPath(sessionKey)) ?? "";
      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        continue;
      }
    }
    // hook 事件里的 messageId 和 transcript 里的真实 user message id 不一定相同。
    // 这里必须先把“当前这条用户消息”对应的 transcript user id 固定下来，
    // 不能每轮都取最新 user，否则连续追问时，前一轮会被后一轮顶掉。
    if (!transcriptUserMessageId) {
      const transcript = await fsPromises.readFile(transcriptPath, "utf-8").catch(() => "");
      transcriptUserMessageId =
        findTranscriptUserMessageIdByContent(transcript, expectedUserContent) ||
        (await readLatestUserMessageFromTranscript(transcriptPath))?.messageId ||
        "";
    }
    const scopedMessages =
      (transcriptUserMessageId || userMessageId) &&
      (await findMirrorableMessagesForUserMessage(transcriptPath, transcriptUserMessageId || userMessageId));
    const pendingMessages = (scopedMessages || []).filter(
      (message) => !mirroredTranscriptMessageIds.has(message.messageId),
    );
    const latest = pendingMessages.at(-1) || null;
    if (!latest) {
      continue;
    }

    for (const message of pendingMessages) {
      const response = await fetch(`${params.baseUrl}${WEBCHAT_MIRROR_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.outboundToken}`,
        },
        body: JSON.stringify({
          channelId: WEBCHAT_CHANNEL_ID,
          sessionKey,
          messageId: message.messageId,
          senderType: ASSISTANT_SENDER_TYPE,
          content: message.content,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.warn("[webchat-mirror] assistant transcript mirror failed", response.status, detail);
        return;
      }

      mirroredTranscriptMessageIds.add(message.messageId);
    }

    if (pendingMessages.some((message) => message.isTerminalAssistant)) {
      return;
    }
  }

  console.warn("[webchat-mirror] assistant transcript mirror timed out", {
    sessionKey,
    transcriptPath: transcriptPath || null,
  });
}

const webchatMirrorHandler = async (event: HookEvent) => {
  const skipReason = getSkipReason(event);
  if (skipReason) {
    return;
  }

  const account = await readClawTeamAccountConfig();
  const baseUrl = account?.baseUrl?.replace(/\/+$/, "") ?? "";
  const outboundToken = account?.outboundToken ?? "";
  if (!baseUrl || !outboundToken) {
    console.warn("[webchat-mirror] missing claw-team account config", {
      hasBaseUrl: Boolean(baseUrl),
      hasOutboundToken: Boolean(outboundToken),
    });
    return;
  }

  const messageId =
    (typeof event.context?.messageId === "string" && event.context.messageId.trim()) ||
    buildFallbackMessageId(event);

  const response = await fetch(`${baseUrl}${WEBCHAT_MIRROR_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${outboundToken}`,
    },
    body: JSON.stringify({
      channelId: WEBCHAT_CHANNEL_ID,
      sessionKey: event.sessionKey,
      messageId,
      senderType: USER_SENDER_TYPE,
      content: event.context?.content?.trim(),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn("[webchat-mirror] mirror request failed", response.status, detail);
    return;
  }

  void mirrorAssistantReplyFromTranscript({
    event,
    baseUrl,
    outboundToken,
    mirroredUserMessageId: messageId,
  }).catch((error) => {
    console.warn(
      "[webchat-mirror] assistant transcript mirror errored",
      error instanceof Error ? error.message : String(error),
    );
  });
};

export default webchatMirrorHandler;
