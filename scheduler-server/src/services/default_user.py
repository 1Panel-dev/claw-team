"""
这里集中定义当前系统里的默认人类用户身份。

现阶段系统还没有正式的用户表：
1. 人类发言方仍然只有一个默认用户。
2. 但为了后续接入真实登录用户，这里先把默认用户身份收敛成统一入口。
3. 这样后面从“默认用户”切到“真实用户解析”时，不需要全局替换散落的字符串。
"""
from __future__ import annotations

from dataclasses import dataclass


DEFAULT_USER_INTERNAL_ID = "user"
DEFAULT_USER_LABEL = "User"
DEFAULT_USER_CS_ID = "CSU-0001"


@dataclass(frozen=True)
class DefaultUserIdentity:
    """
    默认用户的最小身份信息。

    说明：
    1. internal_id 是当前系统内部仍在使用的稳定占位标识。
    2. cs_id 是面向后续多用户设计保留的联系人身份。
    3. sender_label 继续保持为 User，尽量避免改动现有展示行为。
    """

    internal_id: str = DEFAULT_USER_INTERNAL_ID
    sender_label: str = DEFAULT_USER_LABEL
    cs_id: str = DEFAULT_USER_CS_ID

    @property
    def label_with_cs_id(self) -> str:
        return f"{self.sender_label} ({self.cs_id})"

    def as_channel_sender(self) -> dict[str, str]:
        return {
            "userId": self.internal_id,
            "displayName": self.sender_label,
        }


def get_default_user_identity() -> DefaultUserIdentity:
    return DefaultUserIdentity()


def display_sender_label(*, sender_type: str, sender_label: str | None) -> str:
    """
    统一收口消息发送者的展示名称。

    现阶段只有默认用户需要补 CS ID。
    这样旧消息就算数据库里仍然是 `User`，接口层也能统一显示成 `User (CSU-0001)`。
    """

    if sender_type == "user":
        return get_default_user_identity().label_with_cs_id
    return (sender_label or "").strip()
