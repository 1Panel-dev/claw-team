"""
这个文件负责双 Agent 对话的控制面 API。

第一阶段先提供最小能力：
1. 用户发起一条新的双 Agent 对话。
2. 查询当前对话状态。
3. 暂停 / 恢复 / 停止。
4. 用户可中途插入指导消息。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.models.agent_dialogue import AgentDialogue
from src.models.agent_profile import AgentProfile
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.agent_dialogue import AgentDialogueCreate, AgentDialogueMessageCreate, AgentDialogueRead
from src.services.agent_dialogue_lookup import find_reusable_agent_dialogue
from src.services.agent_dialogue_runner import (
    dispatch_agent_dialogue_intervention,
    dispatch_agent_dialogue_opening_turn,
    next_agent_id_for_dialogue,
    resume_agent_dialogue_if_possible,
)
from src.services.agent_cs_id import ensure_agent_cs_id
from src.services.default_user import get_default_user_identity

router = APIRouter(prefix="/api/agent-dialogues", tags=["agent-dialogues"])
DEFAULT_USER = get_default_user_identity()


def serialize_agent_dialogue(db: Session, dialogue: AgentDialogue) -> AgentDialogueRead:
    source_agent = db.get(AgentProfile, dialogue.source_agent_id)
    target_agent = db.get(AgentProfile, dialogue.target_agent_id)
    if not source_agent or not target_agent:
        raise HTTPException(status_code=404, detail="source or target agent not found")
    source_instance = db.get(OpenClawInstance, source_agent.instance_id)
    target_instance = db.get(OpenClawInstance, target_agent.instance_id)

    ensure_agent_cs_id(source_agent)
    ensure_agent_cs_id(target_agent)

    last_speaker = db.get(AgentProfile, dialogue.last_speaker_agent_id) if dialogue.last_speaker_agent_id else None
    if last_speaker:
        ensure_agent_cs_id(last_speaker)
    next_agent_id = next_agent_id_for_dialogue(dialogue)
    next_agent = db.get(AgentProfile, next_agent_id) if next_agent_id else None
    if next_agent:
        ensure_agent_cs_id(next_agent)

    return AgentDialogueRead(
        id=dialogue.id,
        conversation_id=dialogue.conversation_id,
        source_agent_id=dialogue.source_agent_id,
        source_agent_cs_id=source_agent.cs_id or "",
        source_agent_display_name=source_agent.display_name,
        source_agent_instance_name=(source_instance.name if source_instance else None),
        target_agent_id=dialogue.target_agent_id,
        target_agent_cs_id=target_agent.cs_id or "",
        target_agent_display_name=target_agent.display_name,
        target_agent_instance_name=(target_instance.name if target_instance else None),
        topic=dialogue.topic,
        status=dialogue.status,
        initiator_type=dialogue.initiator_type,
        initiator_agent_id=dialogue.initiator_agent_id,
        window_seconds=dialogue.window_seconds,
        soft_message_limit=dialogue.soft_message_limit,
        hard_message_limit=dialogue.hard_message_limit,
        soft_limit_warned_at=dialogue.soft_limit_warned_at,
        last_speaker_agent_id=dialogue.last_speaker_agent_id,
        last_speaker_agent_cs_id=(last_speaker.cs_id if last_speaker else None),
        last_speaker_agent_display_name=(last_speaker.display_name if last_speaker else None),
        next_agent_id=(next_agent.id if next_agent else None),
        next_agent_cs_id=(next_agent.cs_id if next_agent else None),
        next_agent_display_name=(next_agent.display_name if next_agent else None),
        created_at=dialogue.created_at,
        updated_at=dialogue.updated_at,
    )


@router.post("", response_model=AgentDialogueRead)
async def create_agent_dialogue(payload: AgentDialogueCreate, db: Session = Depends(db_session)) -> AgentDialogue:
    source_agent = db.get(AgentProfile, payload.source_agent_id)
    target_agent = db.get(AgentProfile, payload.target_agent_id)
    if not source_agent or not target_agent:
        raise HTTPException(status_code=404, detail="source or target agent not found")
    if source_agent.id == target_agent.id:
        raise HTTPException(status_code=400, detail="source and target agent must be different")

    dialogue = find_reusable_agent_dialogue(
        db=db,
        first_agent_id=source_agent.id,
        second_agent_id=target_agent.id,
    )
    if dialogue is None:
        conversation = Conversation(
            type="agent_dialogue",
            title=f"{source_agent.display_name} ↔ {target_agent.display_name}",
        )
        db.add(conversation)
        db.flush()

        dialogue = AgentDialogue(
            conversation_id=conversation.id,
            source_agent_id=source_agent.id,
            target_agent_id=target_agent.id,
            topic=payload.topic.strip(),
            status="active",
            initiator_type="user",
            window_seconds=payload.window_seconds,
            soft_message_limit=payload.soft_message_limit,
            hard_message_limit=payload.hard_message_limit,
            soft_limit_warned_at=None,
            last_speaker_agent_id=None,
        )
        db.add(dialogue)
    else:
        conversation = db.get(Conversation, dialogue.conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="conversation not found for reusable agent dialogue")
        # 同一对参与者复用一条对话，但本轮的“谁先发起、找谁协作”仍然要刷新。
        dialogue.source_agent_id = source_agent.id
        dialogue.target_agent_id = target_agent.id
        dialogue.topic = payload.topic.strip()
        dialogue.status = "active"
        dialogue.initiator_type = "user"
        dialogue.initiator_agent_id = None
        dialogue.window_seconds = payload.window_seconds
        dialogue.soft_message_limit = payload.soft_message_limit
        dialogue.hard_message_limit = payload.hard_message_limit
        dialogue.soft_limit_warned_at = None
        dialogue.last_speaker_agent_id = None
        conversation.title = f"{source_agent.display_name} ↔ {target_agent.display_name}"

    opening_message = Message(
        id=f"msg_{uuid.uuid4().hex[:24]}",
        conversation_id=conversation.id,
        sender_type="user",
        sender_label=DEFAULT_USER.sender_label,
        sender_cs_id=DEFAULT_USER.cs_id,
        content=payload.topic.strip(),
        status="completed",
    )
    db.add(opening_message)
    db.flush()

    await dispatch_agent_dialogue_opening_turn(
        db=db,
        dialogue=dialogue,
        opening_message=opening_message,
    )

    db.commit()
    db.refresh(dialogue)
    return serialize_agent_dialogue(db, dialogue)


@router.get("/{dialogue_id}", response_model=AgentDialogueRead)
def get_agent_dialogue(dialogue_id: int, db: Session = Depends(db_session)) -> AgentDialogue:
    dialogue = db.get(AgentDialogue, dialogue_id)
    if not dialogue:
        raise HTTPException(status_code=404, detail="agent dialogue not found")
    return serialize_agent_dialogue(db, dialogue)


@router.post("/{dialogue_id}/pause", response_model=AgentDialogueRead)
def pause_agent_dialogue(dialogue_id: int, db: Session = Depends(db_session)) -> AgentDialogue:
    return serialize_agent_dialogue(db, _set_agent_dialogue_status(db=db, dialogue_id=dialogue_id, status="paused"))


@router.post("/{dialogue_id}/resume", response_model=AgentDialogueRead)
async def resume_agent_dialogue(dialogue_id: int, db: Session = Depends(db_session)) -> AgentDialogue:
    dialogue = _set_agent_dialogue_status(db=db, dialogue_id=dialogue_id, status="active")
    await resume_agent_dialogue_if_possible(db=db, dialogue=dialogue)
    db.refresh(dialogue)
    return serialize_agent_dialogue(db, dialogue)


@router.post("/{dialogue_id}/stop", response_model=AgentDialogueRead)
def stop_agent_dialogue(dialogue_id: int, db: Session = Depends(db_session)) -> AgentDialogue:
    return serialize_agent_dialogue(db, _set_agent_dialogue_status(db=db, dialogue_id=dialogue_id, status="stopped"))


@router.post("/{dialogue_id}/messages")
async def add_agent_dialogue_message(
    dialogue_id: int,
    payload: AgentDialogueMessageCreate,
    db: Session = Depends(db_session),
) -> dict[str, str]:
    dialogue = db.get(AgentDialogue, dialogue_id)
    if not dialogue:
        raise HTTPException(status_code=404, detail="agent dialogue not found")

    message = Message(
        id=f"msg_{uuid.uuid4().hex[:24]}",
        conversation_id=dialogue.conversation_id,
        sender_type="user",
        sender_label=DEFAULT_USER.sender_label,
        sender_cs_id=DEFAULT_USER.cs_id,
        content=payload.content.strip(),
        status="completed",
    )
    db.add(message)
    db.flush()

    # 已停止或已完成的对话允许通过新的人工指令重新激活，
    # 这样人类可以在必要时继续推进，而不是被迫新建一条会话。
    if dialogue.status in {"completed", "stopped"}:
        dialogue.status = "active"

    await dispatch_agent_dialogue_intervention(db=db, dialogue=dialogue, message=message)
    db.commit()
    return {"message": "agent dialogue message added"}


def _set_agent_dialogue_status(*, db: Session, dialogue_id: int, status: str) -> AgentDialogue:
    dialogue = db.get(AgentDialogue, dialogue_id)
    if not dialogue:
        raise HTTPException(status_code=404, detail="agent dialogue not found")
    dialogue.status = status
    db.commit()
    db.refresh(dialogue)
    return dialogue
