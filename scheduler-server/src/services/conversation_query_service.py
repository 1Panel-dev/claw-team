from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from src.models.agent_dialogue import AgentDialogue
from src.models.agent_profile import AgentProfile
from src.models.chat_group import ChatGroup
from src.models.chat_group_member import ChatGroupMember
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.common import validate_orm
from src.schemas.conversation import (
    DispatchRead,
    ConversationListItem,
    ConversationMessagesResponse,
    ConversationRead,
    build_message_read,
)
from src.services.agent_dialogue_lookup import build_agent_dialogue_pair_key
from src.services.default_user import display_sender_label

STALE_DISPATCH_TIMEOUT = timedelta(seconds=90)

"""会话列表、消息和发送者元数据的读侧辅助函数。"""


def list_conversation_items(db: Session) -> list[ConversationListItem]:
    """Build sidebar-friendly conversation summaries."""
    conversations = list(db.scalars(select(Conversation).order_by(Conversation.updated_at.desc(), Conversation.id.desc())))

    items: list[tuple[ConversationListItem, tuple[int, int] | None]] = []
    for conversation in conversations:
        last_message = db.scalar(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at.desc(), Message.id.desc())
        )
        dialogue = db.scalar(select(AgentDialogue).where(AgentDialogue.conversation_id == conversation.id))
        group = db.get(ChatGroup, conversation.group_id) if conversation.group_id else None
        instance = db.get(OpenClawInstance, conversation.direct_instance_id) if conversation.direct_instance_id else None
        agent = db.get(AgentProfile, conversation.direct_agent_id) if conversation.direct_agent_id else None
        source_agent = db.get(AgentProfile, dialogue.source_agent_id) if dialogue else None
        target_agent = db.get(AgentProfile, dialogue.target_agent_id) if dialogue else None

        if conversation.type == "direct" and instance and instance.status == "disabled":
            continue

        if conversation.type == "group":
            display_title = conversation.title or (group.name if group else f"群聊 {conversation.id}")
        elif conversation.type == "agent_dialogue":
            if source_agent and target_agent:
                source_instance = db.get(OpenClawInstance, source_agent.instance_id)
                target_instance = db.get(OpenClawInstance, target_agent.instance_id)
                source_label = f"{source_agent.display_name} / {source_instance.name}" if source_instance else source_agent.display_name
                target_label = f"{target_agent.display_name} / {target_instance.name}" if target_instance else target_agent.display_name
                display_title = f"{source_label} ↔ {target_label}"
            else:
                display_title = conversation.title or f"Agent 对话 {conversation.id}"
        else:
            if instance and agent:
                display_title = f"{instance.name} / {agent.display_name}"
            else:
                display_title = conversation.title or f"单聊 {conversation.id}"

        preview = None
        if last_message:
            preview = last_message.content.strip().replace("\n", " ")
            if len(preview) > 80:
                preview = f"{preview[:80]}..."

        pair_key = (
            build_agent_dialogue_pair_key(source_agent.id, target_agent.id)
            if conversation.type == "agent_dialogue" and source_agent and target_agent
            else None
        )

        items.append(
            (
                ConversationListItem(
                    id=conversation.id,
                    type=conversation.type,
                    title=conversation.title,
                    group_id=conversation.group_id,
                    direct_instance_id=conversation.direct_instance_id,
                    direct_agent_id=conversation.direct_agent_id,
                    created_at=conversation.created_at,
                    updated_at=conversation.updated_at,
                    display_title=display_title,
                    group_name=group.name if group else None,
                    instance_name=instance.name if instance else None,
                    agent_display_name=agent.display_name if agent else None,
                    dialogue_source_agent_name=source_agent.display_name if source_agent else None,
                    dialogue_target_agent_name=target_agent.display_name if target_agent else None,
                    dialogue_status=dialogue.status if dialogue else None,
                    dialogue_window_seconds=dialogue.window_seconds if dialogue else None,
                    dialogue_soft_message_limit=dialogue.soft_message_limit if dialogue else None,
                    dialogue_hard_message_limit=dialogue.hard_message_limit if dialogue else None,
                    last_message_id=last_message.id if last_message else None,
                    last_message_preview=preview,
                    last_message_sender_type=last_message.sender_type if last_message else None,
                    last_message_sender_label=(
                        display_sender_label(
                            sender_type=last_message.sender_type,
                            sender_label=last_message.sender_label,
                        )
                        if last_message else None
                    ),
                    last_message_at=last_message.created_at.isoformat() if last_message else None,
                    last_message_status=last_message.status if last_message else None,
                ),
                pair_key,
            )
        )

    items.sort(key=lambda item: item[0].last_message_at or item[0].created_at.isoformat(), reverse=True)

    deduped_items: list[ConversationListItem] = []
    seen_agent_dialogue_pairs: set[tuple[int, int]] = set()
    for item, pair_key in items:
        if pair_key is not None:
            if pair_key in seen_agent_dialogue_pairs:
                continue
            seen_agent_dialogue_pairs.add(pair_key)
        deduped_items.append(item)
    return deduped_items


def load_conversation_messages_response(
    *,
    db: Session,
    conversation: Conversation,
    message_after: str | None,
    dispatch_after: str | None,
    before_message_id: str | None,
    limit: int,
    include_dispatches: bool,
) -> ConversationMessagesResponse:
    """Load one conversation page plus dispatch metadata for the frontend."""
    dialogue = db.scalar(select(AgentDialogue).where(AgentDialogue.conversation_id == conversation.id))

    finalize_stale_dispatches(db=db, conversation_id=conversation.id)

    messages, has_more_messages = _load_conversation_messages(
        db=db,
        conversation_id=conversation.id,
        before_message_id=before_message_id,
        limit=limit,
    )
    dispatches = (
        list(
            db.scalars(
                select(MessageDispatch)
                .where(MessageDispatch.conversation_id == conversation.id)
                .order_by(MessageDispatch.created_at, MessageDispatch.id)
            )
        )
        if include_dispatches
        else []
    )
    sender_cs_id_map = build_sender_cs_id_map(db=db, conversation=conversation, dialogue=dialogue)
    return ConversationMessagesResponse(
        conversation=ConversationRead(
            id=conversation.id,
            type=conversation.type,
            title=conversation.title,
            group_id=conversation.group_id,
            direct_instance_id=conversation.direct_instance_id,
            direct_agent_id=conversation.direct_agent_id,
            agent_dialogue_id=dialogue.id if dialogue else None,
            created_at=conversation.created_at,
            updated_at=conversation.updated_at,
        ),
        messages=[
            build_message_read(
                item,
                sender_cs_id=item.sender_cs_id or sender_cs_id_map.get((item.sender_label or "").strip()),
            )
            for item in messages
        ],
        dispatches=[validate_orm(DispatchRead, item) for item in dispatches],
        next_message_cursor=messages[-1].id if messages else message_after,
        next_dispatch_cursor=dispatches[-1].id if dispatches else dispatch_after,
        has_more_messages=has_more_messages,
        oldest_loaded_message_id=messages[0].id if messages else before_message_id,
    )


def build_sender_cs_id_map(
    *,
    db: Session,
    conversation: Conversation,
    dialogue: AgentDialogue | None,
) -> dict[str, str]:
    """Best-effort fallback mapping for legacy messages without `sender_cs_id`."""
    mapping: dict[str, str] = {}

    if conversation.type == "agent_dialogue" and dialogue:
        source_agent = db.get(AgentProfile, dialogue.source_agent_id)
        target_agent = db.get(AgentProfile, dialogue.target_agent_id)
        if source_agent and source_agent.cs_id and source_agent.display_name.strip():
            mapping[source_agent.display_name.strip()] = source_agent.cs_id
        if target_agent and target_agent.cs_id and target_agent.display_name.strip():
            mapping[target_agent.display_name.strip()] = target_agent.cs_id
        return mapping

    if conversation.type == "group" and conversation.group_id:
        members = list(db.scalars(select(ChatGroupMember).where(ChatGroupMember.group_id == conversation.group_id)))
        for member in members:
            agent = db.get(AgentProfile, member.agent_id)
            if not agent or not agent.cs_id:
                continue
            label = (agent.display_name or "").strip()
            if label and label not in mapping:
                mapping[label] = agent.cs_id
        return mapping

    if conversation.type == "direct" and conversation.direct_agent_id:
        agent = db.get(AgentProfile, conversation.direct_agent_id)
        if agent and agent.cs_id and agent.display_name.strip():
            mapping[agent.display_name.strip()] = agent.cs_id

    return mapping


def finalize_stale_dispatches(db: Session, conversation_id: int) -> None:
    """Mark abandoned accepted/streaming dispatches as failed on read."""
    threshold = datetime.now(timezone.utc).replace(tzinfo=None) - STALE_DISPATCH_TIMEOUT
    stale_dispatches = list(
        db.scalars(
            select(MessageDispatch).where(
                MessageDispatch.conversation_id == conversation_id,
                MessageDispatch.status.in_(("accepted", "streaming")),
                MessageDispatch.updated_at < threshold,
            )
        )
    )
    if not stale_dispatches:
        return

    for dispatch in stale_dispatches:
        dispatch.status = "failed"
        if not dispatch.error_message:
            dispatch.error_message = "dispatch timed out while waiting for channel completion"

        user_message = db.get(Message, dispatch.message_id)
        if user_message and user_message.status in {"accepted", "streaming"}:
            user_message.status = "failed"

        agent_message = db.get(Message, f"msg_agent_{dispatch.id}")
        if agent_message and agent_message.status == "streaming":
            agent_message.status = "failed"

    db.commit()


def _load_conversation_messages(
    *,
    db: Session,
    conversation_id: int,
    before_message_id: str | None,
    limit: int,
) -> tuple[list[Message], bool]:
    """Load the newest page or an older page anchored by `before_message_id`."""
    if before_message_id:
        anchor = db.get(Message, before_message_id)
        if not anchor or anchor.conversation_id != conversation_id:
            raise HTTPException(status_code=404, detail="before message not found")
        query = (
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                or_(
                    Message.created_at < anchor.created_at,
                    and_(Message.created_at == anchor.created_at, Message.id < anchor.id),
                ),
            )
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(limit + 1)
        )
    else:
        query = (
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(limit + 1)
        )

    rows = list(db.scalars(query))
    has_more_messages = len(rows) > limit
    if has_more_messages:
        rows = rows[:limit]
    rows.reverse()
    return rows, has_more_messages
