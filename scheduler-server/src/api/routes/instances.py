"""
这个文件负责 OpenClaw 实例管理。

第一阶段里，一个实例代表一套可调用的 claw-team channel：
1. 保存 channel 地址。
2. 保存 accountId。
3. 保存调度中心到 channel 的签名密钥。
4. 保存 channel 回调调度中心时使用的 callback token。
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import secrets

from fastapi import APIRouter, Depends, HTTPException
import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.api.routes.agents import sync_instance_agents as sync_instance_agent_profiles
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.common import dump_model
from src.schemas.instance import (
    InstanceCreate,
    InstanceCredentialsRead,
    InstanceHealthRead,
    InstanceRead,
    InstanceUpdate,
    OpenClawConnectRequest,
    OpenClawConnectResponse,
    OpenClawSyncAgentsResponse,
)
from src.services.agent_cleanup import delete_instance_private_data

router = APIRouter(prefix="/api/instances", tags=["instances"])

HEALTH_CHECK_TIMEOUT = httpx.Timeout(5.0, connect=2.0)
HEALTH_CHECK_MAX_WORKERS = 8
HEALTH_CHECK_BATCH_TIMEOUT_SECONDS = 10.0
CHANNEL_FETCH_TIMEOUT = 60.0


def fetch_channel_agents(base_url: str) -> list[dict]:
    try:
        with httpx.Client(timeout=CHANNEL_FETCH_TIMEOUT, verify=False) as client:
            health = client.get(f"{base_url}/claw-team/v1/health")
            health.raise_for_status()
            agents_response = client.get(f"{base_url}/claw-team/v1/agents")
            agents_response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="OpenClaw timed out") from exc
    except (httpx.ConnectError, httpx.NetworkError, httpx.ProxyError) as exc:
        raise HTTPException(status_code=503, detail="OpenClaw instance is unreachable") from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            raise HTTPException(
                status_code=502,
                detail="claw-team plugin is unavailable on the OpenClaw instance",
            ) from exc
        raise HTTPException(status_code=502, detail="OpenClaw request failed") from exc

    try:
        agents_payload = agents_response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response") from exc
    if not isinstance(agents_payload, list):
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response")
    return [item for item in agents_payload if isinstance(item, dict)]


def probe_channel_health(base_url: str) -> bool:
    try:
        with httpx.Client(timeout=HEALTH_CHECK_TIMEOUT, verify=False) as client:
            response = client.get(f"{base_url.rstrip('/')}/claw-team/v1/health")
            response.raise_for_status()
            return True
    except httpx.HTTPError:
        return False


def resolve_runtime_status(instance: OpenClawInstance) -> str:
    if instance.status == "disabled":
        return "disabled"
    return "active" if probe_channel_health(instance.channel_base_url) else "offline"


def serialize_instance(instance: OpenClawInstance) -> dict:
    return {
        "id": instance.id,
        "instance_key": instance.instance_key,
        "name": instance.name,
        "channel_base_url": instance.channel_base_url,
        "channel_account_id": instance.channel_account_id,
        "status": instance.status,
        "created_at": instance.created_at,
        "updated_at": instance.updated_at,
    }


def list_instances_with_runtime_status(items: list[OpenClawInstance]) -> list[InstanceHealthRead]:
    disabled_instance_ids = {item.id for item in items if item.status == "disabled"}
    runtime_status_by_id = {item_id: "disabled" for item_id in disabled_instance_ids}

    active_candidates = [item for item in items if item.id not in disabled_instance_ids]
    if active_candidates:
        with ThreadPoolExecutor(max_workers=min(HEALTH_CHECK_MAX_WORKERS, len(active_candidates))) as executor:
            future_map = {
                executor.submit(resolve_runtime_status, item): item.id
                for item in active_candidates
            }
            pending_futures = set(future_map)
            try:
                for future in as_completed(future_map, timeout=HEALTH_CHECK_BATCH_TIMEOUT_SECONDS):
                    instance_id = future_map[future]
                    runtime_status_by_id[instance_id] = future.result()
                    pending_futures.discard(future)
            except TimeoutError:
                pass

            for future in pending_futures:
                instance_id = future_map[future]
                runtime_status_by_id[instance_id] = "offline"
                future.cancel()

    return [InstanceHealthRead(id=item.id, status=runtime_status_by_id[item.id]) for item in items]

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


def generate_instance_credentials() -> InstanceCredentialsRead:
    return InstanceCredentialsRead(
        outbound_token=secrets.token_urlsafe(24),
        inbound_signing_secret=secrets.token_urlsafe(32),
    )


@router.get("", response_model=list[InstanceRead])
def list_instances(db: Session = Depends(db_session)) -> list[dict]:
    items = list(db.scalars(select(OpenClawInstance).order_by(OpenClawInstance.id)))
    return [serialize_instance(item) for item in items]


@router.get("/health", response_model=list[InstanceHealthRead])
def list_instance_health(db: Session = Depends(db_session)) -> list[InstanceHealthRead]:
    items = list(db.scalars(select(OpenClawInstance).order_by(OpenClawInstance.id)))
    return list_instances_with_runtime_status(items)


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
    1. 创建或更新实例记录，并生成一组新的配对凭据。
    2. 尝试调 /agents 拉取可用 Agent。
    3. 如果 channel 还没配完导致暂时连不上，也不阻塞实例创建。
    4. 用户把凭据写回 OpenClaw 后，可以再单独执行 sync-agents。
    """
    base_url = payload.channel_base_url.rstrip("/")

    credentials = generate_instance_credentials()
    item = db.scalar(
        select(OpenClawInstance).where(
            OpenClawInstance.channel_base_url == base_url
        )
    )
    if item is None:
        item = OpenClawInstance(
            name=payload.name,
            channel_base_url=base_url,
            channel_account_id=payload.channel_account_id,
            channel_signing_secret=credentials.inbound_signing_secret,
            callback_token=credentials.outbound_token,
            status="active",
        )
        db.add(item)
        db.flush()
    else:
        item.name = payload.name
        item.channel_base_url = base_url
        item.channel_account_id = payload.channel_account_id
        item.channel_signing_secret = credentials.inbound_signing_secret
        item.callback_token = credentials.outbound_token
        db.flush()

    imported_agent_count = 0
    imported_agent_keys: list[str] = []
    try:
        agents_payload = fetch_channel_agents(base_url)
    except HTTPException:
        agents_payload = None

    if agents_payload is not None:
        imported_agent_count, imported_agent_keys = sync_instance_agents(db, item, agents_payload)

    db.commit()
    db.refresh(item)
    return OpenClawConnectResponse(
        instance=item,
        imported_agent_count=imported_agent_count,
        agent_keys=imported_agent_keys,
        credentials=credentials,
    )


@router.get("/{instance_id}/credentials", response_model=InstanceCredentialsRead)
def get_instance_credentials(instance_id: int, db: Session = Depends(db_session)) -> InstanceCredentialsRead:
    item = db.get(OpenClawInstance, instance_id)
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")
    return InstanceCredentialsRead(
        outbound_token=item.callback_token,
        inbound_signing_secret=item.channel_signing_secret,
    )


@router.post("/{instance_id}/sync-agents", response_model=OpenClawSyncAgentsResponse)
def sync_agents(instance_id: int, db: Session = Depends(db_session)) -> OpenClawSyncAgentsResponse:
    item = db.get(OpenClawInstance, instance_id)
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")

    agents_payload = fetch_channel_agents(item.channel_base_url.rstrip("/"))
    imported_agent_count, imported_agent_keys = sync_instance_agents(db, item, agents_payload)
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

    updates = dump_model(payload, exclude_unset=True)
    for key, value in updates.items():
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


@router.delete("/{instance_id}", status_code=204)
def delete_instance(instance_id: int, db: Session = Depends(db_session)) -> None:
    item = delete_instance_private_data(db, instance_id=instance_id)
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")
    db.commit()
