"""
这里统一管理 Claw Team 内部的 Agent CT ID。

设计目标：
1. CT ID 只作为 Claw Team 内部稳定寻址标识，不依赖实例名或 display_name。
2. 历史 Agent 没有 ct_id 时，也能按主键生成稳定值，避免一次改名牵出整条链路。
3. 生成规则保持单点来源，后续如果要换格式，只改这里。
"""
from __future__ import annotations

from src.models.agent_profile import AgentProfile

CT_ID_PREFIX = "CTA"
CT_ID_WIDTH = 4


def format_agent_ct_id(agent_id: int) -> str:
    return f"{CT_ID_PREFIX}-{agent_id:0{CT_ID_WIDTH}d}"


def ensure_agent_ct_id(agent: AgentProfile) -> str:
    """
    给 Agent 补齐稳定 CT ID。

    这里故意按数据库主键生成：
    1. 历史数据补齐时不需要额外序列表。
    2. 同一个 Agent 改名或挪展示名称后，CT ID 仍保持不变。
    """
    raw = (agent.ct_id or "").strip()
    if raw:
        return raw
    agent.ct_id = format_agent_ct_id(agent.id)
    return agent.ct_id
