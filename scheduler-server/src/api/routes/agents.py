"""Agent 目录与远端 profile 管理路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.models.agent_profile import AgentProfile
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.agent import AgentCreate, AgentProfileRead, AgentRead, AgentUpdate
from src.services.agent_profile_service import (
    can_edit_agent_profile as can_edit_agent_profile_service,
    create_agent_for_instance,
    ensure_listable_agents,
    load_agent_profile,
    sync_instance_agents as sync_instance_agents_service,
    update_agent_profile,
    upsert_instance_agent as upsert_instance_agent_service,
)
from src.services.openclaw_probe_service import fetch_channel_agents as fetch_channel_agents_from_openclaw

router = APIRouter(prefix="/api", tags=["agents"])

def can_edit_agent_profile(agent: AgentProfile) -> bool:
    """为现有调用方和测试保留的兼容包装。"""
    return can_edit_agent_profile_service(agent)


def fetch_channel_agents(instance: OpenClawInstance) -> list[dict]:
    """为现有调用方和测试保留的兼容包装。"""
    return fetch_channel_agents_from_openclaw(instance.channel_base_url.rstrip("/"))


def upsert_instance_agent(
    db: Session,
    *,
    instance_id: int,
    agent_key: str,
    display_name: str,
    role_name: str | None = None,
    enabled: bool = True,
    created_via_clawswarm: bool | None = None,
) -> AgentProfile:
    """为现有调用方和测试保留的兼容包装。"""
    return upsert_instance_agent_service(
        db,
        instance_id=instance_id,
        agent_key=agent_key,
        display_name=display_name,
        role_name=role_name,
        enabled=enabled,
        created_via_clawswarm=created_via_clawswarm,
    )


def sync_instance_agents(db: Session, instance: OpenClawInstance, agents_payload: list[dict]) -> None:
    """为现有调用方和测试保留的兼容包装。"""
    sync_instance_agents_service(db, instance, agents_payload)


@router.get("/instances/{instance_id}/agents", response_model=list[AgentRead])
def list_agents(instance_id: int, db: Session = Depends(db_session)) -> list[AgentProfile]:
    return ensure_listable_agents(db, instance_id)


@router.post("/instances/{instance_id}/agents", response_model=AgentRead)
async def create_agent(instance_id: int, payload: AgentCreate, db: Session = Depends(db_session)) -> AgentProfile:
    instance = db.get(OpenClawInstance, instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="instance not found")
    return await create_agent_for_instance(db=db, instance=instance, payload=payload)


@router.get("/agents/{agent_id}/profile", response_model=AgentProfileRead)
async def get_agent_profile(agent_id: int, db: Session = Depends(db_session)) -> AgentProfileRead:
    agent = db.get(AgentProfile, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="agent not found")
    return await load_agent_profile(db=db, agent=agent)


@router.put("/agents/{agent_id}", response_model=AgentRead)
async def update_agent(agent_id: int, payload: AgentUpdate, db: Session = Depends(db_session)) -> AgentProfile:
    agent = db.get(AgentProfile, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="agent not found")
    return await update_agent_profile(db=db, agent=agent, payload=payload)


@router.post("/agents/{agent_id}/enable", response_model=AgentRead)
def enable_agent(agent_id: int, db: Session = Depends(db_session)) -> AgentProfile:
    # 启用/禁用只改可用状态，不破坏历史消息和群成员关系中的引用。
    agent = db.get(AgentProfile, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="agent not found")
    agent.enabled = True
    db.commit()
    db.refresh(agent)
    return agent


@router.post("/agents/{agent_id}/disable", response_model=AgentRead)
def disable_agent(agent_id: int, db: Session = Depends(db_session)) -> AgentProfile:
    agent = db.get(AgentProfile, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="agent not found")
    agent.enabled = False
    db.commit()
    db.refresh(agent)
    return agent
