"""
这个文件负责实例下的 Agent 管理。

第一阶段里，Agent 主要承担通讯录和路由目标的作用：
1. 前端通讯录展示这些 agent。
2. 单聊会话会直接绑定到某个 agent。
3. 群组成员也引用这里的 agent 记录。
"""

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.integrations.channel_client import channel_client
from src.models.agent_profile import AgentProfile
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.common import dump_model
from src.schemas.agent import AgentCreate, AgentProfileRead, AgentRead, AgentUpdate
from src.schemas.common import validate_orm
from src.services.agent_cleanup import delete_agent_private_conversations
from src.services.agent_cs_id import ensure_agent_cs_id

router = APIRouter(prefix="/api", tags=["agents"])

AGENT_SYNC_TIMEOUT = httpx.Timeout(60.0, connect=5.0)

def can_edit_agent_profile(agent: AgentProfile) -> bool:
    """
    兼容历史数据：
    1. 新创建的 Agent 直接看 created_via_clawswarm。
    2. 旧数据在加字段前没有来源标记，这里先把非 main Agent 视为可编辑，
       避免把此前确实在 ClawSwarm 创建的 Agent 全部误判成只读。
    """
    if agent.created_via_clawswarm:
        return True
    return agent.agent_key.strip().lower() != "main"


def fetch_channel_agents(instance: OpenClawInstance) -> list[dict]:
    base_url = instance.channel_base_url.rstrip("/")
    try:
        with httpx.Client(timeout=AGENT_SYNC_TIMEOUT, verify=False) as client:
            response = client.get(f"{base_url}/clawswarm/v1/agents")
            response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="OpenClaw timed out") from exc
    except (httpx.ConnectError, httpx.NetworkError, httpx.ProxyError) as exc:
        raise HTTPException(status_code=503, detail="OpenClaw instance is unreachable") from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            raise HTTPException(
                status_code=502,
                detail="clawswarm plugin is unavailable on the OpenClaw instance",
            ) from exc
        raise HTTPException(status_code=502, detail="OpenClaw request failed") from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response") from exc
    if not isinstance(payload, list):
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response")
    return [item for item in payload if isinstance(item, dict)]


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
    agent = db.scalar(
        select(AgentProfile).where(
            AgentProfile.instance_id == instance_id,
            AgentProfile.agent_key == agent_key,
        )
    )
    if agent is None:
        agent = AgentProfile(
            instance_id=instance_id,
            agent_key=agent_key,
            display_name=display_name,
            role_name=role_name,
            enabled=enabled,
            removed_from_openclaw=False,
            created_via_clawswarm=created_via_clawswarm or False,
        )
        db.add(agent)
    else:
        agent.display_name = display_name
        if role_name is not None:
            agent.role_name = role_name
        agent.removed_from_openclaw = False
        if created_via_clawswarm is not None:
            agent.created_via_clawswarm = created_via_clawswarm

    db.flush()
    ensure_agent_cs_id(agent)
    db.flush()
    return agent


def sync_instance_agents(db: Session, instance: OpenClawInstance, agents_payload: list[dict]) -> None:
    imported_keys: set[str] = set()
    for agent_data in agents_payload:
        agent_key = str(agent_data.get("id") or agent_data.get("openclawAgentRef") or "").strip()
        display_name = str(agent_data.get("name") or agent_key).strip()
        if not agent_key:
            continue

        imported_keys.add(agent_key)
        upsert_instance_agent(
            db,
            instance_id=instance.id,
            agent_key=agent_key,
            display_name=display_name,
            enabled=True,
        )

    if imported_keys:
        existing_agents = db.scalars(select(AgentProfile).where(AgentProfile.instance_id == instance.id)).all()
        for agent in existing_agents:
            if agent.agent_key not in imported_keys:
                delete_agent_private_conversations(db, agent_id=agent.id)
                agent.removed_from_openclaw = True

    db.flush()


@router.get("/instances/{instance_id}/agents", response_model=list[AgentRead])
def list_agents(instance_id: int, db: Session = Depends(db_session)) -> list[AgentProfile]:
    agents = list(
        db.scalars(
            select(AgentProfile)
            .where(
                AgentProfile.instance_id == instance_id,
                AgentProfile.removed_from_openclaw.is_(False),
            )
            .order_by(AgentProfile.id)
        )
    )
    touched = False
    for agent in agents:
        if not (agent.cs_id or "").strip():
            ensure_agent_cs_id(agent)
            touched = True
    if touched:
        db.commit()
        for agent in agents:
            db.refresh(agent)
    return agents


@router.post("/instances/{instance_id}/agents", response_model=AgentRead)
async def create_agent(instance_id: int, payload: AgentCreate, db: Session = Depends(db_session)) -> AgentProfile:
    instance = db.get(OpenClawInstance, instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="instance not found")

    # 远端 channel 创建接口要求这些 markdown 字段是字符串。
    # 创建时如果某个文件留空，就不要把 None 透传成 null，而是直接省略该字段。
    remote_create_payload = {
        "agentKey": payload.agent_key,
        "displayName": payload.display_name,
    }
    if payload.identity_md is not None:
        remote_create_payload["identityMd"] = payload.identity_md
    if payload.soul_md is not None:
        remote_create_payload["soulMd"] = payload.soul_md
    if payload.user_md is not None:
        remote_create_payload["userMd"] = payload.user_md
    if payload.memory_md is not None:
        remote_create_payload["memoryMd"] = payload.memory_md

    try:
        created_remote_agent = await channel_client.create_agent(
            instance=instance,
            payload=remote_create_payload,
        )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="OpenClaw timed out") from exc
    except (httpx.ConnectError, httpx.NetworkError, httpx.ProxyError) as exc:
        raise HTTPException(status_code=503, detail="OpenClaw instance is unreachable") from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in {401, 403}:
            raise HTTPException(status_code=400, detail="OpenClaw instance signature mismatch") from exc
        if exc.response.status_code == 404:
            raise HTTPException(
                status_code=502,
                detail="clawswarm plugin is unavailable on the OpenClaw instance",
            ) from exc
        raise HTTPException(status_code=502, detail="OpenClaw request failed") from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response") from exc

    agent_key = str(created_remote_agent.get("id") or created_remote_agent.get("openclawAgentRef") or payload.agent_key).strip()
    display_name = str(created_remote_agent.get("name") or payload.display_name).strip() or payload.display_name

    # 远端真实创建成功后，先确保本地记录落库。
    # 这样即使 /agents 列表存在瞬时延迟，也不会把成功创建误判成 500。
    agent = upsert_instance_agent(
        db,
        instance_id=instance_id,
        agent_key=agent_key,
        display_name=display_name,
        role_name=payload.role_name,
        enabled=payload.enabled,
        created_via_clawswarm=True,
    )

    try:
        agents_payload = fetch_channel_agents(instance)
    except HTTPException:
        agents_payload = []

    if agents_payload:
        if not any(str(item.get("id") or item.get("openclawAgentRef") or "").strip() == agent_key for item in agents_payload):
            agents_payload.append(created_remote_agent)
        sync_instance_agents(db, instance, agents_payload)

    if payload.role_name is not None:
        agent.role_name = payload.role_name

    db.commit()
    db.refresh(agent)
    return agent


@router.get("/agents/{agent_id}/profile", response_model=AgentProfileRead)
async def get_agent_profile(agent_id: int, db: Session = Depends(db_session)) -> AgentProfileRead:
    agent = db.get(AgentProfile, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="agent not found")
    if not can_edit_agent_profile(agent):
        raise HTTPException(status_code=403, detail="agent profile is read-only")
    if not (agent.cs_id or "").strip():
        ensure_agent_cs_id(agent)
        db.commit()
        db.refresh(agent)

    instance = db.get(OpenClawInstance, agent.instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="instance not found")

    try:
        profile = await channel_client.get_agent_profile(
            instance=instance,
            agent_key=agent.agent_key,
        )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="OpenClaw timed out") from exc
    except (httpx.ConnectError, httpx.NetworkError, httpx.ProxyError) as exc:
        raise HTTPException(status_code=503, detail="OpenClaw instance is unreachable") from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in {401, 403}:
            raise HTTPException(status_code=400, detail="OpenClaw instance signature mismatch") from exc
        if exc.response.status_code == 404:
            raise HTTPException(
                status_code=502,
                detail="clawswarm plugin is unavailable on the OpenClaw instance",
            ) from exc
        raise HTTPException(status_code=502, detail="OpenClaw request failed") from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response") from exc

    return AgentProfileRead(
        **dump_model(validate_orm(AgentRead, agent)),
        identity_md=str(profile.get("identityMd") or ""),
        soul_md=str(profile.get("soulMd") or ""),
        user_md=str(profile.get("userMd") or ""),
        memory_md=str(profile.get("memoryMd") or ""),
    )


@router.put("/agents/{agent_id}", response_model=AgentRead)
async def update_agent(agent_id: int, payload: AgentUpdate, db: Session = Depends(db_session)) -> AgentProfile:
    agent = db.get(AgentProfile, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="agent not found")
    if not can_edit_agent_profile(agent):
        raise HTTPException(status_code=403, detail="agent profile is read-only")

    instance = db.get(OpenClawInstance, agent.instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="instance not found")

    payload_data = dump_model(payload, exclude_unset=True)

    remote_payload: dict[str, str] = {}
    if payload.display_name is not None:
        remote_payload["displayName"] = payload.display_name
    if payload.identity_md is not None:
        remote_payload["identityMd"] = payload.identity_md
    if payload.soul_md is not None:
        remote_payload["soulMd"] = payload.soul_md
    if payload.user_md is not None:
        remote_payload["userMd"] = payload.user_md
    if payload.memory_md is not None:
        remote_payload["memoryMd"] = payload.memory_md

    if remote_payload:
        try:
            await channel_client.update_agent(
                instance=instance,
                agent_key=agent.agent_key,
                payload=remote_payload,
            )
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=504, detail="OpenClaw timed out") from exc
        except (httpx.ConnectError, httpx.NetworkError, httpx.ProxyError) as exc:
            raise HTTPException(status_code=503, detail="OpenClaw instance is unreachable") from exc
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in {401, 403}:
                raise HTTPException(status_code=400, detail="OpenClaw instance signature mismatch") from exc
            if exc.response.status_code == 404:
                raise HTTPException(
                    status_code=502,
                detail="clawswarm plugin is unavailable on the OpenClaw instance",
                ) from exc
            raise HTTPException(status_code=502, detail="OpenClaw request failed") from exc
        except ValueError as exc:
            raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response") from exc

    for key, value in payload_data.items():
        if key in {"identity_md", "soul_md", "user_md", "memory_md"}:
            continue
        setattr(agent, key, value)
    if not (agent.cs_id or "").strip():
        ensure_agent_cs_id(agent)
    db.commit()
    db.refresh(agent)
    return agent


@router.post("/agents/{agent_id}/enable", response_model=AgentRead)
def enable_agent(agent_id: int, db: Session = Depends(db_session)) -> AgentProfile:
    # 第一阶段先用 enabled 做逻辑开关，避免直接删除导致群组成员和历史消息失联。
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
