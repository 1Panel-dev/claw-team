/**
 * 这里定义消息展示层的内容模型。
 *
 * 当前后端还是返回单一 `content: string`，
 * 所以前端先统一映射成 markdown 文本片段。
 * 后面如果 ClawSwarm 调度中心把消息升级成多段结构：
 * - markdown
 * - plain text
 * - attachment
 * - tool card
 * 就可以沿着这份类型继续扩，而不用推翻消息渲染层。
 */
import type { MessageReadApi } from "@/types/api/conversation";

export type MessagePartView =
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

export interface MessageView {
    id: string;
    senderType: string;
    senderLabel: string;
    senderCsId: string | null;
    source: "webchat" | null;
    status: string;
    createdAt: string;
    updatedAt: string;
    parts: MessagePartView[];
}

export function toMessageView(message: MessageReadApi): MessageView {
    const parts = (message.parts?.length ? normalizeApiParts(message.parts) : parseMessageParts(message.content)).filter(isRenderablePart);

    return {
        id: message.id,
        senderType: message.sender_type,
        senderLabel: message.sender_label,
        senderCsId: message.sender_cs_id ?? null,
        source: message.source ?? null,
        status: message.status,
        createdAt: message.created_at,
        updatedAt: message.updated_at,
        parts,
    };
}

function isRenderablePart(part: MessagePartView): boolean {
    if (part.kind === "markdown") {
        return part.content.trim().length > 0;
    }
    if (part.kind === "attachment") {
        return Boolean(part.name.trim() || part.url.trim());
    }
    return Boolean(part.title.trim() || part.summary.trim());
}

function parseMessageParts(content: string): MessagePartView[] {
    const pattern = /\[\[(attachment|tool):([^|\]]+)\|([^|\]]*)\|([^\]]+)\]\]/g;
    const parts: MessagePartView[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
        const [fullMatch, kind, first, second, third] = match;
        const textBefore = content.slice(lastIndex, match.index).trim();
        if (textBefore) {
            parts.push({
                kind: "markdown",
                content: textBefore,
            });
        }
        if (kind === "attachment") {
            parts.push({
                kind: "attachment",
                name: first.trim(),
                mimeType: second.trim() || null,
                url: third.trim(),
            });
        } else {
            parts.push({
                kind: "tool_card",
                title: first.trim(),
                status: normalizeToolStatus(second),
                summary: third.trim(),
            });
        }
        lastIndex = match.index + fullMatch.length;
    }

    const rest = content.slice(lastIndex).trim();
    if (rest || !parts.length) {
        parts.push({
            kind: "markdown",
            content: rest || content,
        });
    }

    return parts;
}

function normalizeApiParts(parts: NonNullable<MessageReadApi["parts"]>): MessagePartView[] {
    return parts.map((part) => {
        if (part.kind === "attachment") {
            return {
                kind: "attachment",
                name: part.name,
                mimeType: part.mime_type,
                url: part.url,
            } satisfies MessagePartView;
        }
        if (part.kind === "tool_card") {
            return {
                kind: "tool_card",
                title: part.title,
                status: part.status,
                summary: part.summary,
            } satisfies MessagePartView;
        }
        return {
            kind: "markdown",
            content: part.content,
        } satisfies MessagePartView;
    });
}

function normalizeToolStatus(value: string): "pending" | "running" | "completed" | "failed" {
    if (value === "running") return "running";
    if (value === "completed") return "completed";
    if (value === "failed") return "failed";
    return "pending";
}
