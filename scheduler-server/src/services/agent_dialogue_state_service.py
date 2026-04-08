from __future__ import annotations

from datetime import datetime, timedelta
import uuid

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from src.models.agent_dialogue import AgentDialogue
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_dispatch import MessageDispatch

IN_FLIGHT_DISPATCH_STATUSES = ("pending", "accepted", "streaming")
AGENT_DIALOGUE_WARNING_TEXT = "短时间内对话次数较多，请聚焦当前目标，避免无效往返。"

"""Agent dialogue 工作流的状态与守卫辅助函数。"""


def pick_next_agent_id(dialogue: AgentDialogue, current_speaker_agent_id: int) -> int | None:
    """Return the opposite participant for the current speaker."""
    if current_speaker_agent_id == dialogue.source_agent_id:
        return dialogue.target_agent_id
    if current_speaker_agent_id == dialogue.target_agent_id:
        return dialogue.source_agent_id
    return None


def next_agent_id_for_dialogue(dialogue: AgentDialogue) -> int | None:
    """Pick the next speaker when only dialogue state is known."""
    if dialogue.last_speaker_agent_id is None:
        return dialogue.source_agent_id
    return pick_next_agent_id(dialogue, dialogue.last_speaker_agent_id)


def count_recent_dialogue_messages(*, db: Session, dialogue: AgentDialogue) -> int:
    """Count recent human and agent messages inside the dialogue window."""
    window_start = datetime.utcnow() - timedelta(seconds=dialogue.window_seconds)
    stmt = (
        select(Message.id)
        .where(Message.conversation_id == dialogue.conversation_id)
        .where(Message.created_at >= window_start)
        .where(Message.sender_type.in_(("user", "agent")))
    )
    return len(list(db.scalars(stmt)))


def maybe_add_soft_limit_warning(*, db: Session, dialogue: AgentDialogue, conversation: Conversation) -> None:
    """Append one warning message per window once the soft limit is crossed."""
    window_start = datetime.utcnow() - timedelta(seconds=dialogue.window_seconds)
    if dialogue.soft_limit_warned_at and dialogue.soft_limit_warned_at >= window_start:
        return

    warning_message = Message(
        id=f"msg_{uuid.uuid4().hex[:24]}",
        conversation_id=conversation.id,
        sender_type="system",
        sender_label="System",
        sender_cs_id=None,
        content=AGENT_DIALOGUE_WARNING_TEXT,
        status="completed",
    )
    db.add(warning_message)
    dialogue.soft_limit_warned_at = datetime.utcnow()
    db.flush()


def apply_dialogue_window_guards(*, db: Session, dialogue: AgentDialogue, conversation: Conversation) -> str:
    """Enforce the soft and hard message limits before dispatching another turn."""
    recent_message_count = count_recent_dialogue_messages(db=db, dialogue=dialogue)
    if recent_message_count >= dialogue.hard_message_limit:
        dialogue.status = "stopped"
        return "stopped"

    if recent_message_count >= dialogue.soft_message_limit:
        maybe_add_soft_limit_warning(db=db, dialogue=dialogue, conversation=conversation)

    return "continue"


def has_in_flight_dispatch(db: Session, dialogue: AgentDialogue) -> bool:
    """Check whether the dialogue already has a running outbound turn."""
    stmt = (
        select(MessageDispatch.id)
        .where(MessageDispatch.conversation_id == dialogue.conversation_id)
        .where(MessageDispatch.status.in_(IN_FLIGHT_DISPATCH_STATUSES))
        .limit(1)
    )
    return db.scalar(stmt) is not None


def find_latest_undispatched_message(
    *,
    db: Session,
    dialogue: AgentDialogue,
    sender_type: str | None = None,
) -> Message | None:
    """Find the newest completed message that has never been dispatched onward."""
    stmt = (
        select(Message)
        .where(Message.conversation_id == dialogue.conversation_id)
        .where(Message.status == "completed")
        .order_by(desc(Message.created_at))
    )
    if sender_type:
        stmt = stmt.where(Message.sender_type == sender_type)

    for message in db.scalars(stmt):
        existing_dispatch = db.scalar(
            select(MessageDispatch.id)
            .where(MessageDispatch.message_id == message.id)
            .limit(1)
        )
        if existing_dispatch is None:
            return message
    return None
