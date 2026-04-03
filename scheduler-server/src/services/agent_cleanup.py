from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from src.models.agent_dialogue import AgentDialogue
from src.models.agent_profile import AgentProfile
from src.models.chat_group_member import ChatGroupMember
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_callback_event import MessageCallbackEvent
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance


def delete_conversation_records(db: Session, *, conversation_ids: list[int]) -> None:
    if not conversation_ids:
        return

    dispatch_ids = list(
        db.scalars(
            select(MessageDispatch.id).where(MessageDispatch.conversation_id.in_(conversation_ids))
        )
    )
    if dispatch_ids:
        db.execute(delete(MessageCallbackEvent).where(MessageCallbackEvent.dispatch_id.in_(dispatch_ids)))

    db.execute(delete(AgentDialogue).where(AgentDialogue.conversation_id.in_(conversation_ids)))
    db.execute(delete(MessageDispatch).where(MessageDispatch.conversation_id.in_(conversation_ids)))
    db.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    db.execute(delete(Conversation).where(Conversation.id.in_(conversation_ids)))


def delete_agent_private_conversations(db: Session, *, agent_id: int) -> None:
    """
    清理某个 Agent 的私有历史：
    1. direct conversation
    2. agent_dialogue conversation

    群和群消息不在这里删除，避免把共享历史一并带走。
    """
    direct_conversation_ids = list(
        db.scalars(
            select(Conversation.id).where(
                Conversation.type == "direct",
                Conversation.direct_agent_id == agent_id,
            )
        )
    )
    dialogue_conversation_ids = list(
        db.scalars(
            select(AgentDialogue.conversation_id).where(
                (AgentDialogue.source_agent_id == agent_id)
                | (AgentDialogue.target_agent_id == agent_id)
                | (AgentDialogue.initiator_agent_id == agent_id)
                | (AgentDialogue.last_speaker_agent_id == agent_id)
            )
        )
    )
    delete_conversation_records(
        db,
        conversation_ids=sorted(set(direct_conversation_ids + dialogue_conversation_ids)),
    )


def delete_instance_private_data(db: Session, *, instance_id: int) -> OpenClawInstance | None:
    instance = db.get(OpenClawInstance, instance_id)
    if instance is None:
        return None

    agent_ids = list(
        db.scalars(
            select(AgentProfile.id).where(AgentProfile.instance_id == instance_id).order_by(AgentProfile.id)
        )
    )

    for agent_id in agent_ids:
        delete_agent_private_conversations(db, agent_id=agent_id)

    if agent_ids:
        db.execute(delete(ChatGroupMember).where(ChatGroupMember.agent_id.in_(agent_ids)))

    db.execute(delete(AgentProfile).where(AgentProfile.instance_id == instance_id))
    db.execute(delete(OpenClawInstance).where(OpenClawInstance.id == instance_id))
    return instance
