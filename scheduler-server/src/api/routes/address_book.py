"""
这个文件负责前端左侧通讯录所需的聚合接口。

主要职责：
1. 一次性返回实例树、实例下的 agent，以及群组列表。
2. 把多张表的数据整理成前端可以直接渲染的树形结构。
3. 减少前端首次加载时的接口调用次数。
"""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import db_session
from src.models.agent_profile import AgentProfile
from src.models.chat_group import ChatGroup
from src.models.chat_group_member import ChatGroupMember
from src.models.openclaw_instance import OpenClawInstance
from src.schemas.address_book import (
    AddressBookAgent,
    AddressBookGroup,
    AddressBookGroupMember,
    AddressBookInstance,
    AddressBookResponse,
)
from src.services.agent_cs_id import ensure_agent_cs_id

router = APIRouter(prefix="/api", tags=["address-book"])


@router.get("/address-book", response_model=AddressBookResponse)
def get_address_book(db: Session = Depends(db_session)) -> AddressBookResponse:
    # 第一阶段前端先用一个聚合接口拿全量通讯录，避免刚起步时为了树结构拆太多请求。
    instances = list(
        db.scalars(
            select(OpenClawInstance)
            .where(OpenClawInstance.status != "disabled")
            .order_by(OpenClawInstance.id)
        )
    )
    visible_instance_ids = {instance.id for instance in instances}
    agents = list(
        db.scalars(
            select(AgentProfile)
            .where(
                AgentProfile.removed_from_openclaw.is_(False),
                AgentProfile.instance_id.in_(visible_instance_ids) if visible_instance_ids else False,
            )
            .order_by(AgentProfile.instance_id, AgentProfile.id)
        )
    )
    groups = list(db.scalars(select(ChatGroup).order_by(ChatGroup.id)))
    members = list(db.scalars(select(ChatGroupMember).order_by(ChatGroupMember.group_id, ChatGroupMember.id)))

    agent_map = {agent.id: agent for agent in agents}
    instance_map = {instance.id: instance for instance in instances}

    grouped_agents: dict[int, list[AddressBookAgent]] = {}
    touched = False
    for agent in agents:
        if not (agent.cs_id or "").strip():
            ensure_agent_cs_id(agent)
            touched = True
        # 这里先按 instance_id 归并 agent，后面实例列表输出时可直接挂到对应实例下面。
        grouped_agents.setdefault(agent.instance_id, []).append(
            AddressBookAgent(
                id=agent.id,
                agent_key=agent.agent_key,
                cs_id=agent.cs_id or "",
                display_name=agent.display_name,
                role_name=agent.role_name,
                enabled=agent.enabled,
            )
        )
    if touched:
        db.commit()

    group_members: dict[int, list[AddressBookGroupMember]] = {}
    for member in members:
        agent = agent_map.get(member.agent_id)
        instance = instance_map.get(member.instance_id)
        if not agent or not instance:
            continue
        # 群组成员既要展示 agent 名，也要展示它来自哪个实例，所以这里把两边信息合并起来。
        group_members.setdefault(member.group_id, []).append(
            AddressBookGroupMember(
                id=member.id,
                instance_id=member.instance_id,
                agent_id=member.agent_id,
                display_name=agent.display_name,
                agent_key=agent.agent_key,
                instance_name=instance.name,
            )
        )

    return AddressBookResponse(
        instances=[
            # 前端左侧通讯录展示实例节点时，直接使用这里整理好的 agents 列表。
            AddressBookInstance(id=i.id, name=i.name, status=i.status, agents=grouped_agents.get(i.id, []))
            for i in instances
        ],
        groups=[
            # 群组节点同样直接附带成员，前端不必再二次查询群成员详情。
            AddressBookGroup(id=g.id, name=g.name, description=g.description, members=group_members.get(g.id, []))
            for g in groups
        ],
    )
