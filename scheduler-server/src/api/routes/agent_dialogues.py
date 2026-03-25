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
from src.schemas.agent_dialogue import AgentDialogueCreate, AgentDialogueMessageCreate, AgentDialogueRead
from src.services.agent_dialogue_runner import (
    dispatch_agent_dialogue_intervention,
    dispatch_agent_dialogue_opening_turn,
    next_agent_id_for_dialogue,
    resume_agent_dialogue_if_possible,
)
from src.services.agent_ct_id import ensure_agent_ct_id

router = APIRouter(prefix="/api/agent-dialogues", tags=["agent-dialogues"])


def serialize_agent_dialogue(db: Session, dialogue: AgentDialogue) -> AgentDialogueRead:
    source_agent = db.get(AgentProfile, dialogue.source_agent_id)
    target_agent = db.get(AgentProfile, dialogue.target_agent_id)
    if not source_agent or not target_agent:
        raise HTTPException(status_code=404, detail="source or target agent not found")

    ensure_agent_ct_id(source_agent)
    ensure_agent_ct_id(target_agent)

    last_speaker = db.get(AgentProfile, dialogue.last_speaker_agent_id) if dialogue.last_speaker_agent_id else None
    if last_speaker:
        ensure_agent_ct_id(last_speaker)
    next_agent_id = next_agent_id_for_dialogue(dialogue)
    next_agent = db.get(AgentProfile, next_agent_id) if next_agent_id else None
    if next_agent:
        ensure_agent_ct_id(next_agent)

    return AgentDialogueRead(
        id=dialogue.id,
        conversation_id=dialogue.conversation_id,
        source_agent_id=dialogue.source_agent_id,
        source_agent_ct_id=source_agent.ct_id or "",
        source_agent_display_name=source_agent.display_name,
        target_agent_id=dialogue.target_agent_id,
        target_agent_ct_id=target_agent.ct_id or "",
        target_agent_display_name=target_agent.display_name,
        topic=dialogue.topic,
        status=dialogue.status,
        initiator_type=dialogue.initiator_type,
        initiator_agent_id=dialogue.initiator_agent_id,
        window_seconds=dialogue.window_seconds,
        soft_message_limit=dialogue.soft_message_limit,
        hard_message_limit=dialogue.hard_message_limit,
        soft_limit_warned_at=dialogue.soft_limit_warned_at,
        last_speaker_agent_id=dialogue.last_speaker_agent_id,
        last_speaker_agent_ct_id=(last_speaker.ct_id if last_speaker else None),
        last_speaker_agent_display_name=(last_speaker.display_name if last_speaker else None),
        next_agent_id=(next_agent.id if next_agent else None),
        next_agent_ct_id=(next_agent.ct_id if next_agent else None),
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
    opening_message = Message(
        id=f"msg_{uuid.uuid4().hex[:24]}",
        conversation_id=conversation.id,
        sender_type="user",
        sender_label="User",
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
        sender_label="User",
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
