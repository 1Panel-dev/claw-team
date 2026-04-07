"""
这里定义 Agent 管理相关的请求与响应 schema。

它服务于实例下 Agent 的创建、修改、启停和通讯录展示。
"""
from pydantic import BaseModel, Field

from src.schemas.common import TimestampedModel


class AgentCreate(BaseModel):
    # agent_key 会直接参与后续路由，所以这里要求调用方传稳定值。
    agent_key: str = Field(min_length=1, max_length=120)
    display_name: str = Field(min_length=1, max_length=120)
    role_name: str | None = Field(default=None, max_length=120)
    identity_md: str | None = None
    soul_md: str | None = None
    user_md: str | None = None
    memory_md: str | None = None
    enabled: bool = True


class AgentUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    role_name: str | None = Field(default=None, max_length=120)
    identity_md: str | None = None
    soul_md: str | None = None
    user_md: str | None = None
    memory_md: str | None = None
    enabled: bool | None = None


class AgentRead(TimestampedModel):
    id: int
    instance_id: int
    agent_key: str
    cs_id: str
    display_name: str
    role_name: str | None
    enabled: bool
    created_via_clawswarm: bool


class AgentProfileRead(AgentRead):
    identity_md: str
    soul_md: str
    user_md: str
    memory_md: str
