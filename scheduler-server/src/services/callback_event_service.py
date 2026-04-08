from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.models.agent_dialogue import AgentDialogue
from src.models.agent_profile import AgentProfile
from src.models.message import Message
from src.models.message_callback_event import MessageCallbackEvent
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.services.agent_dialogue_runner import continue_agent_dialogue_after_reply
from src.services.conversation_events import conversation_event_hub

"""处理 ClawSwarm 回调事件的 service。"""


async def handle_callback_event(
    *,
    db: Session,
    instance: OpenClawInstance,
    event: dict[str, Any],
) -> dict[str, bool]:
    """把单条回调事件应用到 dispatch、message 和 dialogue 状态上。"""
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
        return {"ok": True}

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
            if message.sender_type == "user":
                message.status = _pick_higher_status(message.status, "accepted")

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


def _map_dispatch_status(event_type: str | None) -> str:
    """把 channel 事件类型折叠成调度中心内部的 dispatch 状态。"""
    mapping = {
        "run.accepted": "accepted",
        "reply.chunk": "streaming",
        "reply.final": "completed",
        "run.error": "failed",
    }
    return mapping.get(event_type or "", "pending")


def _pick_higher_status(current_status: str | None, next_status: str | None) -> str:
    """防止迟到事件把状态回退到更早阶段。"""
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
    """把回调里的 parts 渲染成当前文本消息存储格式。"""
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
    """Coerce unknown tool card states to a safe default."""
    if value in {"pending", "running", "completed", "failed"}:
        return value
    return "pending"
