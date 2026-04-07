"""
这个文件负责“本地联调模式”的模拟 Agent 回复。

目的：
1. 让 web-client 可以和 scheduler-server 走真实 HTTP / 数据库链路。
2. 即使 OpenClaw / channel 暂时不可用，也能看到消息列表、dispatch 状态和 agent 回复。
3. 同时复用当前富内容消息协议，继续验证 markdown / attachment / tool_card 展示。
"""
from __future__ import annotations

import uuid
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from src.models.agent_profile import AgentProfile
from src.models.message import Message
from src.models.message_dispatch import MessageDispatch


def simulate_local_agent_reply(
    *,
    db: Session,
    conversation_id: int,
    message_id: str,
    dispatch_ids: Iterable[str],
) -> None:
    """
    用后台任务模拟一次 agent 完成回复。

    这里故意不做复杂异步流式，只做第一阶段最小闭环：
    1. dispatch -> completed
    2. user message -> completed
    3. 为每个目标 agent 生成一条 agent 消息
    """
    message = db.get(Message, message_id)
    if not message:
        return

    dispatches = list(
        db.scalars(
            select(MessageDispatch).where(
                MessageDispatch.id.in_(list(dispatch_ids)),
                MessageDispatch.conversation_id == conversation_id,
            )
        )
    )
    if not dispatches:
        return

    # 一个消息在群聊里可能打给多个 agent，所以这里逐条生成回复。
    for dispatch in dispatches:
        agent = db.get(AgentProfile, dispatch.agent_id)
        if not agent:
            continue

        dispatch.status = "completed"
        dispatch.channel_trace_id = dispatch.channel_trace_id or f"local-mock-{dispatch.id}"
        dispatch.session_key = dispatch.session_key or f"local-mock:{conversation_id}:{agent.agent_key}"

        db.add(
            Message(
                id=f"msg_{uuid.uuid4().hex[:24]}",
                conversation_id=conversation_id,
                sender_type="agent",
                sender_label=agent.display_name,
                sender_cs_id=agent.cs_id,
                content=_build_mock_reply(agent.display_name, message.content),
                status="completed",
            )
        )

    message.status = "completed"
    db.commit()


def _build_mock_reply(agent_name: str, user_text: str) -> str:
    # 为不同角色构造不同风格的真实富内容，
    # 这样前端联调时就不只是看到“纯文本回显”。
    lower_name = agent_name.lower()
    if "运维" in agent_name or "ops" in lower_name:
        return "\n\n".join(
            [
                f"已收到你的消息：{user_text}",
                "[[tool:预发巡检|completed|共检查 12 项，Nginx、SQLite 备份、磁盘空间均正常]]",
                "[[attachment:巡检报告.pdf|application/pdf|https://example.com/report.pdf]]",
            ]
        )
    if "工程" in agent_name or "architect" in lower_name:
        return "\n\n".join(
            [
                f"我先给出实现建议，主题是：{user_text}",
                "| 模块 | 建议 |",
                "| --- | --- |",
                "| 前端 | 优先收口消息页布局 |",
                "| 后端 | 保持 parts 协议兼容升级 |",
                "```ts\nconst nextStep = 'wire-real-backend';\n```",
            ]
        )
    if "设计" in agent_name:
        return "\n\n".join(
            [
                f"我从界面角度看，当前重点还是：{user_text}",
                "> 优先解决信息密度和留白不协调的问题。",
                "- 压缩不必要边框",
                "- 保持输入区固定",
                "- 让富内容卡片更轻",
            ]
        )
    return "\n\n".join(
        [
            f"{agent_name} 已收到你的消息：{user_text}",
            "下面是当前建议：",
            "- 先验证真实前后端链路",
            "- 保持 OpenClaw 不可用时也能联调",
            "- 富内容继续沿用 parts 模型",
        ]
    )
