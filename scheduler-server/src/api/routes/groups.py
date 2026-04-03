"""
这个文件负责群组与群成员管理。

第一阶段里，群组是调度中心维护的核心业务对象：
1. 前端从这里创建群。
2. 从这里给群添加或删除 agent 成员。
3. 群聊发消息时，conversations.py 会读取这里维护的成员列表。
"""
from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.models.agent_profile import AgentProfile
from src.models.chat_group import ChatGroup
from src.models.chat_group_member import ChatGroupMember
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_callback_event import MessageCallbackEvent
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.group import GroupCreate, GroupDetail, GroupMemberAddRequest, GroupMemberRead, GroupRead

router = APIRouter(prefix="/api/groups", tags=["groups"])


@router.get("", response_model=list[GroupRead])
def list_groups(db: Session = Depends(db_session)) -> list[ChatGroup]:
    return list(db.scalars(select(ChatGroup).order_by(ChatGroup.id)))


@router.post("", response_model=GroupRead)
def create_group(payload: GroupCreate, db: Session = Depends(db_session)) -> ChatGroup:
    # 群和初始成员在一个事务里创建，避免出现“群已创建但成员写入失败”的不一致状态。
    item = ChatGroup(name=payload.name, description=payload.description)
    db.add(item)
    db.flush()

    seen_pairs: set[tuple[int, int]] = set()
    for member in payload.members:
        instance = db.get(OpenClawInstance, member.instance_id)
        agent = db.get(AgentProfile, member.agent_id)
        if not instance:
            raise HTTPException(status_code=404, detail="instance not found")
        if not agent:
            raise HTTPException(status_code=404, detail="agent not found")

        pair = (member.instance_id, member.agent_id)
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)

        db.add(ChatGroupMember(group_id=item.id, instance_id=member.instance_id, agent_id=member.agent_id))

    db.commit()
    db.refresh(item)
    return item


def _delete_group_and_related_records(group_id: int, db: Session) -> None:
    group = db.get(ChatGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="group not found")

    conversation_ids = list(db.scalars(select(Conversation.id).where(Conversation.group_id == group_id)))
    if conversation_ids:
        dispatch_ids = list(
            db.scalars(
                select(MessageDispatch.id).where(MessageDispatch.conversation_id.in_(conversation_ids))
            )
        )
        if dispatch_ids:
            db.execute(delete(MessageCallbackEvent).where(MessageCallbackEvent.dispatch_id.in_(dispatch_ids)))

        db.execute(delete(MessageDispatch).where(MessageDispatch.conversation_id.in_(conversation_ids)))
        db.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
        db.execute(delete(Conversation).where(Conversation.id.in_(conversation_ids)))

    db.execute(delete(ChatGroupMember).where(ChatGroupMember.group_id == group_id))
    db.execute(delete(ChatGroup).where(ChatGroup.id == group_id))
    db.commit()


@router.delete("/{group_id}", status_code=204)
def delete_group(group_id: int, db: Session = Depends(db_session)) -> None:
    _delete_group_and_related_records(group_id, db)


@router.post("/{group_id}/delete", status_code=204)
def delete_group_via_post(group_id: int, db: Session = Depends(db_session)) -> None:
    # 某些部署环境里对 DELETE 动词处理不稳定，这里补一个显式动作路由，
    # 前端统一走 POST，避免浏览器/代理差异导致 405。
    _delete_group_and_related_records(group_id, db)


@router.get("/{group_id}", response_model=GroupDetail)
def get_group(group_id: int, db: Session = Depends(db_session)) -> GroupDetail:
    group = db.get(ChatGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="group not found")
    members = _load_group_members(db, group_id)
    return GroupDetail(id=group.id, name=group.name, description=group.description, members=members)


@router.post("/{group_id}/members", response_model=list[GroupMemberRead])
def add_group_members(group_id: int, payload: GroupMemberAddRequest, db: Session = Depends(db_session)) -> list[GroupMemberRead]:
    group = db.get(ChatGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="group not found")

    for item in payload.members:
        # 群成员是“实例 + agent”二元组，所以这里要同时校验 instance 和 agent 都存在。
        instance = db.get(OpenClawInstance, item.instance_id)
        agent = db.get(AgentProfile, item.agent_id)
        if not instance:
            raise HTTPException(status_code=404, detail="instance not found")
        if not agent:
            raise HTTPException(status_code=404, detail="agent not found")
        exists = db.scalar(
            select(ChatGroupMember).where(
                ChatGroupMember.group_id == group_id,
                ChatGroupMember.agent_id == item.agent_id,
            )
        )
        if not exists:
            db.add(ChatGroupMember(group_id=group_id, instance_id=item.instance_id, agent_id=item.agent_id))

    db.commit()
    return _load_group_members(db, group_id)


@router.delete("/{group_id}/members/{member_id}", response_model=GroupDetail)
def delete_group_member(group_id: int, member_id: int, db: Session = Depends(db_session)) -> GroupDetail:
    group = db.get(ChatGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="group not found")
    member = db.get(ChatGroupMember, member_id)
    if not member or member.group_id != group_id:
        raise HTTPException(status_code=404, detail="group member not found")
    db.delete(member)
    db.commit()
    return GroupDetail(id=group.id, name=group.name, description=group.description, members=_load_group_members(db, group_id))


def _load_group_members(db: Session, group_id: int) -> list[GroupMemberRead]:
    # 这里把纯关系表 chat_group_members 转成前端更容易直接用的展示结构。
    members = list(db.scalars(select(ChatGroupMember).where(ChatGroupMember.group_id == group_id).order_by(ChatGroupMember.id)))
    out: list[GroupMemberRead] = []
    for member in members:
        agent = db.get(AgentProfile, member.agent_id)
        instance = db.get(OpenClawInstance, member.instance_id)
        if not agent or not instance:
            continue
        out.append(
            GroupMemberRead(
                id=member.id,
                group_id=member.group_id,
                instance_id=member.instance_id,
                agent_id=member.agent_id,
                joined_at=member.joined_at.astimezone(timezone.utc).isoformat(),
                agent_key=agent.agent_key,
                display_name=agent.display_name,
                role_name=agent.role_name,
                instance_name=instance.name,
            )
        )
    return out
