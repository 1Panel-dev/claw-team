from __future__ import annotations

import uuid

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.core.config import settings
from src.integrations.channel_client import channel_client
from src.models.agent_profile import AgentProfile
from src.models.chat_group import ChatGroup
from src.models.chat_group_member import ChatGroupMember
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.conversation import MessageCreate
from src.services.default_user import get_default_user_identity

DEFAULT_USER = get_default_user_identity()

"""direct 与 group 消息分发的写侧辅助函数。"""


async def dispatch_direct_message(
    *,
    db: Session,
    conversation: Conversation,
    message: Message,
    payload: MessageCreate,
) -> list[str]:
    """为 direct 会话创建一条 dispatch 并调用 channel。"""
    instance = db.get(OpenClawInstance, conversation.direct_instance_id)
    agent = db.get(AgentProfile, conversation.direct_agent_id)
    if not instance or not agent:
        raise HTTPException(status_code=400, detail="invalid direct conversation target")

    dispatch = MessageDispatch(
        id=f"dsp_{uuid.uuid4().hex[:24]}",
        message_id=message.id,
        conversation_id=conversation.id,
        instance_id=instance.id,
        agent_id=agent.id,
        dispatch_mode="direct",
        channel_message_id=message.id,
        status="pending",
    )
    db.add(dispatch)
    db.flush()
    if settings.local_agent_mock_enabled:
        dispatch.status = "accepted"
        message.status = "accepted"
        return [dispatch.id]

    try:
        response = await channel_client.send_inbound(
            instance=instance,
            payload={
                "messageId": message.id,
                "accountId": instance.channel_account_id,
                "chat": {"type": "direct", "chatId": str(conversation.id)},
                "from": DEFAULT_USER.as_channel_sender(),
                "text": message.content,
                "directAgentId": agent.agent_key,
                "useDedicatedDirectSession": payload.use_dedicated_direct_session,
            },
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
        if 500 <= exc.response.status_code < 600:
            raise HTTPException(status_code=502, detail="OpenClaw instance failed to process the request") from exc
        raise HTTPException(status_code=502, detail="OpenClaw request failed") from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response") from exc
    dispatch.status = "accepted"
    dispatch.channel_trace_id = response.get("traceId")
    message.status = "accepted"
    return [dispatch.id]


async def dispatch_group_message(
    *,
    db: Session,
    conversation: Conversation,
    message: Message,
    mentions: list[str],
) -> list[str]:
    """Create per-agent dispatches for a group conversation."""
    if not conversation.group_id:
        raise HTTPException(status_code=400, detail="group conversation missing group id")
    group = db.get(ChatGroup, conversation.group_id)
    if not group:
        raise HTTPException(status_code=404, detail="group not found")

    members = list(db.scalars(select(ChatGroupMember).where(ChatGroupMember.group_id == group.id)))
    agents = {agent.id: agent for agent in db.scalars(select(AgentProfile).where(AgentProfile.id.in_([m.agent_id for m in members])))}
    by_instance: dict[int, list[AgentProfile]] = {}

    if mentions:
        wanted = {token.strip().lower() for token in mentions if token.strip()}
        filtered = []
        for member in members:
            agent = agents.get(member.agent_id)
            if not agent:
                continue
            tokens = {
                agent.agent_key.lower(),
                agent.display_name.lower(),
                f"{member.instance_id}:{member.agent_id}",
            }
            if tokens & wanted:
                filtered.append((member.instance_id, agent))
    else:
        filtered = [(member.instance_id, agents[member.agent_id]) for member in members if member.agent_id in agents]

    if not filtered:
        raise HTTPException(status_code=400, detail="no group members matched current message")

    for instance_id, agent in filtered:
        by_instance.setdefault(instance_id, []).append(agent)

    created_dispatch_ids: list[str] = []

    for instance_id, instance_agents in by_instance.items():
        instance = db.get(OpenClawInstance, instance_id)
        if not instance:
            continue
        agent_keys = []
        for agent in instance_agents:
            dispatch = MessageDispatch(
                id=f"dsp_{uuid.uuid4().hex[:24]}",
                message_id=message.id,
                conversation_id=conversation.id,
                instance_id=instance_id,
                agent_id=agent.id,
                dispatch_mode="group_mention" if mentions else "group_broadcast",
                channel_message_id=message.id,
                status="pending",
            )
            db.add(dispatch)
            agent_keys.append(agent.agent_key)
            created_dispatch_ids.append(dispatch.id)
        db.flush()

        if settings.local_agent_mock_enabled:
            message.status = "accepted"
            for agent in instance_agents:
                dispatch = db.scalar(
                    select(MessageDispatch).where(
                        MessageDispatch.message_id == message.id,
                        MessageDispatch.conversation_id == conversation.id,
                        MessageDispatch.instance_id == instance_id,
                        MessageDispatch.agent_id == agent.id,
                    )
                )
                if dispatch:
                    dispatch.status = "accepted"
            continue

        group_member_lines = []
        for member_agent in instance_agents:
            role_label = member_agent.role_name or "未设置角色"
            cs_label = member_agent.cs_id or "NO-CS-ID"
            group_member_lines.append(f"- {member_agent.display_name} ({role_label}, {cs_label})")
        group_members_text = "\n".join(group_member_lines)

        for agent in instance_agents:
            role_label = agent.role_name or "未设置角色"
            cs_label = agent.cs_id or "NO-CS-ID"
            mention_line = "Mentioned targets: you" if mentions else "Mentioned targets: none"
            contextual_text = "\n".join(
                [
                    "[ClawSwarm Group Context]",
                    f"Group: {group.name}",
                    f"Your identity: {agent.display_name} ({role_label}, {cs_label})",
                    "Group members:",
                    group_members_text,
                    f"Current speaker: {DEFAULT_USER.label_with_cs_id}",
                    mention_line,
                    "Instruction:",
                    "- If the current discussion is not in your responsibility scope, stay silent.",
                    "- If it is relevant to your role, reply briefly and stay on topic.",
                    "",
                    message.content,
                ]
            )

            inbound_payload = {
                "messageId": message.id,
                "accountId": instance.channel_account_id,
                "chat": {"type": "group", "chatId": f"group-conv-{conversation.id}", "groupId": str(group.id)},
                "from": DEFAULT_USER.as_channel_sender(),
                "text": contextual_text,
                "targetAgentIds": [agent.agent_key],
            }
            if mentions:
                inbound_payload["mentions"] = [agent.agent_key]

            try:
                response = await channel_client.send_inbound(instance=instance, payload=inbound_payload)
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
                if 500 <= exc.response.status_code < 600:
                    raise HTTPException(status_code=502, detail="OpenClaw instance failed to process the request") from exc
                raise HTTPException(status_code=502, detail="OpenClaw request failed") from exc
            except ValueError as exc:
                raise HTTPException(status_code=502, detail="OpenClaw returned an invalid response") from exc
            dispatch = db.scalar(
                select(MessageDispatch).where(
                    MessageDispatch.message_id == message.id,
                    MessageDispatch.instance_id == instance_id,
                    MessageDispatch.agent_id == agent.id,
                )
            )
            if dispatch:
                dispatch.status = "accepted"
                dispatch.channel_trace_id = response.get("traceId")
        message.status = "accepted"
    return created_dispatch_ids
