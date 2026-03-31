"""
这个文件负责 OpenClaw 实例管理。

第一阶段里，一个实例代表一套可调用的 claw-team channel：
1. 保存 channel 地址。
2. 保存 accountId。
3. 保存调度中心到 channel 的签名密钥。
4. 保存 channel 回调调度中心时使用的 callback token。
"""
from fastapi import APIRouter, Depends, HTTPException
import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.api.routes.agents import sync_instance_agents as sync_instance_agent_profiles
from src.models.agent_profile import AgentProfile
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.common import dump_model
from src.schemas.instance import (
    InstanceCreate,
    InstanceRead,
    InstanceUpdate,
    OpenClawConnectRequest,
    OpenClawConnectResponse,
    OpenClawSyncAgentsResponse,
)

router = APIRouter(prefix="/api/instances", tags=["instances"])


def fetch_channel_agents(base_url: str) -> list[dict]:
    try:
        with httpx.Client(timeout=10.0, verify=False) as client:
            health = client.get(f"{base_url}/claw-team/v1/health")
            health.raise_for_status()
            agents_response = client.get(f"{base_url}/claw-team/v1/agents")
            agents_response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"failed to connect channel: {exc}") from exc

    agents_payload = agents_response.json()
    if not isinstance(agents_payload, list):
        raise HTTPException(status_code=400, detail="invalid agents response")
    return [item for item in agents_payload if isinstance(item, dict)]

def sync_instance_agents(db: Session, instance: OpenClawInstance, agents_payload: list[dict]) -> tuple[int, list[str]]:
    """
    实例同步和 Agent 管理页同步必须复用同一套实现。

    否则一边会清理已删除 Agent 的联系人历史，另一边不会，最后就会出现
    “Agent 已经 removed，但最近联系人还残留”的不一致状态。
    """
    sync_instance_agent_profiles(db, instance, agents_payload)

    imported_agent_keys: list[str] = []
    for agent_data in agents_payload:
        agent_key = str(agent_data.get("id") or agent_data.get("openclawAgentRef") or "").strip()
        if agent_key:
            imported_agent_keys.append(agent_key)
    return len(imported_agent_keys), imported_agent_keys


@router.get("", response_model=list[InstanceRead])
def list_instances(db: Session = Depends(db_session)) -> list[OpenClawInstance]:
    return list(db.scalars(select(OpenClawInstance).order_by(OpenClawInstance.id)))


@router.post("", response_model=InstanceRead)
def create_instance(payload: InstanceCreate, db: Session = Depends(db_session)) -> OpenClawInstance:
    # 这里保存的是“调度中心怎么找到某个 OpenClaw 实例上的 channel”所需的最小信息。
    item = OpenClawInstance(**dump_model(payload))
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.post("/connect", response_model=OpenClawConnectResponse)
def connect_instance(payload: OpenClawConnectRequest, db: Session = Depends(db_session)) -> OpenClawConnectResponse:
    """
    快速接入一套已经安装好 claw-team channel 的 OpenClaw。

    这里做 4 件事：
    1. 调 /health 验证 channel 已加载。
    2. 调 /agents 拉取可用 Agent。
    3. 创建或更新实例记录。
    4. 自动导入 Agent，避免用户手工新增。
    """
    base_url = payload.channel_base_url.rstrip("/")
    agents_payload = fetch_channel_agents(base_url)

    # 傻瓜模式下，先把 shared_secret 同时作为入站签名密钥和 callback token。
    # 这样用户只需要维护一个连接密钥。
    item = db.scalar(
        select(OpenClawInstance).where(
            (OpenClawInstance.name == payload.name) | (OpenClawInstance.channel_base_url == base_url)
        )
    )
    if item is None:
        item = OpenClawInstance(
            name=payload.name,
            channel_base_url=base_url,
            channel_account_id=payload.channel_account_id,
            channel_signing_secret=payload.shared_secret,
            callback_token=payload.shared_secret,
            status="active",
        )
        db.add(item)
        db.flush()
    else:
        item.name = payload.name
        item.channel_base_url = base_url
        item.channel_account_id = payload.channel_account_id
        item.channel_signing_secret = payload.shared_secret
        item.callback_token = payload.shared_secret
        item.status = "active"
        db.flush()

    imported_agent_count, imported_agent_keys = sync_instance_agents(db, item, agents_payload)

    db.commit()
    db.refresh(item)
    return OpenClawConnectResponse(
        instance=item,
        imported_agent_count=imported_agent_count,
        agent_keys=imported_agent_keys,
    )


@router.post("/{instance_id}/sync-agents", response_model=OpenClawSyncAgentsResponse)
def sync_agents(instance_id: int, db: Session = Depends(db_session)) -> OpenClawSyncAgentsResponse:
    item = db.get(OpenClawInstance, instance_id)
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")

    agents_payload = fetch_channel_agents(item.channel_base_url.rstrip("/"))
    imported_agent_count, imported_agent_keys = sync_instance_agents(db, item, agents_payload)
    item.status = "active"
    db.commit()
    db.refresh(item)
    return OpenClawSyncAgentsResponse(
        instance=item,
        imported_agent_count=imported_agent_count,
        agent_keys=imported_agent_keys,
    )


@router.put("/{instance_id}", response_model=InstanceRead)
def update_instance(instance_id: int, payload: InstanceUpdate, db: Session = Depends(db_session)) -> OpenClawInstance:
    item = db.get(OpenClawInstance, instance_id)
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")
    for key, value in dump_model(payload, exclude_unset=True).items():
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item


@router.post("/{instance_id}/enable", response_model=InstanceRead)
def enable_instance(instance_id: int, db: Session = Depends(db_session)) -> OpenClawInstance:
    # 第一阶段先用 status 字段做软开关，不直接删配置。
    item = db.get(OpenClawInstance, instance_id)
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")
    item.status = "active"
    db.commit()
    db.refresh(item)
    return item


@router.post("/{instance_id}/disable", response_model=InstanceRead)
def disable_instance(instance_id: int, db: Session = Depends(db_session)) -> OpenClawInstance:
    item = db.get(OpenClawInstance, instance_id)
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")
    item.status = "disabled"
    db.commit()
    db.refresh(item)
    return item
