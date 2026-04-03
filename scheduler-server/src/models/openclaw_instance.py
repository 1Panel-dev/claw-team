"""
这个模型表示一套可被调度中心调用的 OpenClaw 实例。

它保存的是第一阶段联调所需的最小接入信息：
1. channel 的访问地址。
2. channel 的 accountId。
3. 调度中心调用 channel 时使用的签名密钥。
4. channel 回调调度中心时使用的 callback token。
"""
from uuid import uuid4

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from src.core.db import Base
from src.models.base_mixins import TimestampMixin


class OpenClawInstance(Base, TimestampMixin):
    __tablename__ = "openclaw_instances"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # 稳定唯一标识只给系统自己用，展示名允许重复。
    instance_key: Mapped[str] = mapped_column(String(36), unique=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120))
    # 例如 https://172.16.200.119:18789 这样的 claw-team channel 基础地址。
    channel_base_url: Mapped[str] = mapped_column(String(500))
    # 对应 channel 里的账号标识，当前默认一般都是 default。
    channel_account_id: Mapped[str] = mapped_column(String(120), default="default")
    # scheduler-server -> channel 时使用的入站签名密钥。
    channel_signing_secret: Mapped[str] = mapped_column(String(255))
    # channel -> scheduler-server 回调时使用的 Bearer Token。
    callback_token: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), default="active")
