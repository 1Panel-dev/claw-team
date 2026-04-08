"""Agent dialogue 生命周期控制路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.schemas.agent_dialogue import AgentDialogueCreate, AgentDialogueMessageCreate, AgentDialogueRead
from src.services.agent_dialogue_service import (
    add_agent_dialogue_message as add_agent_dialogue_message_service,
    create_agent_dialogue as create_agent_dialogue_service,
    get_agent_dialogue_or_404,
    resume_agent_dialogue as resume_agent_dialogue_service,
    serialize_agent_dialogue,
    set_agent_dialogue_status,
)

router = APIRouter(prefix="/api/agent-dialogues", tags=["agent-dialogues"])


@router.post("", response_model=AgentDialogueRead)
async def create_agent_dialogue(payload: AgentDialogueCreate, db: Session = Depends(db_session)) -> AgentDialogueRead:
    dialogue = await create_agent_dialogue_service(db=db, payload=payload)
    return serialize_agent_dialogue(db, dialogue)


@router.get("/{dialogue_id}", response_model=AgentDialogueRead)
def get_agent_dialogue(dialogue_id: int, db: Session = Depends(db_session)) -> AgentDialogueRead:
    return serialize_agent_dialogue(db, get_agent_dialogue_or_404(db=db, dialogue_id=dialogue_id))


@router.post("/{dialogue_id}/pause", response_model=AgentDialogueRead)
def pause_agent_dialogue(dialogue_id: int, db: Session = Depends(db_session)) -> AgentDialogueRead:
    return serialize_agent_dialogue(db, set_agent_dialogue_status(db=db, dialogue_id=dialogue_id, status="paused"))


@router.post("/{dialogue_id}/resume", response_model=AgentDialogueRead)
async def resume_agent_dialogue(dialogue_id: int, db: Session = Depends(db_session)) -> AgentDialogueRead:
    dialogue = await resume_agent_dialogue_service(db=db, dialogue_id=dialogue_id)
    return serialize_agent_dialogue(db, dialogue)


@router.post("/{dialogue_id}/stop", response_model=AgentDialogueRead)
def stop_agent_dialogue(dialogue_id: int, db: Session = Depends(db_session)) -> AgentDialogueRead:
    return serialize_agent_dialogue(db, set_agent_dialogue_status(db=db, dialogue_id=dialogue_id, status="stopped"))


@router.post("/{dialogue_id}/messages")
async def add_agent_dialogue_message(
    dialogue_id: int,
    payload: AgentDialogueMessageCreate,
    db: Session = Depends(db_session),
) -> dict[str, str]:
    return await add_agent_dialogue_message_service(db=db, dialogue_id=dialogue_id, content=payload.content)
