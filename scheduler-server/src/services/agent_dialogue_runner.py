"""Agent dialogue 工作流的编排辅助函数。"""
from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy.orm import Session

from src.integrations.channel_client import channel_client
from src.models.agent_dialogue import AgentDialogue
from src.models.agent_profile import AgentProfile
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.services.agent_dialogue_context_builder import build_agent_dialogue_context_text
from src.services.agent_dialogue_state_service import (
    apply_dialogue_window_guards,
    find_latest_undispatched_message,
    has_in_flight_dispatch,
    next_agent_id_for_dialogue,
    pick_next_agent_id,
)
from src.services.default_user import get_default_user_identity

AGENT_DIALOGUE_CHANNEL_PREFIX = "agent-dialogue"
DEFAULT_USER = get_default_user_identity()


async def dispatch_agent_dialogue_opening_turn(*, db: Session, dialogue: AgentDialogue, opening_message: Message) -> str | None:
    """Send the first turn of a dialogue to its source agent."""
    source_agent = db.get(AgentProfile, dialogue.source_agent_id)
    if not source_agent:
        raise HTTPException(status_code=404, detail="source agent not found")
    conversation = db.get(Conversation, dialogue.conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="conversation not found")

    return await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=opening_message,
        recipient_agent=source_agent,
        sender_label=DEFAULT_USER.label_with_cs_id,
        sender_user_id=DEFAULT_USER.internal_id,
        dispatch_mode="agent_dialogue_opening",
    )


async def continue_agent_dialogue_after_reply(
    *,
    db: Session,
    dialogue: AgentDialogue,
    dispatch: MessageDispatch,
    reply_message: Message,
) -> str | None:
    """Relay a completed reply to the next participant when the dialogue stays active."""
    if dialogue.status == "stopped":
        return None

    current_speaker = db.get(AgentProfile, dispatch.agent_id)
    if not current_speaker:
        dialogue.status = "stopped"
        db.commit()
        return None

    dialogue.last_speaker_agent_id = current_speaker.id

    # Keep the latest speaker even while paused so a later resume can continue
    # from the correct side.
    if dialogue.status != "active":
        db.commit()
        return None

    # Human interventions take priority over continuing the normal relay once
    # the current turn finishes.
    pending_user_message = find_latest_undispatched_message(db=db, dialogue=dialogue, sender_type="user")
    if pending_user_message:
        conversation = db.get(Conversation, dialogue.conversation_id)
        next_agent_id = pick_next_agent_id(dialogue, current_speaker.id)
        next_agent = db.get(AgentProfile, next_agent_id) if next_agent_id else None
        if next_agent and conversation:
            return await dispatch_agent_dialogue_turn(
                db=db,
                dialogue=dialogue,
                conversation=conversation,
                message=pending_user_message,
                recipient_agent=next_agent,
                sender_label=DEFAULT_USER.label_with_cs_id,
                sender_user_id=DEFAULT_USER.internal_id,
                dispatch_mode="agent_dialogue_intervention",
            )

    next_agent_id = pick_next_agent_id(dialogue, current_speaker.id)
    if next_agent_id is None:
        dialogue.status = "stopped"
        db.commit()
        return None

    next_agent = db.get(AgentProfile, next_agent_id)
    conversation = db.get(Conversation, dialogue.conversation_id)
    if not next_agent or not conversation:
        dialogue.status = "stopped"
        db.commit()
        return None

    return await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=reply_message,
        recipient_agent=next_agent,
        sender_label=current_speaker.display_name,
        sender_user_id=f"agent:{current_speaker.agent_key}",
        dispatch_mode="agent_dialogue_relay",
    )


async def dispatch_agent_dialogue_turn(
    *,
    db: Session,
    dialogue: AgentDialogue,
    conversation: Conversation,
    message: Message,
    recipient_agent: AgentProfile,
    sender_label: str,
    sender_user_id: str,
    dispatch_mode: str,
) -> str | None:
    """Dispatch an existing dialogue message to one target agent."""
    guard_result = apply_dialogue_window_guards(db=db, dialogue=dialogue, conversation=conversation)
    if guard_result == "stopped":
        db.commit()
        return None

    instance = db.get(OpenClawInstance, recipient_agent.instance_id)
    if not instance:
        dialogue.status = "stopped"
        db.commit()
        return None

    dispatch = MessageDispatch(
        id=f"dsp_{uuid.uuid4().hex[:24]}",
        message_id=message.id,
        conversation_id=conversation.id,
        instance_id=instance.id,
        agent_id=recipient_agent.id,
        dispatch_mode=dispatch_mode,
        channel_message_id=message.id,
        status="pending",
    )
    db.add(dispatch)
    db.flush()

    packaged_text = build_agent_dialogue_context_text(
        db=db,
        dialogue=dialogue,
        recipient_agent=recipient_agent,
        message=message,
        sender_label=sender_label,
    )

    response = await channel_client.send_inbound(
        instance=instance,
        payload={
            "messageId": message.id,
            "accountId": instance.channel_account_id,
            "chat": {"type": "direct", "chatId": f"{AGENT_DIALOGUE_CHANNEL_PREFIX}-{conversation.id}"},
            "from": {"userId": sender_user_id, "displayName": sender_label},
            "text": packaged_text,
            "directAgentId": recipient_agent.agent_key,
        },
    )

    dispatch.status = "accepted"
    dispatch.channel_trace_id = response.get("traceId")
    db.commit()
    return dispatch.id

async def dispatch_agent_dialogue_intervention(
    *,
    db: Session,
    dialogue: AgentDialogue,
    message: Message,
) -> str | None:
    """Forward one human intervention message if the dialogue is ready."""
    if dialogue.status != "active" or has_in_flight_dispatch(db, dialogue):
        return None

    next_agent_id = next_agent_id_for_dialogue(dialogue)
    if next_agent_id is None:
        return None

    recipient_agent = db.get(AgentProfile, next_agent_id)
    conversation = db.get(Conversation, dialogue.conversation_id)
    if not recipient_agent or not conversation:
        return None

    return await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=message,
        recipient_agent=recipient_agent,
        sender_label=DEFAULT_USER.label_with_cs_id,
        sender_user_id=DEFAULT_USER.internal_id,
        dispatch_mode="agent_dialogue_intervention",
    )


async def resume_agent_dialogue_if_possible(*, db: Session, dialogue: AgentDialogue) -> str | None:
    """Resume a paused dialogue by dispatching the newest pending message."""
    if dialogue.status != "active" or has_in_flight_dispatch(db, dialogue):
        return None

    pending_user_message = find_latest_undispatched_message(db=db, dialogue=dialogue, sender_type="user")
    if pending_user_message:
        return await dispatch_agent_dialogue_intervention(db=db, dialogue=dialogue, message=pending_user_message)

    pending_agent_message = find_latest_undispatched_message(db=db, dialogue=dialogue, sender_type="agent")
    if not pending_agent_message:
        return None

    next_agent_id = next_agent_id_for_dialogue(dialogue)
    sender_agent = db.get(AgentProfile, dialogue.last_speaker_agent_id) if dialogue.last_speaker_agent_id else None
    recipient_agent = db.get(AgentProfile, next_agent_id) if next_agent_id else None
    conversation = db.get(Conversation, dialogue.conversation_id)
    if not recipient_agent or not conversation or not sender_agent:
        return None

    return await dispatch_agent_dialogue_turn(
        db=db,
        dialogue=dialogue,
        conversation=conversation,
        message=pending_agent_message,
        recipient_agent=recipient_agent,
        sender_label=pending_agent_message.sender_label,
        sender_user_id=f"agent:{sender_agent.agent_key}",
        dispatch_mode="agent_dialogue_relay",
    )
