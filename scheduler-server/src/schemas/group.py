"""
这里定义群组和群成员管理相关的 schema。

第一阶段里，群组成员是跨实例群聊的业务基础，因此这里的响应结构会额外带展示字段。
"""
from pydantic import BaseModel, Field

from src.schemas.common import TimestampedModel


class GroupMemberAddItem(BaseModel):
    instance_id: int
    agent_id: int


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    members: list[GroupMemberAddItem] = Field(default_factory=list)


class GroupRead(TimestampedModel):
    id: int
    name: str
    description: str | None


class GroupMemberAddRequest(BaseModel):
    members: list[GroupMemberAddItem]


class GroupMemberRead(BaseModel):
    # 这里把成员关系、Agent 展示名和实例名一起返回，方便前端直接渲染。
    id: int
    group_id: int
    instance_id: int
    agent_id: int
    joined_at: str
    agent_key: str
    display_name: str
    role_name: str | None
    instance_name: str


class GroupDetail(BaseModel):
    id: int
    name: str
    description: str | None
    members: list[GroupMemberRead]
