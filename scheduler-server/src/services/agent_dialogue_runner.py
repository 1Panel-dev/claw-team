"""
这个文件负责双 Agent 对话的最小轮转状态机。

第一阶段先只做最关键的闭环：
1. 创建对话后，把 opening message 发给 source agent。
2. 某个 agent 回复完成后，把这条回复转发给另一方。
3. 达到时间窗硬阈值、人工暂停/停止、或找不到下一位 speaker 时终止。
"""
from __future__ import annotations

from datetime import datetime, timedelta
import uuid

from fastapi import HTTPException
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from src.integrations.channel_client import channel_client
from src.models.agent_dialogue import AgentDialogue
from src.models.agent_profile import AgentProfile
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.services.agent_cs_id import ensure_agent_cs_id
from src.services.default_user import get_default_user_identity

IN_FLIGHT_DISPATCH_STATUSES = ("pending", "accepted", "streaming")
AGENT_DIALOGUE_WARNING_TEXT = "短时间内对话次数较多，请聚焦当前目标，避免无效往返。"
AGENT_DIALOGUE_CHANNEL_PREFIX = "agent-dialogue"
AGENT_DIALOGUE_CONTEXT_HEADER = "[ClawSwarm Agent Dialogue]"
DEFAULT_USER = get_default_user_identity()


async def dispatch_agent_dialogue_opening_turn(*, db: Session, dialogue: AgentDialogue, opening_message: Message) -> str | None:
    """
    创建对话后的第一轮，固定先发给 source agent。
    """
    source_agent = db.get(AgentProfile, dialogue.source_agent_id)
    if not source_agent:
        raise HTTPException(status_code=404, detail="source agent not found")
    conversation = db.get(Conversation, dialogue.conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="conversation not found")

    return await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=opening_message,
        recipient_agent=source_agent,
        sender_label=DEFAULT_USER.label_with_cs_id,
        sender_user_id=DEFAULT_USER.internal_id,
        dispatch_mode="agent_dialogue_opening",
    )


async def continue_agent_dialogue_after_reply(
    *,
    db: Session,
    dialogue: AgentDialogue,
    dispatch: MessageDispatch,
    reply_message: Message,
) -> str | None:
    """
    某个 agent 完成一轮回复后，把这条回复继续转发给另一方。
    """
    if dialogue.status == "stopped":
        return None

    current_speaker = db.get(AgentProfile, dispatch.agent_id)
    if not current_speaker:
        dialogue.status = "stopped"
        db.commit()
        return None

    dialogue.last_speaker_agent_id = current_speaker.id

    # 暂停态下仍然要记住“谁刚说完、当前轮数到哪了”，这样恢复后才能接着跑。
    if dialogue.status != "active":
        db.commit()
        return None

    # 如果人类在这一轮执行期间插入了新指令，下一轮优先把人类消息转给另一位 Agent。
    pending_user_message = _find_latest_undispatched_message(db=db, dialogue=dialogue, sender_type="user")
    if pending_user_message:
        conversation = db.get(Conversation, dialogue.conversation_id)
        next_agent_id = _pick_next_agent_id(dialogue, current_speaker.id)
        next_agent = db.get(AgentProfile, next_agent_id) if next_agent_id else None
        if next_agent and conversation:
            return await dispatch_agent_dialogue_turn(
                db=db,
                dialogue=dialogue,
                conversation=conversation,
                message=pending_user_message,
                recipient_agent=next_agent,
                sender_label=DEFAULT_USER.label_with_cs_id,
                sender_user_id=DEFAULT_USER.internal_id,
                dispatch_mode="agent_dialogue_intervention",
            )

    next_agent_id = _pick_next_agent_id(dialogue, current_speaker.id)
    if next_agent_id is None:
        dialogue.status = "stopped"
        db.commit()
        return None

    next_agent = db.get(AgentProfile, next_agent_id)
    conversation = db.get(Conversation, dialogue.conversation_id)
    if not next_agent or not conversation:
        dialogue.status = "stopped"
        db.commit()
        return None

    return await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=reply_message,
        recipient_agent=next_agent,
        sender_label=current_speaker.display_name,
        sender_user_id=f"agent:{current_speaker.agent_key}",
        dispatch_mode="agent_dialogue_relay",
    )


async def dispatch_agent_dialogue_turn(
    *,
    db: Session,
    dialogue: AgentDialogue,
    conversation: Conversation,
    message: Message,
    recipient_agent: AgentProfile,
    sender_label: str,
    sender_user_id: str,
    dispatch_mode: str,
) -> str | None:
    """
    复用现有 inbound channel 路径，把某条已有消息作为下一轮输入发给指定 agent。

    注意：
    1. 这里复用的是“已有消息”，不重复造一份相同内容的消息记录。
    2. dispatch 仍然单独记录一次执行生命周期，所以前端可以继续看到 accepted / streaming / completed。
    """
    guard_result = _apply_dialogue_window_guards(db=db, dialogue=dialogue, conversation=conversation)
    if guard_result == "stopped":
        db.commit()
        return None

    instance = db.get(OpenClawInstance, recipient_agent.instance_id)
    if not instance:
        dialogue.status = "stopped"
        db.commit()
        return None

    dispatch = MessageDispatch(
        id=f"dsp_{uuid.uuid4().hex[:24]}",
        message_id=message.id,
        conversation_id=conversation.id,
        instance_id=instance.id,
        agent_id=recipient_agent.id,
        dispatch_mode=dispatch_mode,
        channel_message_id=message.id,
        status="pending",
    )
    db.add(dispatch)
    db.flush()

    packaged_text = _build_agent_dialogue_context_text(
        db=db,
        dialogue=dialogue,
        recipient_agent=recipient_agent,
        message=message,
        sender_label=sender_label,
    )

    response = await channel_client.send_inbound(
        instance=instance,
        payload={
            "messageId": message.id,
            "accountId": instance.channel_account_id,
            "chat": {"type": "direct", "chatId": f"{AGENT_DIALOGUE_CHANNEL_PREFIX}-{conversation.id}"},
            "from": {"userId": sender_user_id, "displayName": sender_label},
            "text": packaged_text,
            "directAgentId": recipient_agent.agent_key,
        },
    )

    dispatch.status = "accepted"
    dispatch.channel_trace_id = response.get("traceId")
    db.commit()
    return dispatch.id


def _pick_next_agent_id(dialogue: AgentDialogue, current_speaker_agent_id: int) -> int | None:
    if current_speaker_agent_id == dialogue.source_agent_id:
        return dialogue.target_agent_id
    if current_speaker_agent_id == dialogue.target_agent_id:
        return dialogue.source_agent_id
    return None


def next_agent_id_for_dialogue(dialogue: AgentDialogue) -> int | None:
    """
    给“人工插话 / 恢复会话”这种没有当前 speaker 的场景选下一位 Agent。

    规则：
    1. 如果还没人说过话，默认先找 source agent。
    2. 如果上一轮最后说话的是 source，就轮到 target。
    3. 反之同理。
    """
    if dialogue.last_speaker_agent_id is None:
        return dialogue.source_agent_id
    return _pick_next_agent_id(dialogue, dialogue.last_speaker_agent_id)


def _build_agent_dialogue_context_text(
    *,
    db: Session,
    dialogue: AgentDialogue,
    recipient_agent: AgentProfile,
    message: Message,
    sender_label: str,
) -> str:
    """
    给转发到下一位 Agent 的内容补一层上下文包装。

    这里的目标不是做复杂协议，而是解决两个实际问题：
    1. Agent 必须知道自己当前是在和谁对话，而不是把收到的内容误判成新的普通用户请求。
    2. Agent 必须知道这条消息属于哪条持续中的 ClawSwarm 对话，避免“继续接龙”这类指令丢上下文。
    """
    source_agent = db.get(AgentProfile, dialogue.source_agent_id)
    target_agent = db.get(AgentProfile, dialogue.target_agent_id)
    if not source_agent or not target_agent:
        return message.content

    ensure_agent_cs_id(source_agent)
    ensure_agent_cs_id(target_agent)
    ensure_agent_cs_id(recipient_agent)

    partner_agent = target_agent if recipient_agent.id == source_agent.id else source_agent
    recent_message_count = _count_recent_dialogue_messages(db=db, dialogue=dialogue)
    if message.sender_type == "user":
        message_intro = f"Human guidance from {DEFAULT_USER.label_with_cs_id}:"
    else:
        message_intro = f"Partner message from {sender_label}:"

    return "\n".join(
        [
            AGENT_DIALOGUE_CONTEXT_HEADER,
            "",
            f"Dialogue ID: AD-{dialogue.id:04d}",
            f"Topic: {dialogue.topic}",
            f"Your identity: {recipient_agent.display_name} ({recipient_agent.cs_id})",
            f"Current partner: {partner_agent.display_name} ({partner_agent.cs_id})",
            f"Window guard: {dialogue.window_seconds}s, soft {dialogue.soft_message_limit}, hard {dialogue.hard_message_limit}",
            f"Recent message count in window: {recent_message_count}",
            (
                f"Last speaker: {sender_label}"
                if sender_label
                else "Last speaker: Unknown"
            ),
            "Instruction: Continue the ongoing ClawSwarm agent dialogue with your current partner. Reply to the partner directly and stay focused on the topic.",
            "",
            message_intro,
            message.content,
        ]
    )


def _count_recent_dialogue_messages(*, db: Session, dialogue: AgentDialogue) -> int:
    """
    统计当前时间窗内的人类/Agent 消息数。

    这里故意排除 system 消息，避免“软阈值提醒”本身把计数越推越高。
    """
    window_start = datetime.utcnow() - timedelta(seconds=dialogue.window_seconds)
    stmt = (
        select(Message.id)
        .where(Message.conversation_id == dialogue.conversation_id)
        .where(Message.created_at >= window_start)
        .where(Message.sender_type.in_(("user", "agent")))
    )
    return len(list(db.scalars(stmt)))


def _maybe_add_soft_limit_warning(*, db: Session, dialogue: AgentDialogue, conversation: Conversation) -> None:
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


def _apply_dialogue_window_guards(*, db: Session, dialogue: AgentDialogue, conversation: Conversation) -> str:
    """
    在真正转发到下一位 Agent 前，按时间窗检查消息密度。

    返回值：
    - "continue": 正常继续
    - "stopped": 已触发硬阈值并停止
    """
    recent_message_count = _count_recent_dialogue_messages(db=db, dialogue=dialogue)
    if recent_message_count >= dialogue.hard_message_limit:
        dialogue.status = "stopped"
        return "stopped"

    if recent_message_count >= dialogue.soft_message_limit:
        _maybe_add_soft_limit_warning(db=db, dialogue=dialogue, conversation=conversation)

    return "continue"


def has_in_flight_dispatch(db: Session, dialogue: AgentDialogue) -> bool:
    stmt = (
        select(MessageDispatch.id)
        .where(MessageDispatch.conversation_id == dialogue.conversation_id)
        .where(MessageDispatch.status.in_(IN_FLIGHT_DISPATCH_STATUSES))
        .limit(1)
    )
    return db.scalar(stmt) is not None


def _find_latest_undispatched_message(
    *,
    db: Session,
    dialogue: AgentDialogue,
    sender_type: str | None = None,
) -> Message | None:
    """
    找到当前会话里最新一条“已经落库，但还没被发给下一位 Agent”的消息。

    这主要服务两个场景：
    1. 人工在运行中插话，等当前轮完成后优先转发这条指令。
    2. 对话暂停时刚好有一条回复已经落库，恢复后需要接着转发。
    """
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


async def dispatch_agent_dialogue_intervention(
    *,
    db: Session,
    dialogue: AgentDialogue,
    message: Message,
) -> str | None:
    """
    把人类插入的一条指导消息继续发给下一位 Agent。

    如果当前还有消息在执行，就先只落库，不并发发第二条，避免两边状态打架。
    """
    if dialogue.status != "active" or has_in_flight_dispatch(db, dialogue):
        return None

    next_agent_id = next_agent_id_for_dialogue(dialogue)
    if next_agent_id is None:
        return None

    recipient_agent = db.get(AgentProfile, next_agent_id)
    conversation = db.get(Conversation, dialogue.conversation_id)
    if not recipient_agent or not conversation:
        return None

    return await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=message,
        recipient_agent=recipient_agent,
        sender_label=DEFAULT_USER.label_with_cs_id,
        sender_user_id=DEFAULT_USER.internal_id,
        dispatch_mode="agent_dialogue_intervention",
    )


async def resume_agent_dialogue_if_possible(*, db: Session, dialogue: AgentDialogue) -> str | None:
    """
    恢复对话时，如果存在待继续的消息，就把它补发给下一位 Agent。

    优先级：
    1. 最新的人工插话
    2. 最新的未继续转发的 agent 回复
    """
    if dialogue.status != "active" or has_in_flight_dispatch(db, dialogue):
        return None

    pending_user_message = _find_latest_undispatched_message(db=db, dialogue=dialogue, sender_type="user")
    if pending_user_message:
        return await dispatch_agent_dialogue_intervention(db=db, dialogue=dialogue, message=pending_user_message)

    pending_agent_message = _find_latest_undispatched_message(db=db, dialogue=dialogue, sender_type="agent")
    if not pending_agent_message:
        return None

    next_agent_id = next_agent_id_for_dialogue(dialogue)
    sender_agent = db.get(AgentProfile, dialogue.last_speaker_agent_id) if dialogue.last_speaker_agent_id else None
    recipient_agent = db.get(AgentProfile, next_agent_id) if next_agent_id else None
    conversation = db.get(Conversation, dialogue.conversation_id)
    if not recipient_agent or not conversation or not sender_agent:
        return None

    return await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=pending_agent_message,
        recipient_agent=recipient_agent,
        sender_label=pending_agent_message.sender_label,
        sender_user_id=f"agent:{sender_agent.agent_key}",
        dispatch_mode="agent_dialogue_relay",
    )
