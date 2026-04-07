"""
这个文件负责第一阶段的会话与消息 API。

主要职责：
1. 创建单聊会话和群聊会话。
2. 查询某个会话下的消息与 dispatch 状态。
3. 接收用户发送的新消息，并把它分发到对应的 clawswarm channel。

调用流程：
1. 前端先创建或获取一个 conversation。
2. 前端向 /api/conversations/{conversation_id}/messages 发送消息。
3. 这里先把用户消息落库，再按 direct / group 分支创建 dispatch。
4. 然后调用 channel 插件的 /clawswarm/v1/inbound。
5. 后续 agent 回复会由 callbacks.py 接收并回写数据库。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.core.config import settings
from src.integrations.channel_client import channel_client
from src.models.agent_dialogue import AgentDialogue
from src.models.agent_profile import AgentProfile
from src.models.chat_group import ChatGroup
from src.models.chat_group_member import ChatGroupMember
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.services.agent_dialogue_lookup import build_agent_dialogue_pair_key
from src.services.conversation_events import conversation_event_hub
from src.services.default_user import display_sender_label
from src.services.default_user import get_default_user_identity
from src.services.local_agent_mock import simulate_local_agent_reply
from src.schemas.common import validate_orm
from src.schemas.conversation import (
    build_message_read,
    ConversationListItem,
    ConversationMessagesResponse,
    ConversationRead,
    DirectConversationCreate,
    DispatchRead,
    GroupConversationCreate,
    MessageCreate,
    MessageRead,
)

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

STALE_DISPATCH_TIMEOUT = timedelta(seconds=90)
DEFAULT_USER = get_default_user_identity()


@router.get("", response_model=list[ConversationListItem])
def list_conversations(db: Session = Depends(db_session)) -> list[ConversationListItem]:
    # 这个接口给前端左侧“最近会话列表”使用。
    # 第一阶段先用简单可读的方式拼装数据，优先保证前端可直接消费。
    conversations = list(db.scalars(select(Conversation).order_by(Conversation.updated_at.desc(), Conversation.id.desc())))

    items: list[tuple[ConversationListItem, tuple[int, int] | None]] = []
    for conversation in conversations:
        last_message = db.scalar(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at.desc(), Message.id.desc())
        )
        dialogue = db.scalar(select(AgentDialogue).where(AgentDialogue.conversation_id == conversation.id))
        group = db.get(ChatGroup, conversation.group_id) if conversation.group_id else None
        instance = db.get(OpenClawInstance, conversation.direct_instance_id) if conversation.direct_instance_id else None
        agent = db.get(AgentProfile, conversation.direct_agent_id) if conversation.direct_agent_id else None
        source_agent = db.get(AgentProfile, dialogue.source_agent_id) if dialogue else None
        target_agent = db.get(AgentProfile, dialogue.target_agent_id) if dialogue else None

        if conversation.type == "direct" and instance and instance.status == "disabled":
            continue

        if conversation.type == "group":
            display_title = conversation.title or (group.name if group else f"群聊 {conversation.id}")
        elif conversation.type == "agent_dialogue":
            if source_agent and target_agent:
                source_instance = db.get(OpenClawInstance, source_agent.instance_id)
                target_instance = db.get(OpenClawInstance, target_agent.instance_id)
                source_label = (
                    f"{source_agent.display_name} / {source_instance.name}"
                    if source_instance else source_agent.display_name
                )
                target_label = (
                    f"{target_agent.display_name} / {target_instance.name}"
                    if target_instance else target_agent.display_name
                )
                display_title = f"{source_label} ↔ {target_label}"
            else:
                display_title = conversation.title or f"Agent 对话 {conversation.id}"
        else:
            if instance and agent:
                display_title = f"{instance.name} / {agent.display_name}"
            else:
                display_title = conversation.title or f"单聊 {conversation.id}"

        preview = None
        if last_message:
            # 侧栏只需要一个短摘要，避免把整条长文本直接塞进去。
            preview = last_message.content.strip().replace("\n", " ")
            if len(preview) > 80:
                preview = f"{preview[:80]}..."

        pair_key = (
            build_agent_dialogue_pair_key(source_agent.id, target_agent.id)
            if conversation.type == "agent_dialogue" and source_agent and target_agent
            else None
        )

        items.append(
            (
                ConversationListItem(
                id=conversation.id,
                type=conversation.type,
                title=conversation.title,
                group_id=conversation.group_id,
                direct_instance_id=conversation.direct_instance_id,
                direct_agent_id=conversation.direct_agent_id,
                created_at=conversation.created_at,
                updated_at=conversation.updated_at,
                display_title=display_title,
                group_name=group.name if group else None,
                instance_name=instance.name if instance else None,
                agent_display_name=agent.display_name if agent else None,
                dialogue_source_agent_name=source_agent.display_name if source_agent else None,
                dialogue_target_agent_name=target_agent.display_name if target_agent else None,
                dialogue_status=dialogue.status if dialogue else None,
                dialogue_window_seconds=dialogue.window_seconds if dialogue else None,
                dialogue_soft_message_limit=dialogue.soft_message_limit if dialogue else None,
                dialogue_hard_message_limit=dialogue.hard_message_limit if dialogue else None,
                last_message_id=last_message.id if last_message else None,
                last_message_preview=preview,
                last_message_sender_type=last_message.sender_type if last_message else None,
                last_message_sender_label=(
                    display_sender_label(
                        sender_type=last_message.sender_type,
                        sender_label=last_message.sender_label,
                    )
                    if last_message else None
                ),
                last_message_at=last_message.created_at.isoformat() if last_message else None,
                last_message_status=last_message.status if last_message else None,
                ),
                pair_key,
            )
        )

    # 这里按最后一条消息时间优先排序；如果还没有消息，就回退到会话自身创建时间。
    items.sort(key=lambda item: item[0].last_message_at or item[0].created_at.isoformat(), reverse=True)

    deduped_items: list[ConversationListItem] = []
    seen_agent_dialogue_pairs: set[tuple[int, int]] = set()
    for item, pair_key in items:
        if pair_key is not None:
            if pair_key in seen_agent_dialogue_pairs:
                continue
            seen_agent_dialogue_pairs.add(pair_key)
        deduped_items.append(item)
    return deduped_items


@router.post("/direct", response_model=ConversationRead)
def create_or_get_direct_conversation(payload: DirectConversationCreate, db: Session = Depends(db_session)) -> Conversation:
    # 单聊会话的唯一键是 instance_id + agent_id，所以这里是“查到就复用，查不到再创建”。
    instance = db.get(OpenClawInstance, payload.instance_id)
    agent = db.get(AgentProfile, payload.agent_id)
    if not instance or not agent:
        raise HTTPException(status_code=404, detail="instance or agent not found")
    existing = db.scalar(
        select(Conversation).where(
            Conversation.type == "direct",
            Conversation.direct_instance_id == payload.instance_id,
            Conversation.direct_agent_id == payload.agent_id,
        )
    )
    if existing:
        return existing
    item = Conversation(
        type="direct",
        title=f"{instance.name} / {agent.display_name}",
        direct_instance_id=payload.instance_id,
        direct_agent_id=payload.agent_id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.post("/group", response_model=ConversationRead)
def create_or_get_group_conversation(payload: GroupConversationCreate, db: Session = Depends(db_session)) -> Conversation:
    # 群聊会话的唯一键是 group_id，一般一个群只维护一个会话视图。
    group = db.get(ChatGroup, payload.group_id)
    if not group:
        raise HTTPException(status_code=404, detail="group not found")
    existing = db.scalar(
        select(Conversation).where(Conversation.type == "group", Conversation.group_id == payload.group_id)
    )
    if existing:
        return existing
    item = Conversation(type="group", title=group.name, group_id=payload.group_id)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/{conversation_id}/messages", response_model=ConversationMessagesResponse)
def list_conversation_messages(
    conversation_id: int,
    message_after: str | None = Query(default=None, alias="messageAfter"),
    dispatch_after: str | None = Query(default=None, alias="dispatchAfter"),
    before_message_id: str | None = Query(default=None, alias="beforeMessageId"),
    limit: int = Query(default=100, ge=1, le=200),
    include_dispatches: bool = Query(default=True, alias="includeDispatches"),
    db: Session = Depends(db_session),
) -> ConversationMessagesResponse:
    # 第一阶段先提供“最小增量拉取”：
    # 1. 首次进入会话时不带 cursor，返回全部消息与 dispatch。
    # 2. 后续轮询时带上上次看到的最后一个 message / dispatch id，只拉新增部分。
    conversation = db.get(Conversation, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="conversation not found")
    dialogue = db.scalar(select(AgentDialogue).where(AgentDialogue.conversation_id == conversation_id))

    _finalize_stale_dispatches(db=db, conversation_id=conversation_id)

    # 当前消息接口同时承担三种读取模式：
    # 1. 初次进入会话：拿最近一页消息。
    # 2. 往上翻历史：按 beforeMessageId 继续拿更早一页。
    # 3. 轮询最新变化：messageAfter 保留给后续更精细的增量模式；当前前端会直接重新拉最近一页。
    messages, has_more_messages = _load_conversation_messages(
        db=db,
        conversation_id=conversation_id,
        before_message_id=before_message_id,
        limit=limit,
    )
    dispatches = (
        list(
            db.scalars(
                select(MessageDispatch)
                .where(MessageDispatch.conversation_id == conversation_id)
                .order_by(MessageDispatch.created_at, MessageDispatch.id)
            )
        )
        if include_dispatches
        else []
    )
    sender_cs_id_map = _build_sender_cs_id_map(db=db, conversation=conversation, dialogue=dialogue)
    return ConversationMessagesResponse(
        conversation=ConversationRead(
            id=conversation.id,
            type=conversation.type,
            title=conversation.title,
            group_id=conversation.group_id,
            direct_instance_id=conversation.direct_instance_id,
            direct_agent_id=conversation.direct_agent_id,
            agent_dialogue_id=dialogue.id if dialogue else None,
            created_at=conversation.created_at,
            updated_at=conversation.updated_at,
        ),
        messages=[
            build_message_read(
                item,
                sender_cs_id=item.sender_cs_id or sender_cs_id_map.get((item.sender_label or "").strip()),
            )
            for item in messages
        ],
        dispatches=[validate_orm(DispatchRead, item) for item in dispatches],
        next_message_cursor=messages[-1].id if messages else message_after,
        next_dispatch_cursor=dispatches[-1].id if dispatches else dispatch_after,
        has_more_messages=has_more_messages,
        oldest_loaded_message_id=messages[0].id if messages else before_message_id,
    )


def _build_sender_cs_id_map(
    *,
    db: Session,
    conversation: Conversation,
    dialogue: AgentDialogue | None,
) -> dict[str, str]:
    mapping: dict[str, str] = {}

    if conversation.type == "agent_dialogue" and dialogue:
        source_agent = db.get(AgentProfile, dialogue.source_agent_id)
        target_agent = db.get(AgentProfile, dialogue.target_agent_id)
        if source_agent and source_agent.cs_id and source_agent.display_name.strip():
            mapping[source_agent.display_name.strip()] = source_agent.cs_id
        if target_agent and target_agent.cs_id and target_agent.display_name.strip():
            mapping[target_agent.display_name.strip()] = target_agent.cs_id
        return mapping

    if conversation.type == "group" and conversation.group_id:
        members = list(
            db.scalars(select(ChatGroupMember).where(ChatGroupMember.group_id == conversation.group_id))
        )
        for member in members:
            agent = db.get(AgentProfile, member.agent_id)
            if not agent or not agent.cs_id:
                continue
            label = (agent.display_name or "").strip()
            if label and label not in mapping:
                mapping[label] = agent.cs_id
        return mapping

    if conversation.type == "direct" and conversation.direct_agent_id:
        agent = db.get(AgentProfile, conversation.direct_agent_id)
        if agent and agent.cs_id and agent.display_name.strip():
            mapping[agent.display_name.strip()] = agent.cs_id

    return mapping


def _load_conversation_messages(
    *,
    db: Session,
    conversation_id: int,
    before_message_id: str | None,
    limit: int,
) -> tuple[list[Message], bool]:
    if before_message_id:
        anchor = db.get(Message, before_message_id)
        if not anchor or anchor.conversation_id != conversation_id:
            raise HTTPException(status_code=404, detail="before message not found")
        query = (
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                or_(
                    Message.created_at < anchor.created_at,
                    and_(Message.created_at == anchor.created_at, Message.id < anchor.id),
                ),
            )
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(limit + 1)
        )
    else:
        query = (
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(limit + 1)
        )

    rows = list(db.scalars(query))
    has_more_messages = len(rows) > limit
    if has_more_messages:
        rows = rows[:limit]
    rows.reverse()
    return rows, has_more_messages


def _finalize_stale_dispatches(db: Session, conversation_id: int) -> None:
    """
    OpenClaw 重启或连接中断时，可能遗留一直停在 accepted/streaming 的 dispatch。

    前端只要看到会话里仍有 streaming/accepted，就会持续显示“正在回复...”，
    所以这里在读取消息时顺手做一次保守收尾：
    1. 超过超时时间仍未收到新 callback 的 dispatch 标记为 failed
    2. 关联的用户消息和流式 agent 消息也一起收成 failed

    这样至少不会让会话永远挂在回复中。
    """
    threshold = datetime.now(timezone.utc).replace(tzinfo=None) - STALE_DISPATCH_TIMEOUT
    stale_dispatches = list(
        db.scalars(
            select(MessageDispatch).where(
                MessageDispatch.conversation_id == conversation_id,
                MessageDispatch.status.in_(("accepted", "streaming")),
                MessageDispatch.updated_at < threshold,
            )
        )
    )
    if not stale_dispatches:
        return

    for dispatch in stale_dispatches:
        dispatch.status = "failed"
        if not dispatch.error_message:
            dispatch.error_message = "dispatch timed out while waiting for channel completion"

        user_message = db.get(Message, dispatch.message_id)
        if user_message and user_message.status in {"accepted", "streaming"}:
            user_message.status = "failed"

        agent_message = db.get(Message, f"msg_agent_{dispatch.id}")
        if agent_message and agent_message.status == "streaming":
            agent_message.status = "failed"

    db.commit()


@router.post("/{conversation_id}/messages", response_model=MessageRead)
async def send_message(
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(db_session),
) -> MessageRead:
    # 用户发消息时，先落一条“用户消息”，后续 dispatch 和 callback 都围绕这条 message.id 关联。
    conversation = db.get(Conversation, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="conversation not found")

    message = Message(
        id=f"msg_{uuid.uuid4().hex[:24]}",
        conversation_id=conversation_id,
        sender_type="user",
        sender_label=DEFAULT_USER.sender_label,
        sender_cs_id=DEFAULT_USER.cs_id,
        content=payload.content,
        status="pending",
    )
    db.add(message)
    db.commit()
    db.refresh(message)

    # direct 只发给一个 agent；group 会先按 instance 分组，再分别调用对应 channel。
    dispatch_ids: list[str] = []
    if conversation.type == "direct":
        dispatch_ids = await _dispatch_direct(db=db, conversation=conversation, message=message, payload=payload)
    else:
        dispatch_ids = await _dispatch_group(db=db, conversation=conversation, message=message, mentions=payload.mentions)

    db.commit()

    if settings.local_agent_mock_enabled and dispatch_ids:
        # 本地联调模式下，先把用户消息和 dispatch 落库，
        # 再同步生成模拟 Agent 回复。
        # 这样前端马上就能通过真实后端接口拿到完整消息流，不受后台任务时机影响。
        simulate_local_agent_reply(
            db=db,
            conversation_id=conversation.id,
            message_id=message.id,
            dispatch_ids=dispatch_ids,
        )

    db.refresh(message)
    await conversation_event_hub.publish_update(
        conversation.id,
        {
            "source": "send_message",
            "messageId": message.id,
        },
    )
    return build_message_read(message)


async def _dispatch_direct(*, db: Session, conversation: Conversation, message: Message, payload: MessageCreate) -> list[str]:
    # 单聊场景下，conversation 上直接挂了目标 instance 和 agent。
    instance = db.get(OpenClawInstance, conversation.direct_instance_id)
    agent = db.get(AgentProfile, conversation.direct_agent_id)
    if not instance or not agent:
        raise HTTPException(status_code=400, detail="invalid direct conversation target")
    # dispatch 是“这条消息投递给某个 agent 的一次执行记录”，后续 callback 也靠它回填状态。
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
    # 这里组装的是发给 clawswarm channel 的统一入站 payload，
    # 它的字段形状必须和 channel 插件侧 routes.py 约定保持一致。
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


async def _dispatch_group(*, db: Session, conversation: Conversation, message: Message, mentions: list[str]) -> list[str]:
    if not conversation.group_id:
        raise HTTPException(status_code=400, detail="group conversation missing group id")
    group = db.get(ChatGroup, conversation.group_id)
    if not group:
        raise HTTPException(status_code=404, detail="group not found")

    members = list(db.scalars(select(ChatGroupMember).where(ChatGroupMember.group_id == group.id)))
    agents = {agent.id: agent for agent in db.scalars(select(AgentProfile).where(AgentProfile.id.in_([m.agent_id for m in members])))}
    by_instance: dict[int, list[AgentProfile]] = {}

    # 如果有 mentions，只保留被 @ 到的 agent。
    # 新前端优先传 "instance_id:agent_id" 这种唯一值；
    # 同时继续兼容旧版本基于 agent_key / display_name 的宽松匹配。
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

    # 群成员可能分布在多个 OpenClaw 实例上，所以这里必须先按 instance 分组，
    # 然后分别调用各自实例上的 channel。
    for instance_id, instance_agents in by_instance.items():
        instance = db.get(OpenClawInstance, instance_id)
        if not instance:
            continue
        agent_keys = []
        for agent in instance_agents:
            # 同一条群消息会对应多条 dispatch，每个目标 agent 一条。
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
            ct_label = member_agent.cs_id or "NO-CS-ID"
            group_member_lines.append(f"- {member_agent.display_name} ({role_label}, {ct_label})")
        group_members_text = "\n".join(group_member_lines)

        for agent in instance_agents:
            role_label = agent.role_name or "未设置角色"
            ct_label = agent.cs_id or "NO-CS-ID"
            mention_line = "Mentioned targets: you" if mentions else "Mentioned targets: none"
            contextual_text = "\n".join(
                [
                    "[ClawSwarm Group Context]",
                    f"Group: {group.name}",
                    f"Your identity: {agent.display_name} ({role_label}, {ct_label})",
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
