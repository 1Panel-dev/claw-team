"""
这里集中处理双 Agent 对话的“参与者配对”规则。

当前规则：
1. 只要参与者是同一对 Agent，就视为同一条长期对话。
2. 方向不重要，A -> B 与 B -> A 复用同一条会话。
3. 历史上如果已经产生了重复记录，优先复用最近更新的那一条。
"""
from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from src.models.agent_dialogue import AgentDialogue


def build_agent_dialogue_pair_key(first_agent_id: int, second_agent_id: int) -> tuple[int, int]:
    """
    把双 Agent 对话的参与者收敛成无方向 pair key，方便去重和复用。
    """
    return tuple(sorted((first_agent_id, second_agent_id)))


def find_reusable_agent_dialogue(
    *,
    db: Session,
    first_agent_id: int,
    second_agent_id: int,
) -> AgentDialogue | None:
    """
    查找同一对参与者最近的一条双 Agent 对话。

    这里故意按 updated_at 倒序取最新一条：
    1. 新逻辑下，后续都会复用这条记录。
    2. 老数据里就算已经出现重复，也优先收口到最近活跃的那条。
    """
    return db.scalar(
        select(AgentDialogue)
        .where(
            or_(
                (AgentDialogue.source_agent_id == first_agent_id) & (AgentDialogue.target_agent_id == second_agent_id),
                (AgentDialogue.source_agent_id == second_agent_id) & (AgentDialogue.target_agent_id == first_agent_id),
            )
        )
        .order_by(AgentDialogue.updated_at.desc(), AgentDialogue.id.desc())
    )
