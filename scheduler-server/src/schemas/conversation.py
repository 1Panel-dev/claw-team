"""
这里定义会话、消息和 dispatch 查询相关的 schema。

它是前端聊天页最核心的一组接口结构：
1. 创建 direct / group conversation。
2. 发消息。
3. 查询消息列表和 dispatch 状态。
4. 查询会话列表，用于左侧最近会话区域。
5. 支持前端轮询时做最小增量拉取。
"""
import re

from pydantic import BaseModel, Field

from src.schemas.common import TimestampedModel
from src.services.default_user import display_sender_label


class DirectConversationCreate(BaseModel):
    instance_id: int
    agent_id: int


class GroupConversationCreate(BaseModel):
    group_id: int


class ConversationRead(TimestampedModel):
    id: int
    type: str
    title: str | None
    group_id: int | None
    direct_instance_id: int | None
    direct_agent_id: int | None
    agent_dialogue_id: int | None = None


class ConversationListItem(TimestampedModel):
    # 这个结构专门给前端左侧会话列表使用。
    # 它比 ConversationRead 多了一层“展示友好字段”，避免前端自己再拼标题和最近消息摘要。
    id: int
    type: str
    title: str | None
    group_id: int | None
    direct_instance_id: int | None
    direct_agent_id: int | None
    display_title: str
    group_name: str | None
    instance_name: str | None
    agent_display_name: str | None
    dialogue_source_agent_name: str | None = None
    dialogue_target_agent_name: str | None = None
    dialogue_status: str | None = None
    dialogue_window_seconds: int | None = None
    dialogue_soft_message_limit: int | None = None
    dialogue_hard_message_limit: int | None = None
    last_message_id: str | None
    last_message_preview: str | None
    last_message_sender_type: str | None
    last_message_sender_label: str | None
    last_message_at: str | None
    last_message_status: str | None


class MessageCreate(BaseModel):
    # mentions 只在群聊里有意义；direct 场景下通常为空数组。
    content: str = Field(min_length=1)
    mentions: list[str] = Field(default_factory=list)
    use_dedicated_direct_session: bool = False


class MessagePartMarkdown(BaseModel):
    kind: str = "markdown"
    content: str


class MessagePartAttachment(BaseModel):
    kind: str = "attachment"
    name: str
    mime_type: str | None
    url: str


class MessagePartToolCard(BaseModel):
    kind: str = "tool_card"
    title: str
    status: str
    summary: str


MessagePartRead = MessagePartMarkdown | MessagePartAttachment | MessagePartToolCard


class MessageRead(TimestampedModel):
    id: str
    conversation_id: int
    sender_type: str
    sender_label: str
    sender_cs_id: str | None = None
    # 这里先用消息 id 前缀推导来源，避免为了展示来源再做一轮数据库迁移。
    # 当前只有 Web UI 镜像消息需要来源标记；普通消息保持 None 即可。
    source: str | None = None
    content: str
    status: str
    parts: list[MessagePartRead]


class DispatchRead(TimestampedModel):
    # dispatch 把“发给谁、现在执行到哪一步”暴露给前端和排障工具。
    id: str
    message_id: str
    conversation_id: int
    instance_id: int
    agent_id: int
    dispatch_mode: str
    channel_message_id: str | None
    channel_trace_id: str | None
    session_key: str | None
    status: str
    error_message: str | None


class ConversationMessagesResponse(BaseModel):
    conversation: ConversationRead
    messages: list[MessageRead]
    dispatches: list[DispatchRead]
    next_message_cursor: str | None
    next_dispatch_cursor: str | None
    has_more_messages: bool = False
    oldest_loaded_message_id: str | None = None


_PART_PATTERN = re.compile(r"\[\[(attachment|tool):([^|\]]+)\|([^|\]]*)\|([^\]]+)\]\]")


def build_message_parts(content: str) -> list[MessagePartRead]:
    """
    这里先做“兼容升级版”的消息拆分。

    当前数据库仍然只存 content 文本，
    所以后端接口在输出时补一个 parts 字段：
    1. 普通文本 -> markdown part
    2. 特殊 attachment 标记 -> attachment part

    这样前端已经可以切到 parts 模型，
    后面数据库和 callback 再升级时也不用重写消息接口。
    """
    parts: list[MessagePartRead] = []
    last_index = 0

    for match in _PART_PATTERN.finditer(content):
        text_before = content[last_index:match.start()].strip()
        if text_before:
            parts.append(MessagePartMarkdown(content=text_before))

        kind, first, second, third = match.groups()
        if kind == "attachment":
            parts.append(
                MessagePartAttachment(
                    name=first.strip(),
                    mime_type=second.strip() or None,
                    url=third.strip(),
                )
            )
        else:
            parts.append(
                MessagePartToolCard(
                    title=first.strip(),
                    status=_normalize_tool_status(second.strip()),
                    summary=third.strip(),
                )
            )
        last_index = match.end()

    rest = content[last_index:].strip()
    if rest or not parts:
        parts.append(MessagePartMarkdown(content=rest or content))

    return parts


def build_message_read(message, *, sender_cs_id: str | None = None) -> MessageRead:
    return MessageRead(
        id=message.id,
        conversation_id=message.conversation_id,
        sender_type=message.sender_type,
        sender_label=display_sender_label(
            sender_type=message.sender_type,
            sender_label=message.sender_label,
        ),
        sender_cs_id=sender_cs_id,
        source=_detect_message_source(message.id),
        content=message.content,
        status=message.status,
        created_at=message.created_at,
        updated_at=message.updated_at,
        parts=build_message_parts(message.content),
    )


def _normalize_tool_status(value: str) -> str:
    if value in {"pending", "running", "completed", "failed"}:
        return value
    return "pending"


def _detect_message_source(message_id: str) -> str | None:
    if message_id.startswith("msg_web_"):
        return "webchat"
    return None
