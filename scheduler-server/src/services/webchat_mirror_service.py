from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.models.agent_profile import AgentProfile
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.openclaw_instance import OpenClawInstance
from src.services.conversation_events import conversation_event_hub
from src.services.default_user import get_default_user_identity

WEBCHAT_CHANNEL_ID = "webchat"
AGENT_SESSION_PREFIX = "agent:"
WEBCHAT_MIRROR_EVENT_SOURCE = "webchat_mirror"
DEFAULT_USER = get_default_user_identity()

"""把 OpenClaw Web UI 消息镜像进会话的 service。"""


async def mirror_webchat_message(
    *,
    db: Session,
    instance: OpenClawInstance,
    payload: Any,
) -> dict[str, Any]:
    """把一条镜像过来的 Web UI 消息追加到匹配的 direct 会话。"""
    if payload.channelId.strip() != WEBCHAT_CHANNEL_ID:
        raise HTTPException(status_code=400, detail="only webchat mirror is supported")

    agent_key = _parse_agent_key_from_session_key(payload.sessionKey)
    if not agent_key:
        raise HTTPException(status_code=400, detail="invalid webchat session key")

    agent = db.scalar(
        select(AgentProfile).where(
            AgentProfile.instance_id == instance.id,
            AgentProfile.agent_key == agent_key,
        )
    )
    if not agent:
        raise HTTPException(status_code=404, detail="mirror agent not found")

    conversation = db.scalar(
        select(Conversation).where(
            Conversation.type == "direct",
            Conversation.direct_instance_id == instance.id,
            Conversation.direct_agent_id == agent.id,
        )
    )
    if conversation is None:
        conversation = Conversation(
            type="direct",
            title=f"{instance.name} / {agent.display_name}",
            direct_instance_id=instance.id,
            direct_agent_id=agent.id,
        )
        db.add(conversation)
        db.flush()

    sender_type = _normalize_mirror_sender_type(payload.senderType)
    sender_label = agent.display_name if sender_type == "agent" else DEFAULT_USER.sender_label
    sender_cs_id = agent.cs_id if sender_type == "agent" else DEFAULT_USER.cs_id

    mirrored_message_id = _build_webchat_mirror_message_id(
        instance_id=instance.id,
        agent_key=agent.agent_key,
        session_key=payload.sessionKey,
        provider_message_id=payload.messageId,
        sender_type=sender_type,
    )
    mirrored_message = db.get(Message, mirrored_message_id)
    if mirrored_message is None:
        db.add(
            Message(
                id=mirrored_message_id,
                conversation_id=conversation.id,
                sender_type=sender_type,
                sender_label=sender_label,
                sender_cs_id=sender_cs_id,
                content=payload.content.strip(),
                status="completed",
                created_at=_resolve_webchat_mirror_created_at(payload.timestamp),
            )
        )
        db.commit()
        await conversation_event_hub.publish_update(
            conversation.id,
            {
                "source": WEBCHAT_MIRROR_EVENT_SOURCE,
                "messageId": mirrored_message_id,
            },
        )
    else:
        db.commit()

    return {
        "ok": True,
        "conversationId": conversation.id,
        "messageId": mirrored_message_id,
    }


def _parse_agent_key_from_session_key(session_key: str) -> str | None:
    """从 OpenClaw `agent:<id>:...` 形式的 session key 中提取 agent key。"""
    raw = session_key.strip()
    if not raw.startswith(AGENT_SESSION_PREFIX):
        return None
    parts = raw.split(":")
    if len(parts) < 3:
        return None
    agent_key = parts[1].strip()
    return agent_key or None


def _build_webchat_mirror_message_id(
    *,
    instance_id: int,
    agent_key: str,
    session_key: str,
    provider_message_id: str,
    sender_type: str,
) -> str:
    """构造稳定的消息 id，保证重复镜像事件仍然幂等。"""
    digest = hashlib.sha1(
        f"{instance_id}|{agent_key}|{session_key}|{provider_message_id}|{sender_type}".encode("utf-8")
    ).hexdigest()
    return f"msg_web_{digest}"


def _normalize_mirror_sender_type(value: str) -> str:
    """把 Web UI 的发送者类型映射成调度中心内部 sender_type。"""
    normalized = value.strip().lower()
    if normalized in {"agent", "assistant"}:
        return "agent"
    return "user"


def _resolve_webchat_mirror_created_at(timestamp_ms: int | None) -> datetime | None:
    """把毫秒时间戳转换成用于存储的 UTC datetime。"""
    if timestamp_ms is None:
        return None
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
