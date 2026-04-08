"""会话路由，负责 direct、group 与消息历史接口。

读侧整形和写侧分发都放在专门的 service 里。
这里主要做参数校验，并把请求转交给对应 service。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.core.config import settings
from src.models.agent_profile import AgentProfile
from src.models.chat_group import ChatGroup
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.openclaw_instance import OpenClawInstance
from src.services.conversation_dispatch_service import dispatch_direct_message, dispatch_group_message
from src.services.conversation_events import conversation_event_hub
from src.services.conversation_query_service import list_conversation_items, load_conversation_messages_response
from src.services.default_user import get_default_user_identity
from src.services.local_agent_mock import simulate_local_agent_reply
from src.schemas.conversation import (
    build_message_read,
    ConversationListItem,
    ConversationMessagesResponse,
    ConversationRead,
    DirectConversationCreate,
    GroupConversationCreate,
    MessageCreate,
    MessageRead,
)

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

DEFAULT_USER = get_default_user_identity()


@router.get("", response_model=list[ConversationListItem])
def list_conversations(db: Session = Depends(db_session)) -> list[ConversationListItem]:
    return list_conversation_items(db)


@router.post("/direct", response_model=ConversationRead)
def create_or_get_direct_conversation(payload: DirectConversationCreate, db: Session = Depends(db_session)) -> Conversation:
    # direct 会话在同一个 instance / agent 组合下保持唯一。
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
    # 群聊只维护一条共享时间线。
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
    conversation = db.get(Conversation, conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="conversation not found")
    return load_conversation_messages_response(
        db=db,
        conversation=conversation,
        message_after=message_after,
        dispatch_after=dispatch_after,
        before_message_id=before_message_id,
        limit=limit,
        include_dispatches=include_dispatches,
    )


@router.post("/{conversation_id}/messages", response_model=MessageRead)
async def send_message(
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(db_session),
) -> MessageRead:
    # 先落库用户消息，后续 dispatch 和 callback 才能围绕同一个稳定消息 id 工作。
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

    dispatch_ids: list[str] = []
    if conversation.type == "direct":
        dispatch_ids = await dispatch_direct_message(db=db, conversation=conversation, message=message, payload=payload)
    else:
        dispatch_ids = await dispatch_group_message(db=db, conversation=conversation, message=message, mentions=payload.mentions)

    db.commit()

    if settings.local_agent_mock_enabled and dispatch_ids:
        # 本地 mock 模式下，在真实 dispatch 记录写完后补一条模拟回复，
        # 这样前端仍然能看到接近真实的消息流。
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
