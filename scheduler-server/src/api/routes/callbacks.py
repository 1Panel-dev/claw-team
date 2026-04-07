"""
这个文件负责接收 clawswarm channel 回调回来的执行事件。

主要职责：
1. 校验 callback token 和可选签名。
2. 根据 correlation 信息找到 dispatch 与原始用户消息。
3. 把 run.accepted / reply.chunk / reply.final / run.error 映射成数据库状态。
4. 在 reply.final 时额外落一条 agent 消息，供前端展示。

维护注意点：
1. callback 可能因为网络抖动、重试或超时而被重复投递。
2. 因此这里必须尽量做到幂等，避免重复落 agent 消息或把状态倒退回较早阶段。
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.core.security import verify_callback_signature
from src.models.agent_profile import AgentProfile
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_callback_event import MessageCallbackEvent
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.models.agent_dialogue import AgentDialogue
from src.services.conversation_events import conversation_event_hub
from src.services.agent_dialogue_lookup import find_reusable_agent_dialogue
from src.services.agent_dialogue_runner import continue_agent_dialogue_after_reply, dispatch_agent_dialogue_turn
from src.services.agent_cs_id import ensure_agent_cs_id
from src.services.default_user import get_default_user_identity

router = APIRouter(prefix="/api/v1/clawswarm", tags=["callbacks"])

CHANNEL_ID = "clawswarm"
WEBCHAT_CHANNEL_ID = "webchat"
AGENT_SESSION_PREFIX = "agent:"
WEBCHAT_MIRROR_EVENT_SOURCE = "webchat_mirror"
DEFAULT_USER = get_default_user_identity()


class WebchatMirrorCreate(BaseModel):
    """
    这是 OpenClaw Web UI 对话镜像到调度中心时使用的最小 payload。

    这里接收 OpenClaw Web UI transcript 里追加的消息：
    1. channelId 必须是 webchat
    2. sessionKey 必须能解析出 agent:<agentId>:...
    3. messageId 用于幂等，避免同一条 provider 消息重复镜像
    """

    channelId: str = Field(min_length=1)
    sessionKey: str = Field(min_length=1)
    messageId: str = Field(min_length=1)
    senderType: str = Field(min_length=1)
    content: str = Field(min_length=1)
    timestamp: int | None = Field(default=None, ge=0)


class SendTextCreate(BaseModel):
    kind: str = Field(min_length=1)
    sourceCsId: str = Field(min_length=1)
    targetCsId: str = Field(min_length=1)
    topic: str = Field(min_length=1)
    message: str = Field(min_length=1)
    windowSeconds: int = Field(default=300, ge=60, le=3600)
    softMessageLimit: int = Field(default=12, ge=2, le=100)
    hardMessageLimit: int = Field(default=20, ge=3, le=200)


@router.post("/events")
async def receive_callback(request: Request, db: Session = Depends(db_session)) -> dict[str, bool]:
    # body 需要既参与签名校验，也要做 JSON 解析，所以这里先完整读出字节串。
    body = await request.body()
    auth_header = request.headers.get("authorization", "")
    timestamp = request.headers.get("x-clawswarm-timestamp", "")
    signature = request.headers.get("x-clawswarm-signature", "")

    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = auth_header.removeprefix("Bearer ").strip()
    instance = db.scalar(select(OpenClawInstance).where(OpenClawInstance.callback_token == token))
    if not instance:
        raise HTTPException(status_code=401, detail="unknown callback token")

    # channel 侧会附带可选签名；这里验证通过后，才能信任事件内容和来源。
    if timestamp and signature and not verify_callback_signature(token=token, timestamp=timestamp, body=body, signature=signature):
        raise HTTPException(status_code=401, detail="bad callback signature")

    event = json.loads(body.decode("utf-8"))
    event_id = str(event.get("eventId", "")).strip()
    event_type = str(event.get("eventType", "")).strip()
    correlation = event.get("correlation", {})
    message_id = correlation.get("messageId")
    session_key = correlation.get("sessionKey")
    agent_key = correlation.get("agentId")

    if not message_id or not agent_key:
        raise HTTPException(status_code=400, detail="invalid callback event")

    agent = db.scalar(select(AgentProfile).where(AgentProfile.instance_id == instance.id, AgentProfile.agent_key == agent_key))
    if not agent:
        raise HTTPException(status_code=404, detail="callback agent not found")

    dispatch = db.scalar(
        select(MessageDispatch).where(
            MessageDispatch.message_id == message_id,
            MessageDispatch.instance_id == instance.id,
            MessageDispatch.agent_id == agent.id,
        )
    )
    if not dispatch:
        raise HTTPException(status_code=404, detail="dispatch not found")

    existing_event = None
    if event_id:
        existing_event = db.scalar(
            select(MessageCallbackEvent).where(
                MessageCallbackEvent.dispatch_id == dispatch.id,
                MessageCallbackEvent.event_id == event_id,
            )
        )
    if existing_event:
        # 同一个 dispatch 下 eventId 已出现过时，直接视为成功处理，避免重复写消息或回退状态。
        return {"ok": True}

    # 无论事件类型是什么，都先把原始 callback 事件落库，方便后面排障和回放。
    db.add(
        MessageCallbackEvent(
            dispatch_id=dispatch.id,
            event_id=event_id,
            event_type=event_type,
            payload_json=event.get("payload", {}),
        )
    )

    dispatch.session_key = session_key or dispatch.session_key
    dispatch.status = _pick_higher_status(dispatch.status, _map_dispatch_status(event_type))

    message = db.get(Message, message_id)
    agent_message_id = f"msg_agent_{dispatch.id}"
    agent_message = db.get(Message, agent_message_id)
    if message:
        if event_type == "reply.final":
            # final 事件视为一次 agent 回复完成，因此生成一条 sender_type=agent 的消息。
            text = _build_message_content(event.get("payload", {}))
            if text.strip():
                if not agent_message:
                    db.add(
                        Message(
                            id=agent_message_id,
                            conversation_id=dispatch.conversation_id,
                            sender_type="agent",
                            sender_label=agent.display_name,
                            sender_cs_id=agent.cs_id,
                            content=text,
                            status="completed",
                        )
                    )
                else:
                    agent_message.content = text
                    agent_message.status = "completed"
            elif agent_message:
                agent_message.status = "completed"
            if message.sender_type == "user":
                message.status = "completed"
        elif event_type == "reply.chunk":
            chunk_text = str(event.get("payload", {}).get("text", ""))
            if chunk_text:
                if not agent_message:
                    db.add(
                        Message(
                            id=agent_message_id,
                            conversation_id=dispatch.conversation_id,
                            sender_type="agent",
                            sender_label=agent.display_name,
                            sender_cs_id=agent.cs_id,
                            content=chunk_text,
                            status="streaming",
                        )
                    )
                else:
                    agent_message.content = f"{agent_message.content}{chunk_text}"
                    agent_message.status = "streaming"
            if message.sender_type == "user":
                message.status = _pick_higher_status(message.status, "streaming")
        elif event_type == "run.error":
            if agent_message:
                agent_message.status = "failed"
            if message.sender_type == "user":
                message.status = "failed"
        else:
            # accepted / chunk 都还没结束，只更新用户消息的过程态。
            next_message_status = "accepted"
            if message.sender_type == "user":
                message.status = _pick_higher_status(message.status, next_message_status)

    db.commit()

    if event_type == "reply.final" and agent_message:
        dialogue = db.scalar(select(AgentDialogue).where(AgentDialogue.conversation_id == dispatch.conversation_id))
        if dialogue:
            await continue_agent_dialogue_after_reply(
                db=db,
                dialogue=dialogue,
                dispatch=dispatch,
                reply_message=agent_message,
            )

    await conversation_event_hub.publish_update(
        dispatch.conversation_id,
        {
            "source": "callback",
            "eventType": event_type,
            "messageId": message_id,
        },
    )
    return {"ok": True}


@router.post("/webchat-mirror")
async def mirror_webchat_message(
    payload: WebchatMirrorCreate,
    request: Request,
    db: Session = Depends(db_session),
) -> dict[str, Any]:
    """
    把 OpenClaw Web UI 里直接产生的消息追加镜像到调度中心。

    设计原则：
    1. 只追加，不覆盖现有消息。
    2. 只接受 webchat，避免把别的渠道混进来。
    3. 用 provider messageId 生成稳定消息 id，保证幂等。
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = auth_header.removeprefix("Bearer ").strip()
    instance = db.scalar(select(OpenClawInstance).where(OpenClawInstance.callback_token == token))
    if not instance:
        raise HTTPException(status_code=401, detail="unknown callback token")

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


@router.post("/send-text")
async def receive_send_text(
    payload: SendTextCreate,
    request: Request,
    db: Session = Depends(db_session),
) -> dict[str, Any]:
    """
    这是给 clawswarm channel outbound.sendText 用的最小业务入口。

    第一阶段只支持一件事：
    - 用结构化 JSON 发起一条 Agent 对话

    设计约束：
    1. sourceCsId 必须属于当前 token 对应的 OpenClaw 实例，避免伪造发送者。
    2. targetCsId 可以指向任意实例下的 Agent，支持跨 OpenClaw。
    3. 这里创建的 opening message 代表“source agent 已经说出的第一句话”，
       所以第一轮会直接发给 target agent，而不是再回送给 source 自己。
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = auth_header.removeprefix("Bearer ").strip()
    instance = db.scalar(select(OpenClawInstance).where(OpenClawInstance.callback_token == token))
    if not instance:
        raise HTTPException(status_code=401, detail="unknown callback token")

    if payload.kind.strip() != "agent_dialogue.start":
        raise HTTPException(status_code=400, detail="unsupported send-text kind")
    if payload.softMessageLimit >= payload.hardMessageLimit:
        raise HTTPException(status_code=400, detail="softMessageLimit must be less than hardMessageLimit")

    source_cs_id = payload.sourceCsId.strip().upper()
    target_cs_id = payload.targetCsId.strip().upper()

    source_agent = db.scalar(
        select(AgentProfile).where(
            AgentProfile.instance_id == instance.id,
            AgentProfile.cs_id == source_cs_id,
        )
    )
    if not source_agent:
        raise HTTPException(status_code=404, detail="source agent not found for current instance")
    if target_cs_id == DEFAULT_USER.cs_id:
        conversation = db.scalar(
            select(Conversation).where(
                Conversation.type == "direct",
                Conversation.direct_instance_id == instance.id,
                Conversation.direct_agent_id == source_agent.id,
            )
        )
        if conversation is None:
            conversation = Conversation(
                type="direct",
                title=f"{instance.name} / {source_agent.display_name}",
                direct_instance_id=instance.id,
                direct_agent_id=source_agent.id,
            )
            db.add(conversation)
            db.flush()

        # 发送给默认用户时，不需要再走 Agent 对话调度。
        # 当前系统只有一个默认用户，因此这里稳定落到“该 Agent 在当前实例下的 direct 对话”。
        opening_message = Message(
            id=f"msg_{uuid.uuid4().hex[:24]}",
            conversation_id=conversation.id,
            sender_type="agent",
            sender_label=source_agent.display_name,
            sender_cs_id=source_agent.cs_id,
            content=payload.message.strip(),
            status="completed",
        )
        db.add(opening_message)
        db.commit()
        await conversation_event_hub.publish_update(
            conversation.id,
            {
                "source": "send_text",
                "messageId": opening_message.id,
                "targetCsId": target_cs_id,
            },
        )
        return {
            "ok": True,
            "conversationId": conversation.id,
            "openingMessageId": opening_message.id,
        }

    target_agent = db.scalar(select(AgentProfile).where(AgentProfile.cs_id == target_cs_id))
    if not target_agent:
        raise HTTPException(status_code=404, detail="target agent not found")
    if source_agent.id == target_agent.id:
        raise HTTPException(status_code=400, detail="source and target agent must be different")

    ensure_agent_cs_id(source_agent)
    ensure_agent_cs_id(target_agent)

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
            initiator_type="agent",
            initiator_agent_id=source_agent.id,
            window_seconds=payload.windowSeconds,
            soft_message_limit=payload.softMessageLimit,
            hard_message_limit=payload.hardMessageLimit,
            soft_limit_warned_at=None,
            last_speaker_agent_id=source_agent.id,
        )
        db.add(dialogue)
        db.flush()
    else:
        conversation = db.get(Conversation, dialogue.conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="conversation not found for reusable agent dialogue")
        dialogue.source_agent_id = source_agent.id
        dialogue.target_agent_id = target_agent.id
        dialogue.topic = payload.topic.strip()
        dialogue.status = "active"
        dialogue.initiator_type = "agent"
        dialogue.initiator_agent_id = source_agent.id
        dialogue.window_seconds = payload.windowSeconds
        dialogue.soft_message_limit = payload.softMessageLimit
        dialogue.hard_message_limit = payload.hardMessageLimit
        dialogue.soft_limit_warned_at = None
        dialogue.last_speaker_agent_id = source_agent.id
        conversation.title = f"{source_agent.display_name} ↔ {target_agent.display_name}"

    # 这里必须为每次 send-text 生成唯一消息 ID。
    # 如果直接按消息内容做哈希，同样内容重复发送会命中同一个主键，导致 500。
    opening_message = Message(
        id=f"msg_{uuid.uuid4().hex[:24]}",
        conversation_id=conversation.id,
        sender_type="agent",
        sender_label=source_agent.display_name,
        sender_cs_id=source_agent.cs_id,
        content=payload.message.strip(),
        status="completed",
    )
    db.add(opening_message)
    db.flush()

    await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=opening_message,
        recipient_agent=target_agent,
        sender_label=source_agent.display_name,
        sender_user_id=f"agent:{source_agent.agent_key}",
        dispatch_mode="agent_dialogue_opening",
    )

    db.commit()
    return {
        "ok": True,
        "dialogueId": dialogue.id,
        "conversationId": conversation.id,
        "openingMessageId": opening_message.id,
    }


def _map_dispatch_status(event_type: str | None) -> str:
    # 这里把 channel 事件类型收敛成 scheduler-server 自己更稳定的状态枚举。
    mapping = {
        "run.accepted": "accepted",
        "reply.chunk": "streaming",
        "reply.final": "completed",
        "run.error": "failed",
    }
    return mapping.get(event_type or "", "pending")


def _parse_agent_key_from_session_key(session_key: str) -> str | None:
    """
    目前只支持 agent:<agentId>:... 这种 OpenClaw 原生单聊 session key。
    """
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
    """
    用 provider messageId 生成稳定消息 id，保证重复镜像时仍然只落一条消息。
    """
    digest = hashlib.sha1(
        f"{instance_id}|{agent_key}|{session_key}|{provider_message_id}|{sender_type}".encode("utf-8")
    ).hexdigest()
    return f"msg_web_{digest}"


def _pick_higher_status(current_status: str | None, next_status: str | None) -> str:
    # 这里定义一个简单的状态优先级，避免较晚到达的旧事件把状态回退。
    order = {
        "pending": 0,
        "accepted": 1,
        "streaming": 2,
        "completed": 3,
        "failed": 3,
    }
    current = current_status or "pending"
    target = next_status or current
    return target if order.get(target, 0) >= order.get(current, 0) else current


def _build_message_content(payload: dict[str, Any]) -> str:
    """
    优先使用 callback 里已经结构化好的 parts。

    当前数据库还没升级成真正的 JSON parts 存储，
    所以这里先把 parts 回写成一段可逆 content：
    1. markdown 直接保留文本
    2. attachment / tool_card 用约定标记回写

    这样消息接口层依然能把它重新拆成 parts，
    前端也就能先看到真实 callback 产生的富内容。
    """
    raw_parts = payload.get("parts")
    if not isinstance(raw_parts, list) or not raw_parts:
        return str(payload.get("text", ""))

    chunks: list[str] = []
    for raw_part in raw_parts:
        if not isinstance(raw_part, dict):
            continue

        kind = str(raw_part.get("kind", "")).strip()
        if kind == "markdown":
            content = str(raw_part.get("content", "")).strip()
            if content:
                chunks.append(content)
            continue

        if kind == "attachment":
            name = str(raw_part.get("name", "")).strip()
            mime_type = str(raw_part.get("mimeType") or raw_part.get("mime_type") or "").strip()
            url = str(raw_part.get("url", "")).strip()
            if name and url:
                chunks.append(f"[[attachment:{name}|{mime_type}|{url}]]")
            continue

        if kind == "tool_card":
            title = str(raw_part.get("title", "")).strip()
            status = _normalize_tool_status(str(raw_part.get("status", "")).strip())
            summary = str(raw_part.get("summary", "")).strip()
            if title and summary:
                chunks.append(f"[[tool:{title}|{status}|{summary}]]")

    if chunks:
        return "\n\n".join(chunks)

    return str(payload.get("text", ""))


def _normalize_tool_status(value: str) -> str:
    if value in {"pending", "running", "completed", "failed"}:
        return value
    return "pending"


def _normalize_mirror_sender_type(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"agent", "assistant"}:
        return "agent"
    return "user"


def _resolve_webchat_mirror_created_at(timestamp_ms: int | None) -> datetime | None:
    if timestamp_ms is None:
        return None
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
