"""
这里定义实例管理相关的请求与响应 schema。

它对应的是 OpenClawInstance 模型，但会把内部 ORM 对象收敛成 API 层输入输出结构。
"""
from pydantic import BaseModel, Field

from src.schemas.common import TimestampedModel


class InstanceCreate(BaseModel):
    # 这些字段就是调度中心接入一套 claw-team channel 所需的最小连接信息。
    name: str = Field(min_length=1, max_length=120)
    channel_base_url: str = Field(min_length=1, max_length=500)
    channel_account_id: str = Field(default="default", min_length=1, max_length=120)
    channel_signing_secret: str = Field(min_length=16, max_length=255)
    callback_token: str = Field(min_length=8, max_length=255)
    status: str = Field(default="active", pattern="^(active|disabled|offline)$")


class InstanceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    channel_base_url: str | None = Field(default=None, min_length=1, max_length=500)
    channel_account_id: str | None = Field(default=None, min_length=1, max_length=120)
    channel_signing_secret: str | None = Field(default=None, min_length=16, max_length=255)
    callback_token: str | None = Field(default=None, min_length=8, max_length=255)
    status: str | None = Field(default=None, pattern="^(active|disabled|offline)$")


class InstanceRead(TimestampedModel):
    # 响应里不直接暴露签名密钥和 callback token，避免无意泄漏。
    id: int
    instance_key: str
    name: str
    channel_base_url: str
    channel_account_id: str
    status: str


class InstanceHealthRead(BaseModel):
    id: int
    status: str = Field(pattern="^(active|disabled|offline)$")


class OpenClawConnectRequest(BaseModel):
    # 快速接入模式下，用户只需要填写实例名称和 OpenClaw 地址。
    name: str = Field(min_length=1, max_length=120)
    channel_base_url: str = Field(min_length=1, max_length=500)
    channel_account_id: str = Field(default="default", min_length=1, max_length=120)


class InstanceCredentialsRead(BaseModel):
    outbound_token: str = Field(min_length=8, max_length=255)
    inbound_signing_secret: str = Field(min_length=16, max_length=255)


class OpenClawConnectResponse(BaseModel):
    instance: InstanceRead
    imported_agent_count: int
    agent_keys: list[str]
    credentials: InstanceCredentialsRead


class OpenClawSyncAgentsResponse(BaseModel):
    instance: InstanceRead
    imported_agent_count: int
    agent_keys: list[str]
