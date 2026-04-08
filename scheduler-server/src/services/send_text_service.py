from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.models.agent_dialogue import AgentDialogue
from src.models.agent_profile import AgentProfile
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.openclaw_instance import OpenClawInstance
from src.services.agent_cs_id import ensure_agent_cs_id
from src.services.agent_dialogue_lookup import find_reusable_agent_dialogue
from src.services.agent_dialogue_runner import dispatch_agent_dialogue_turn
from src.services.conversation_events import conversation_event_hub
from src.services.default_user import get_default_user_identity

DEFAULT_USER = get_default_user_identity()

"""`/api/v1/clawswarm/send-text` 端点背后的 service 实现。"""


async def handle_send_text(
    *,
    db: Session,
    instance: OpenClawInstance,
    payload: Any,
) -> dict[str, Any]:
    """处理由 channel 侧 send-text 触发的对话启动或复用。"""
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
