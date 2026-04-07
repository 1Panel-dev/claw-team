"""
这个模型表示会话中的一条消息。

这里既保存用户发出的消息，也保存 agent 回答回来的消息。
两者通过 sender_type 区分：
1. user
2. agent
"""
from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from src.core.db import Base
from src.models.base_mixins import TimestampMixin


class Message(Base, TimestampMixin):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("conversations.id"), index=True)
    sender_type: Mapped[str] = mapped_column(String(20))
    sender_label: Mapped[str] = mapped_column(String(120))
    sender_cs_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    content: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending")
