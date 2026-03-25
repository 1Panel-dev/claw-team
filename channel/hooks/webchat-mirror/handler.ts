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

type CompletedAssistantMessage = {
  messageId: string;
  content: string;
  parentId: string;
};

type CompletedUserMessage = {
  messageId: string;
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
  return { messageId: record.id.trim() };
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

async function findAssistantReplyForUserMessage(
  sessionFile: string,
  userMessageId: string,
): Promise<CompletedAssistantMessage | null> {
  try {
    const raw = await fsPromises.readFile(sessionFile, "utf-8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as TranscriptRecord;
        const message = extractAssistantText(parsed);
        if (message && message.parentId === userMessageId) {
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

  // Web UI 回复经常要经过较长的思考/工具调用，这里给足等待时间，
  // 避免用户消息已经镜像成功，但 assistant 回复因为超时而漏掉。
  for (let i = 0; i < 45; i += 1) {
    await sleep(1000);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      transcriptPath = (await resolveTranscriptPath(sessionKey)) ?? "";
      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        continue;
      }
    }
    // hook 事件里的 messageId 和 transcript 里的真实 user message id 不一定相同。
    // 这里先拿到 transcript 里的 user id，再按 parentId 去找对应 assistant 回复。
    if (!transcriptUserMessageId) {
      const latestUser = await readLatestUserMessageFromTranscript(transcriptPath);
      transcriptUserMessageId = latestUser?.messageId ?? "";
    }
    const latest =
      ((transcriptUserMessageId || userMessageId) &&
        (await findAssistantReplyForUserMessage(transcriptPath, transcriptUserMessageId || userMessageId))) ||
      (await readLatestCompletedAssistantMessage(transcriptPath));
    if (!latest) {
      continue;
    }
    if (
      latest.parentId &&
      transcriptUserMessageId &&
      latest.parentId !== transcriptUserMessageId
    ) {
      continue;
    }

    const response = await fetch(`${params.baseUrl}${WEBCHAT_MIRROR_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.outboundToken}`,
      },
      body: JSON.stringify({
        channelId: WEBCHAT_CHANNEL_ID,
        sessionKey,
        messageId: latest.messageId,
        senderType: ASSISTANT_SENDER_TYPE,
        content: latest.content,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn("[webchat-mirror] assistant transcript mirror failed", response.status, detail);
      return;
    }

    return;
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
