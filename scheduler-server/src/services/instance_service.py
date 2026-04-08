from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import secrets

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.models.openclaw_instance import OpenClawInstance
from src.schemas.instance import (
    InstanceCredentialsRead,
    InstanceHealthRead,
    OpenClawConnectRequest,
    OpenClawConnectResponse,
    OpenClawSyncAgentsResponse,
)
from src.services.agent_cleanup import delete_instance_private_data
from src.services.agent_profile_service import sync_instance_agents

HEALTH_CHECK_MAX_WORKERS = 8
HEALTH_CHECK_BATCH_TIMEOUT_SECONDS = 10.0

"""实例记录、健康视图、凭据和同步流程相关的 service。"""


def serialize_instance(instance: OpenClawInstance) -> dict:
    """把单条实例记录整理成 API 返回结构。"""
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


def list_instances_with_runtime_status(
    items: list[OpenClawInstance],
    *,
    resolve_runtime_status,
) -> list[InstanceHealthRead]:
    """并行探测运行时健康状态，同时保留 disabled 实例的固定状态。"""
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


def generate_instance_credentials() -> InstanceCredentialsRead:
    """生成一组新的 callback token 和入站签名密钥。"""
    return InstanceCredentialsRead(
        outbound_token=secrets.token_urlsafe(24),
        inbound_signing_secret=secrets.token_urlsafe(32),
    )


def get_instance_credentials(*, item: OpenClawInstance | None) -> InstanceCredentialsRead:
    """返回某个实例当前保存的凭据。"""
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")
    return InstanceCredentialsRead(
        outbound_token=item.callback_token,
        inbound_signing_secret=item.channel_signing_secret,
    )


def connect_instance(
    *,
    db: Session,
    payload: OpenClawConnectRequest,
    fetch_channel_agents,
) -> OpenClawConnectResponse:
    """创建或更新实例，并在可能时立即同步 agent。"""
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
        imported_agent_count, imported_agent_keys = sync_instance_agents_for_response(db=db, item=item, agents_payload=agents_payload)

    db.commit()
    db.refresh(item)
    return OpenClawConnectResponse(
        instance=item,
        imported_agent_count=imported_agent_count,
        agent_keys=imported_agent_keys,
        credentials=credentials,
    )


def sync_instance_agents_for_response(
    *,
    db: Session,
    item: OpenClawInstance,
    agents_payload: list[dict],
) -> tuple[int, list[str]]:
    """同步本地 agent，并返回适合 API 的简要统计结果。"""
    sync_instance_agents(db, item, agents_payload)
    imported_agent_keys: list[str] = []
    for agent_data in agents_payload:
        agent_key = str(agent_data.get("id") or agent_data.get("openclawAgentRef") or "").strip()
        if agent_key:
            imported_agent_keys.append(agent_key)
    return len(imported_agent_keys), imported_agent_keys


def sync_agents(
    *,
    db: Session,
    item: OpenClawInstance | None,
    fetch_channel_agents,
) -> OpenClawSyncAgentsResponse:
    """获取并导入某个实例当前的远端 agent 列表。"""
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")

    agents_payload = fetch_channel_agents(item.channel_base_url.rstrip("/"))
    imported_agent_count, imported_agent_keys = sync_instance_agents_for_response(db=db, item=item, agents_payload=agents_payload)
    db.commit()
    db.refresh(item)
    return OpenClawSyncAgentsResponse(
        instance=item,
        imported_agent_count=imported_agent_count,
        agent_keys=imported_agent_keys,
    )


def delete_instance(*, db: Session, instance_id: int) -> None:
    """Delete one instance and its private history."""
    item = delete_instance_private_data(db, instance_id=instance_id)
    if not item:
        raise HTTPException(status_code=404, detail="instance not found")
    db.commit()
