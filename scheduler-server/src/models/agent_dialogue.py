"""
这个模型表示一条由调度中心托管的双 Agent 对话。

第一阶段先把边界收窄：
1. 只支持两个 Agent。
2. 所有消息都通过 scheduler-server 托管和转发。
3. 用户可以在客户端里观察、插话、暂停、恢复、停止。
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from src.core.db import Base
from src.models.base_mixins import TimestampMixin


class AgentDialogue(Base, TimestampMixin):
    __tablename__ = "agent_dialogues"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), unique=True, index=True)
    source_agent_id: Mapped[int] = mapped_column(ForeignKey("agent_profiles.id"), index=True)
    target_agent_id: Mapped[int] = mapped_column(ForeignKey("agent_profiles.id"), index=True)
    topic: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), default="active")
    initiator_type: Mapped[str] = mapped_column(String(20), default="user")
    initiator_agent_id: Mapped[int | None] = mapped_column(ForeignKey("agent_profiles.id"), nullable=True, index=True)
    # 兼容旧库里还保留的轮次字段。
    # 新逻辑已经不再依赖它们，但老 SQLite 表上这两列仍可能是 NOT NULL，
    # 所以模型里继续带着默认值，避免插入新记录时触发约束错误。
    max_turns: Mapped[int] = mapped_column(Integer, default=0)
    current_turn: Mapped[int] = mapped_column(Integer, default=0)
    window_seconds: Mapped[int] = mapped_column(Integer, default=300)
    soft_message_limit: Mapped[int] = mapped_column(Integer, default=12)
    hard_message_limit: Mapped[int] = mapped_column(Integer, default=20)
    soft_limit_warned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_speaker_agent_id: Mapped[int | None] = mapped_column(ForeignKey("agent_profiles.id"), nullable=True, index=True)
