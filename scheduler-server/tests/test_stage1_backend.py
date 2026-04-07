"""
这些测试覆盖 scheduler-server 第一阶段最关键的后端行为。

当前重点验证：
1. 会话列表接口是否能返回前端侧栏需要的摘要信息。
2. 消息列表接口是否支持最小增量拉取。
3. callback 重复投递时，是否还能保持幂等。
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import importlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from src.api.deps import db_session
from src.core.db import Base
from src.main import create_app
from src.models.agent_profile import AgentProfile
from src.models.agent_dialogue import AgentDialogue
from src.models.chat_group import ChatGroup
from src.models.chat_group_member import ChatGroupMember
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_callback_event import MessageCallbackEvent
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.core.config import settings
from src.api.routes.agents import sync_instance_agents
from src.api.routes import instances as instances_route
from src.services.auth import build_session_cookie_value, ensure_default_user
from src.services.agent_dialogue_runner import continue_agent_dialogue_after_reply


class Stage1BackendTests(unittest.TestCase):
    """
    用独立 SQLite 临时库做接口测试，避免污染开发库。

    这里不依赖远程 OpenClaw，也不走真实网络，只验证调度中心自己的路由行为。
    """

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test.db"
        self.engine = create_engine(
            f"sqlite:///{self.db_path}",
            future=True,
            connect_args={"check_same_thread": False},
        )
        self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, autocommit=False, future=True)
        Base.metadata.create_all(bind=self.engine)

        self.app = create_app()
        self.app.state.session_local = self.SessionLocal
        self.original_web_dist_dir = getattr(settings, "web_dist_dir", None)

        def override_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        self.app.dependency_overrides[db_session] = override_db
        self.client = TestClient(self.app)
        with self.SessionLocal() as db:
            user = ensure_default_user(db)
            self.client.cookies.set("clawswarm_session", build_session_cookie_value(user))

    def tearDown(self) -> None:
        self.app.dependency_overrides.clear()
        settings.web_dist_dir = self.original_web_dist_dir
        self.engine.dispose()
        self.temp_dir.cleanup()

    def _run_async(self, awaitable):
        return asyncio.run(awaitable)

    def test_list_conversations_returns_sidebar_summary(self) -> None:
        """
        会话列表接口应该返回前端侧栏所需的展示字段，并按最后消息时间排序。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            direct_conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            group = ChatGroup(name="产品讨论群", description="第一阶段测试群")
            db.add_all([direct_conversation, group])
            db.flush()

            group_conversation = Conversation(type="group", title="产品讨论群", group_id=group.id)
            db.add(group_conversation)
            db.flush()

            db.add_all(
                [
                    Message(
                        id="msg_direct_1",
                        conversation_id=direct_conversation.id,
                        sender_type="user",
                        sender_label="User",
                        content="这是一条较早的消息",
                        status="completed",
                    ),
                    Message(
                        id="msg_group_1",
                        conversation_id=group_conversation.id,
                        sender_type="agent",
                        sender_label="PM",
                        content="这是一条更新的群聊消息，用于测试会话排序。",
                        status="completed",
                    ),
                ]
            )
            db.commit()

        response = self.client.get("/api/conversations")
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(len(payload), 2)
        # 群聊最后一条消息更新，因此应排在前面。
        self.assertEqual(payload[0]["type"], "group")
        self.assertEqual(payload[0]["display_title"], "产品讨论群")
        self.assertEqual(payload[0]["last_message_preview"], "这是一条更新的群聊消息，用于测试会话排序。")

        self.assertEqual(payload[1]["type"], "direct")
        self.assertEqual(payload[1]["instance_name"], "OpenClaw A")
        self.assertEqual(payload[1]["agent_display_name"], "Main Agent")

    def test_auth_login_sets_session_and_allows_protected_api(self) -> None:
        self.client.cookies.clear()
        unauthenticated = self.client.get("/api/instances")
        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(unauthenticated.json()["detail"], "Authentication required")

        login_response = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123456"},
        )
        self.assertEqual(login_response.status_code, 200)
        login_payload = login_response.json()
        self.assertEqual(login_payload["username"], "admin")
        self.assertEqual(login_payload["display_name"], "admin")
        self.assertTrue(login_payload["using_default_password"])
        self.assertTrue(login_payload["id"])

        me_response = self.client.get("/api/auth/me")
        self.assertEqual(me_response.status_code, 200)
        self.assertEqual(me_response.json()["username"], "admin")
        self.assertEqual(me_response.json()["display_name"], "admin")

        instances_response = self.client.get("/api/instances")
        self.assertEqual(instances_response.status_code, 200)

    def test_auth_profile_update_changes_display_name_and_password(self) -> None:
        self.client.cookies.clear()
        login_response = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123456"},
        )
        self.assertEqual(login_response.status_code, 200)

        update_response = self.client.put(
            "/api/auth/profile",
            json={
                "display_name": "Owner",
                "current_password": "admin123456",
                "new_password": "new-password-123",
            },
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()["username"], "admin")
        self.assertEqual(update_response.json()["display_name"], "Owner")
        self.assertFalse(update_response.json()["using_default_password"])

        self.client.post("/api/auth/logout")

        old_login = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123456"},
        )
        self.assertEqual(old_login.status_code, 401)
        self.assertEqual(old_login.json()["detail"], "Invalid username or password")

        new_login = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "new-password-123"},
        )
        self.assertEqual(new_login.status_code, 200)
        self.assertEqual(new_login.json()["username"], "admin")
        self.assertEqual(new_login.json()["display_name"], "Owner")
        self.assertFalse(new_login.json()["using_default_password"])

    def test_auth_profile_update_allows_display_name_change_without_current_password(self) -> None:
        self.client.cookies.clear()
        login_response = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123456"},
        )
        self.assertEqual(login_response.status_code, 200)

        update_response = self.client.put(
            "/api/auth/profile",
            json={"display_name": "Owner Only"},
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()["display_name"], "Owner Only")
        self.assertTrue(update_response.json()["using_default_password"])

        login_again = self.client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123456"},
        )
        self.assertEqual(login_again.status_code, 200)
        self.assertEqual(login_again.json()["display_name"], "Owner Only")

    def test_health_remains_public_without_login(self) -> None:
        self.client.cookies.clear()
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})

    def test_list_conversations_hides_direct_conversations_for_disabled_instance(self) -> None:
        with self.SessionLocal() as db:
            disabled_instance = OpenClawInstance(
                name="Disabled OpenClaw",
                channel_base_url="https://disabled.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="disabled",
            )
            active_instance = OpenClawInstance(
                name="Active OpenClaw",
                channel_base_url="https://active.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-abcdef",
                callback_token="callback-token-456",
                status="active",
            )
            db.add_all([disabled_instance, active_instance])
            db.flush()

            disabled_agent = AgentProfile(
                instance_id=disabled_instance.id,
                agent_key="main",
                display_name="Disabled Agent",
                role_name="assistant",
                enabled=True,
            )
            active_agent = AgentProfile(
                instance_id=active_instance.id,
                agent_key="main",
                display_name="Active Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add_all([disabled_agent, active_agent])
            db.flush()

            disabled_conversation = Conversation(
                type="direct",
                title="Disabled OpenClaw / Disabled Agent",
                direct_instance_id=disabled_instance.id,
                direct_agent_id=disabled_agent.id,
            )
            active_conversation = Conversation(
                type="direct",
                title="Active OpenClaw / Active Agent",
                direct_instance_id=active_instance.id,
                direct_agent_id=active_agent.id,
            )
            db.add_all([disabled_conversation, active_conversation])
            db.flush()

            db.add_all(
                [
                    Message(
                        id="msg_disabled_1",
                        conversation_id=disabled_conversation.id,
                        sender_type="agent",
                        sender_label="Disabled Agent",
                        content="disabled message",
                        status="completed",
                    ),
                    Message(
                        id="msg_active_1",
                        conversation_id=active_conversation.id,
                        sender_type="agent",
                        sender_label="Active Agent",
                        content="active message",
                        status="completed",
                    ),
                ]
            )
            db.commit()

        response = self.client.get("/api/conversations")
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["instance_name"], "Active OpenClaw")

    def test_address_book_hides_disabled_instances_and_their_agents(self) -> None:
        with self.SessionLocal() as db:
            disabled_instance = OpenClawInstance(
                name="Disabled OpenClaw",
                channel_base_url="https://disabled.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="disabled",
            )
            active_instance = OpenClawInstance(
                name="Active OpenClaw",
                channel_base_url="https://active.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-abcdef",
                callback_token="callback-token-456",
                status="active",
            )
            db.add_all([disabled_instance, active_instance])
            db.flush()

            db.add_all(
                [
                    AgentProfile(
                        instance_id=disabled_instance.id,
                        agent_key="main",
                        display_name="Disabled Agent",
                        role_name="assistant",
                        enabled=True,
                    ),
                    AgentProfile(
                        instance_id=active_instance.id,
                        agent_key="main",
                        display_name="Active Agent",
                        role_name="assistant",
                        enabled=True,
                    ),
                ]
            )
            db.commit()

        response = self.client.get("/api/address-book")
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(len(payload["instances"]), 1)
        self.assertEqual(payload["instances"][0]["name"], "Active OpenClaw")
        self.assertEqual(len(payload["instances"][0]["agents"]), 1)
        self.assertEqual(payload["instances"][0]["agents"][0]["display_name"], "Active Agent")

    def test_agent_dialogue_model_can_persist_with_agent_dialogue_conversation(self) -> None:
        """
        双 Agent 对话的基础模型至少要能在当前测试库里创建和读取，
        这样后面的路由和状态机实现才有稳定底座。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="liaotian",
                display_name="liaotian",
                role_name="聊天专家",
                enabled=True,
            )
            target_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="weather",
                display_name="weather",
                role_name="天气助手",
                enabled=True,
            )
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(
                type="agent_dialogue",
                title="liaotian ↔ weather",
            )
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="讨论今天的天气播报",
                status="active",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
            )
            db.add(dialogue)
            db.commit()

            saved = db.scalar(select(AgentDialogue).where(AgentDialogue.conversation_id == conversation.id))
            self.assertIsNotNone(saved)
            assert saved is not None
            self.assertEqual(saved.topic, "讨论今天的天气播报")
            self.assertEqual(saved.status, "active")
            self.assertEqual(saved.window_seconds, 300)
            self.assertEqual(saved.soft_message_limit, 12)
            self.assertEqual(saved.hard_message_limit, 20)

    def test_create_agent_dialogue_adds_conversation_and_opening_message(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="liaotian",
                display_name="liaotian",
                role_name="聊天专家",
                enabled=True,
            )
            target_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="weather",
                display_name="weather",
                role_name="天气助手",
                enabled=True,
            )
            db.add_all([source_agent, target_agent])
            db.commit()
            source_agent_id = source_agent.id
            target_agent_id = target_agent.id

        with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-agent-dialogue"})):
            response = self.client.post(
                "/api/agent-dialogues",
                json={
                    "source_agent_id": source_agent_id,
                    "target_agent_id": target_agent_id,
                    "topic": "请讨论今天的大兴天气",
                    "window_seconds": 300,
                    "soft_message_limit": 12,
                    "hard_message_limit": 20,
                },
            )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "active")
        self.assertEqual(payload["window_seconds"], 300)
        self.assertEqual(payload["soft_message_limit"], 12)
        self.assertEqual(payload["hard_message_limit"], 20)

        with self.SessionLocal() as db:
            dialogue = db.get(AgentDialogue, payload["id"])
            self.assertIsNotNone(dialogue)
            assert dialogue is not None
            conversation = db.get(Conversation, dialogue.conversation_id)
            self.assertIsNotNone(conversation)
            assert conversation is not None
            self.assertEqual(conversation.type, "agent_dialogue")
            opening = db.scalar(select(Message).where(Message.conversation_id == conversation.id))
            self.assertIsNotNone(opening)
            assert opening is not None
            self.assertEqual(opening.sender_type, "user")
            self.assertEqual(opening.content, "请讨论今天的大兴天气")
            first_dispatch = db.scalar(select(MessageDispatch).where(MessageDispatch.conversation_id == conversation.id))
            self.assertIsNotNone(first_dispatch)
            assert first_dispatch is not None
            self.assertEqual(first_dispatch.dispatch_mode, "agent_dialogue_opening")
            self.assertEqual(first_dispatch.status, "accepted")

    def test_create_agent_dialogue_reuses_existing_conversation_for_same_pair(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="liaotian",
                display_name="liaotian",
                role_name="聊天专家",
                enabled=True,
            )
            target_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="weather",
                display_name="weather",
                role_name="天气助手",
                enabled=True,
            )
            db.add_all([source_agent, target_agent])
            db.commit()
            source_agent_id = source_agent.id
            target_agent_id = target_agent.id

        with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-agent-dialogue"})):
            first = self.client.post(
                "/api/agent-dialogues",
                json={
                    "source_agent_id": source_agent_id,
                    "target_agent_id": target_agent_id,
                    "topic": "第一次讨论",
                },
            )
            second = self.client.post(
                "/api/agent-dialogues",
                json={
                    "source_agent_id": source_agent_id,
                    "target_agent_id": target_agent_id,
                    "topic": "第二次讨论",
                },
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        first_payload = first.json()
        second_payload = second.json()
        self.assertEqual(first_payload["id"], second_payload["id"])
        self.assertEqual(first_payload["conversation_id"], second_payload["conversation_id"])

        with self.SessionLocal() as db:
            conversations = list(db.scalars(select(Conversation).where(Conversation.type == "agent_dialogue")))
            self.assertEqual(len(conversations), 1)
            messages = list(
                db.scalars(
                    select(Message)
                    .where(Message.conversation_id == first_payload["conversation_id"])
                    .order_by(Message.created_at, Message.id)
                )
            )
            self.assertEqual([item.content for item in messages[:2]], ["第一次讨论", "第二次讨论"])

    def test_create_agent_dialogue_reuses_existing_conversation_for_reversed_pair(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            first_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="liaotian",
                display_name="liaotian",
                role_name="聊天专家",
                enabled=True,
            )
            second_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="weather",
                display_name="weather",
                role_name="天气助手",
                enabled=True,
            )
            db.add_all([first_agent, second_agent])
            db.commit()
            first_agent_id = first_agent.id
            second_agent_id = second_agent.id

        with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-agent-dialogue"})):
            first = self.client.post(
                "/api/agent-dialogues",
                json={
                    "source_agent_id": first_agent_id,
                    "target_agent_id": second_agent_id,
                    "topic": "正向讨论",
                },
            )
            second = self.client.post(
                "/api/agent-dialogues",
                json={
                    "source_agent_id": second_agent_id,
                    "target_agent_id": first_agent_id,
                    "topic": "反向继续",
                },
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        first_payload = first.json()
        second_payload = second.json()
        self.assertEqual(first_payload["id"], second_payload["id"])
        self.assertEqual(first_payload["conversation_id"], second_payload["conversation_id"])
        self.assertEqual(second_payload["source_agent_id"], second_agent_id)
        self.assertEqual(second_payload["target_agent_id"], first_agent_id)

    def test_agent_dialogue_control_endpoints_update_status(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(instance_id=instance.id, agent_key="a", display_name="A", role_name=None, enabled=True)
            target_agent = AgentProfile(instance_id=instance.id, agent_key="b", display_name="B", role_name=None, enabled=True)
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(type="agent_dialogue", title="A ↔ B")
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="测试控制",
                status="active",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
            )
            db.add(dialogue)
            db.commit()
            dialogue_id = dialogue.id

        pause_response = self.client.post(f"/api/agent-dialogues/{dialogue_id}/pause")
        self.assertEqual(pause_response.status_code, 200)
        self.assertEqual(pause_response.json()["status"], "paused")

        resume_response = self.client.post(f"/api/agent-dialogues/{dialogue_id}/resume")
        self.assertEqual(resume_response.status_code, 200)
        self.assertEqual(resume_response.json()["status"], "active")

        stop_response = self.client.post(f"/api/agent-dialogues/{dialogue_id}/stop")
        self.assertEqual(stop_response.status_code, 200)
        self.assertEqual(stop_response.json()["status"], "stopped")

    def test_send_text_can_start_agent_dialogue_by_cs_ids(self) -> None:
        with self.SessionLocal() as db:
            instance_a = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-a",
                status="active",
            )
            instance_b = OpenClawInstance(
                name="OpenClaw B",
                channel_base_url="https://example.org",
                channel_account_id="default",
                channel_signing_secret="signing-secret-abcdef",
                callback_token="callback-token-b",
                status="active",
            )
            db.add_all([instance_a, instance_b])
            db.flush()

            source_agent = AgentProfile(
                instance_id=instance_a.id,
                agent_key="main",
                cs_id="CSA-0001",
                display_name="main",
                role_name="项目经理",
                enabled=True,
            )
            target_agent = AgentProfile(
                instance_id=instance_b.id,
                agent_key="testbot2",
                cs_id="CSA-0010",
                display_name="TestBot2",
                role_name="执行工程师",
                enabled=True,
            )
            db.add_all([source_agent, target_agent])
            db.commit()

        with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-send-text"})):
            response = self.client.post(
                "/api/v1/clawswarm/send-text",
                headers={"authorization": "Bearer callback-token-a"},
                json={
                    "kind": "agent_dialogue.start",
                    "sourceCsId": "CSA-0001",
                    "targetCsId": "CSA-0010",
                    "topic": "讨论登录接口",
                    "message": "我需要你确认登录接口字段和返回结构。",
                    "windowSeconds": 300,
                    "softMessageLimit": 12,
                    "hardMessageLimit": 20,
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])

        with self.SessionLocal() as db:
            dialogue = db.get(AgentDialogue, payload["dialogueId"])
            self.assertIsNotNone(dialogue)
            assert dialogue is not None
            self.assertEqual(dialogue.initiator_type, "agent")
            self.assertGreater(dialogue.conversation_id, 0)

            opening_message = db.get(Message, payload["openingMessageId"])
            self.assertIsNotNone(opening_message)
            assert opening_message is not None
            self.assertEqual(opening_message.sender_type, "agent")
            self.assertEqual(opening_message.sender_label, "main")
            self.assertEqual(opening_message.content, "我需要你确认登录接口字段和返回结构。")

    def test_send_text_allows_repeated_same_payload_without_duplicate_message_id(self) -> None:
        with self.SessionLocal() as db:
            instance_a = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-a",
                status="active",
            )
            instance_b = OpenClawInstance(
                name="OpenClaw B",
                channel_base_url="https://example.org",
                channel_account_id="default",
                channel_signing_secret="signing-secret-abcdef",
                callback_token="callback-token-b",
                status="active",
            )
            db.add_all([instance_a, instance_b])
            db.flush()

            source_agent = AgentProfile(
                instance_id=instance_a.id,
                agent_key="main",
                cs_id="CSA-0001",
                display_name="main",
                role_name="项目经理",
                enabled=True,
            )
            target_agent = AgentProfile(
                instance_id=instance_b.id,
                agent_key="testbot2",
                cs_id="CSA-0009",
                display_name="TestBot2",
                role_name="执行工程师",
                enabled=True,
            )
            db.add_all([source_agent, target_agent])
            db.commit()

        request_payload = {
            "kind": "agent_dialogue.start",
            "sourceCsId": "CSA-0001",
            "targetCsId": "CSA-0009",
            "topic": "重复发送测试",
            "message": "同样内容重复发送两次。",
            "windowSeconds": 300,
            "softMessageLimit": 12,
            "hardMessageLimit": 20,
        }

        with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-send-text"})):
            first = self.client.post(
                "/api/v1/clawswarm/send-text",
                headers={"authorization": "Bearer callback-token-a"},
                json=request_payload,
            )
            second = self.client.post(
                "/api/v1/clawswarm/send-text",
                headers={"authorization": "Bearer callback-token-a"},
                json=request_payload,
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)

        first_payload = first.json()
        second_payload = second.json()
        self.assertNotEqual(first_payload["openingMessageId"], second_payload["openingMessageId"])

        with self.SessionLocal() as db:
            first_message = db.get(Message, first_payload["openingMessageId"])
            second_message = db.get(Message, second_payload["openingMessageId"])
            self.assertIsNotNone(first_message)
            self.assertIsNotNone(second_message)
            assert first_message is not None
            assert second_message is not None
            self.assertEqual(first_message.content, request_payload["message"])
            self.assertEqual(second_message.content, request_payload["message"])

    def test_send_text_routes_default_user_target_to_direct_conversation(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-a",
                status="active",
            )
            db.add(instance)
            db.flush()
            instance_id = instance.id

            source_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                cs_id="CSA-0001",
                display_name="main",
                role_name="项目经理",
                enabled=True,
            )
            db.add(source_agent)
            db.flush()
            source_agent_id = source_agent.id
            db.commit()

        response = self.client.post(
            "/api/v1/clawswarm/send-text",
            headers={"authorization": "Bearer callback-token-a"},
            json={
                "kind": "agent_dialogue.start",
                "sourceCsId": "CSA-0001",
                "targetCsId": "CSU-0001",
                "topic": "请求确认",
                "message": "请查看当前交付物并确认。",
                "windowSeconds": 300,
                "softMessageLimit": 12,
                "hardMessageLimit": 20,
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertIn("conversationId", payload)
        self.assertIn("openingMessageId", payload)

        with self.SessionLocal() as db:
            conversation = db.get(Conversation, payload["conversationId"])
            self.assertIsNotNone(conversation)
            assert conversation is not None
            self.assertEqual(conversation.type, "direct")
            self.assertEqual(conversation.direct_instance_id, instance_id)
            self.assertEqual(conversation.direct_agent_id, source_agent_id)

            opening_message = db.get(Message, payload["openingMessageId"])
            self.assertIsNotNone(opening_message)
            assert opening_message is not None
            self.assertEqual(opening_message.conversation_id, conversation.id)
            self.assertEqual(opening_message.sender_type, "agent")
            self.assertEqual(opening_message.sender_label, "main")
            self.assertEqual(opening_message.content, "请查看当前交付物并确认。")

            dialogues = list(db.scalars(select(AgentDialogue)))
            self.assertEqual(dialogues, [])

    def test_send_text_reuses_direct_conversation_for_default_user_target(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-a",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                cs_id="CSA-0001",
                display_name="main",
                role_name="项目经理",
                enabled=True,
            )
            db.add(source_agent)
            db.flush()

            existing_conversation = Conversation(
                type="direct",
                title=f"{instance.name} / {source_agent.display_name}",
                direct_instance_id=instance.id,
                direct_agent_id=source_agent.id,
            )
            db.add(existing_conversation)
            db.commit()

        request_payload = {
            "kind": "agent_dialogue.start",
            "sourceCsId": "CSA-0001",
            "targetCsId": "CSU-0001",
            "topic": "请求确认",
            "message": "请查看当前交付物并确认。",
            "windowSeconds": 300,
            "softMessageLimit": 12,
            "hardMessageLimit": 20,
        }

        first = self.client.post(
            "/api/v1/clawswarm/send-text",
            headers={"authorization": "Bearer callback-token-a"},
            json=request_payload,
        )
        second = self.client.post(
            "/api/v1/clawswarm/send-text",
            headers={"authorization": "Bearer callback-token-a"},
            json=request_payload,
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["conversationId"], second.json()["conversationId"])

    def test_instance_fetch_channel_agents_uses_extended_timeout(self) -> None:
        instance = OpenClawInstance(
            name="OpenClaw A",
            channel_base_url="http://172.16.200.119:28789",
            channel_account_id="default",
            channel_signing_secret="signing-secret-123456",
            callback_token="callback-token-123",
            status="active",
        )

        client = unittest.mock.MagicMock()
        client.__enter__.return_value = client
        client.get.side_effect = [
            unittest.mock.Mock(
                raise_for_status=unittest.mock.Mock(),
                json=unittest.mock.Mock(return_value={"ok": True}),
            ),
            unittest.mock.Mock(
                raise_for_status=unittest.mock.Mock(),
                json=unittest.mock.Mock(
                    return_value=[{"id": "main", "name": "main", "openclawAgentRef": "main"}]
                ),
            ),
        ]

        with patch.object(instances_route.httpx, "Client", return_value=client) as client_factory:
            payload = instances_route.fetch_channel_agents(instance.channel_base_url)

        self.assertEqual(payload, [{"id": "main", "name": "main", "openclawAgentRef": "main"}])
        client_factory.assert_called_once()
        timeout = client_factory.call_args.kwargs["timeout"]
        self.assertEqual(timeout, 60.0)

    def test_update_instance_allows_duplicate_name(self) -> None:
        with self.SessionLocal() as db:
            first = OpenClawInstance(
                name="OpenClaw Deferred Connect",
                instance_key="inst-1",
                channel_base_url="http://172.16.200.119:18789",
                channel_account_id="default",
                channel_signing_secret="signing-secret-1",
                callback_token="callback-token-1",
                status="active",
            )
            second = OpenClawInstance(
                name="OC2",
                instance_key="inst-2",
                channel_base_url="http://172.16.200.119:28789",
                channel_account_id="default",
                channel_signing_secret="signing-secret-2",
                callback_token="callback-token-2",
                status="active",
            )
            db.add_all([first, second])
            db.commit()
            first_id = first.id

        response = self.client.put(
            f"/api/instances/{first_id}",
            json={"name": "OC2"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "OC2")
        self.assertEqual(response.json()["instance_key"], "inst-1")

    def test_connect_instance_allows_same_name_for_different_channel_base_url(self) -> None:
        first = self.client.post(
            "/api/instances/connect",
            json={
                "name": "OpenClaw",
                "channel_base_url": "http://172.16.200.119:18789",
                "channel_account_id": "default",
            },
        )
        second = self.client.post(
            "/api/instances/connect",
            json={
                "name": "OpenClaw",
                "channel_base_url": "http://172.16.200.119:28789",
                "channel_account_id": "default",
            },
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)

        first_payload = first.json()
        second_payload = second.json()
        self.assertNotEqual(first_payload["instance"]["id"], second_payload["instance"]["id"])
        self.assertNotEqual(first_payload["instance"]["instance_key"], second_payload["instance"]["instance_key"])
        self.assertEqual(first_payload["instance"]["name"], "OpenClaw")
        self.assertEqual(second_payload["instance"]["name"], "OpenClaw")


    def test_agent_dialogue_intervention_dispatches_to_next_agent_when_active(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(instance_id=instance.id, agent_key="a", display_name="A", role_name=None, enabled=True)
            target_agent = AgentProfile(instance_id=instance.id, agent_key="b", display_name="B", role_name=None, enabled=True)
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(type="agent_dialogue", title="A ↔ B")
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="测试插话",
                status="active",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
                last_speaker_agent_id=source_agent.id,
            )
            db.add(dialogue)
            db.commit()
            dialogue_id = dialogue.id
            conversation_id = conversation.id
            target_agent_id = target_agent.id

        with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-intervention"})):
            response = self.client.post(
                f"/api/agent-dialogues/{dialogue_id}/messages",
                json={"content": "请换个角度继续讨论"},
            )

        self.assertEqual(response.status_code, 200)
        with self.SessionLocal() as db:
            messages = db.scalars(
                select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at)
            ).all()
            self.assertEqual(messages[-1].sender_type, "user")
            self.assertEqual(messages[-1].content, "请换个角度继续讨论")

            dispatches = db.scalars(
                select(MessageDispatch).where(MessageDispatch.conversation_id == conversation_id).order_by(MessageDispatch.created_at)
            ).all()
            self.assertEqual(len(dispatches), 1)
            self.assertEqual(dispatches[0].dispatch_mode, "agent_dialogue_intervention")
            self.assertEqual(dispatches[0].agent_id, target_agent_id)
            self.assertEqual(dispatches[0].status, "accepted")

    def test_agent_dialogue_intervention_reopens_completed_dialogue(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(instance_id=instance.id, agent_key="a", display_name="A", role_name=None, enabled=True)
            target_agent = AgentProfile(instance_id=instance.id, agent_key="b", display_name="B", role_name=None, enabled=True)
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(type="agent_dialogue", title="A ↔ B")
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="测试续一轮",
                status="completed",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
                last_speaker_agent_id=target_agent.id,
            )
            db.add(dialogue)
            db.commit()
            dialogue_id = dialogue.id
            conversation_id = conversation.id
            source_agent_id = source_agent.id

        with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-reopen"})):
            response = self.client.post(
                f"/api/agent-dialogues/{dialogue_id}/messages",
                json={"content": "继续接龙"},
            )

        self.assertEqual(response.status_code, 200)
        with self.SessionLocal() as db:
            dialogue = db.get(AgentDialogue, dialogue_id)
            self.assertIsNotNone(dialogue)
            assert dialogue is not None
            self.assertEqual(dialogue.status, "active")
            self.assertEqual(dialogue.window_seconds, 300)

            dispatches = db.scalars(
                select(MessageDispatch).where(MessageDispatch.conversation_id == conversation_id).order_by(MessageDispatch.created_at)
            ).all()
            self.assertEqual(len(dispatches), 1)
            self.assertEqual(dispatches[0].dispatch_mode, "agent_dialogue_intervention")
            self.assertEqual(dispatches[0].agent_id, source_agent_id)

    def test_agent_dialogue_soft_limit_warns_but_keeps_running(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(instance_id=instance.id, agent_key="a", display_name="A", role_name=None, enabled=True)
            target_agent = AgentProfile(instance_id=instance.id, agent_key="b", display_name="B", role_name=None, enabled=True)
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(type="agent_dialogue", title="A ↔ B")
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="测试软阈值",
                status="active",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=2,
                hard_message_limit=4,
                soft_limit_warned_at=None,
            )
            db.add(dialogue)
            db.flush()

            opening_message = Message(
                id="msg_turn_opening",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="开始讨论",
                status="completed",
            )
            db.add(opening_message)
            first_dispatch = MessageDispatch(
                id="dsp_turn_source",
                message_id=opening_message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=source_agent.id,
                dispatch_mode="agent_dialogue_opening",
                channel_message_id=opening_message.id,
                status="completed",
            )
            db.add(first_dispatch)
            source_reply = Message(
                id="msg_turn_source_reply",
                conversation_id=conversation.id,
                sender_type="agent",
                sender_label="A",
                content="我是 A",
                status="completed",
            )
            db.add(source_reply)
            db.commit()

            with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-turn-source"})):
                dispatch_id = self._run_async(
                    continue_agent_dialogue_after_reply(
                        db=db,
                        dialogue=dialogue,
                        dispatch=first_dispatch,
                        reply_message=source_reply,
                    )
                )
            self.assertIsNotNone(dispatch_id)
            self.assertEqual(dialogue.last_speaker_agent_id, source_agent.id)
            self.assertEqual(dialogue.status, "active")
            self.assertIsNotNone(dialogue.soft_limit_warned_at)

            warning = db.scalar(
                select(Message)
                .where(Message.conversation_id == conversation.id)
                .where(Message.sender_type == "system")
            )
            self.assertIsNotNone(warning)
            assert warning is not None
            self.assertIn("短时间内对话次数较多", warning.content)

    def test_agent_dialogue_hard_limit_stops_relay(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(instance_id=instance.id, agent_key="a", display_name="A", role_name=None, enabled=True)
            target_agent = AgentProfile(instance_id=instance.id, agent_key="b", display_name="B", role_name=None, enabled=True)
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(type="agent_dialogue", title="A ↔ B")
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="测试硬阈值",
                status="active",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=2,
                hard_message_limit=3,
                soft_limit_warned_at=None,
            )
            db.add(dialogue)
            db.flush()

            now = datetime.utcnow()
            recent_user = Message(
                id="msg_recent_user",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="第一条",
                status="completed",
            )
            recent_agent = Message(
                id="msg_recent_agent",
                conversation_id=conversation.id,
                sender_type="agent",
                sender_label="A",
                content="第二条",
                status="completed",
            )
            target_reply = Message(
                id="msg_turn_target_reply",
                conversation_id=conversation.id,
                sender_type="agent",
                sender_label="B",
                content="第三条",
                status="completed",
            )
            db.add_all([recent_user, recent_agent, target_reply])
            db.flush()
            for message in (recent_user, recent_agent, target_reply):
                message.created_at = now
                message.updated_at = now

            second_dispatch = MessageDispatch(
                id="dsp_turn_target",
                message_id=recent_agent.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=target_agent.id,
                dispatch_mode="agent_dialogue_relay",
                channel_message_id=recent_agent.id,
                status="completed",
            )
            db.add(second_dispatch)
            db.commit()

            with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-turn-target"})):
                relay_id = self._run_async(
                    continue_agent_dialogue_after_reply(
                        db=db,
                        dialogue=dialogue,
                        dispatch=second_dispatch,
                        reply_message=target_reply,
                    )
                )
            self.assertIsNone(relay_id)
            self.assertEqual(dialogue.status, "stopped")

    def test_agent_dialogue_relay_wraps_partner_context(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="liaotian",
                cs_id="CSA-0006",
                display_name="liaotian",
                role_name="聊天专家",
                enabled=True,
            )
            target_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="testbot",
                cs_id="CSA-0009",
                display_name="TestBot",
                role_name="测试专家",
                enabled=True,
            )
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(type="agent_dialogue", title="liaotian ↔ TestBot")
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="继续接龙",
                status="active",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
                last_speaker_agent_id=source_agent.id,
            )
            db.add(dialogue)
            db.flush()

            previous_message = Message(
                id="msg_dialogue_previous",
                conversation_id=conversation.id,
                sender_type="agent",
                sender_label="liaotian",
                content="那我们继续接龙吧。",
                status="completed",
            )
            db.add(previous_message)
            db.commit()

            mocked_send = AsyncMock(return_value={"traceId": "trace-context"})
            with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=mocked_send):
                response = self.client.post(f"/api/agent-dialogues/{dialogue.id}/messages", json={"content": "继续接龙"})

            self.assertEqual(response.status_code, 200)
            mocked_send.assert_awaited_once()
            payload = mocked_send.await_args.kwargs["payload"]
            self.assertEqual(payload["directAgentId"], "testbot")
            self.assertIn("[ClawSwarm Agent Dialogue]", payload["text"])
            self.assertIn("Dialogue ID: AD-", payload["text"])
            self.assertIn("Your identity: TestBot (CSA-0009)", payload["text"])
            self.assertIn("Current partner: liaotian (CSA-0006)", payload["text"])
            self.assertIn("Human guidance from User (CSU-0001):", payload["text"])
            self.assertIn("继续接龙", payload["text"])

    def test_resume_agent_dialogue_dispatches_latest_pending_agent_message(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(instance_id=instance.id, agent_key="a", display_name="A", role_name=None, enabled=True)
            target_agent = AgentProfile(instance_id=instance.id, agent_key="b", display_name="B", role_name=None, enabled=True)
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(type="agent_dialogue", title="A ↔ B")
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="测试恢复",
                status="paused",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
                last_speaker_agent_id=source_agent.id,
            )
            db.add(dialogue)
            db.flush()

            db.add(
                Message(
                    id="msg_agent_pending_001",
                    conversation_id=conversation.id,
                    sender_type="agent",
                    sender_label="A",
                    content="这是暂停期间收到的回复",
                    status="completed",
                )
            )
            db.commit()
            dialogue_id = dialogue.id
            conversation_id = conversation.id
            target_agent_id = target_agent.id

        with patch("src.services.agent_dialogue_runner.channel_client.send_inbound", new=AsyncMock(return_value={"traceId": "trace-resume"})):
            response = self.client.post(f"/api/agent-dialogues/{dialogue_id}/resume")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "active")
        with self.SessionLocal() as db:
            dispatches = db.scalars(
                select(MessageDispatch).where(MessageDispatch.conversation_id == conversation_id).order_by(MessageDispatch.created_at)
            ).all()
            self.assertEqual(len(dispatches), 1)
            self.assertEqual(dispatches[0].dispatch_mode, "agent_dialogue_relay")
            self.assertEqual(dispatches[0].agent_id, target_agent_id)
            self.assertEqual(dispatches[0].status, "accepted")

    def test_list_conversations_includes_agent_dialogue_summary(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            source_agent = AgentProfile(instance_id=instance.id, agent_key="liaotian", display_name="liaotian", role_name=None, enabled=True)
            target_agent = AgentProfile(instance_id=instance.id, agent_key="weather", display_name="weather", role_name=None, enabled=True)
            db.add_all([source_agent, target_agent])
            db.flush()

            conversation = Conversation(type="agent_dialogue", title=None)
            db.add(conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=conversation.id,
                source_agent_id=source_agent.id,
                target_agent_id=target_agent.id,
                topic="讨论天气",
                status="active",
                initiator_type="user",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
                last_speaker_agent_id=source_agent.id,
            )
            db.add(dialogue)
            db.add(
                Message(
                    id="msg_dialogue_001",
                    conversation_id=conversation.id,
                    sender_type="agent",
                    sender_label="liaotian",
                    content="我先抛一个问题。",
                    status="completed",
                )
            )
            db.commit()

        response = self.client.get("/api/conversations")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        dialogue_item = next(item for item in payload if item["type"] == "agent_dialogue")
        self.assertEqual(dialogue_item["display_title"], "liaotian / OpenClaw A ↔ weather / OpenClaw A")
        self.assertEqual(dialogue_item["dialogue_status"], "active")
        self.assertEqual(dialogue_item["dialogue_window_seconds"], 300)
        self.assertEqual(dialogue_item["dialogue_soft_message_limit"], 12)
        self.assertEqual(dialogue_item["dialogue_hard_message_limit"], 20)

    def test_list_conversations_deduplicates_agent_dialogues_by_participants(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            first_agent = AgentProfile(instance_id=instance.id, agent_key="a", display_name="liaotian", role_name=None, enabled=True)
            second_agent = AgentProfile(instance_id=instance.id, agent_key="b", display_name="TestBot2", role_name=None, enabled=True)
            db.add_all([first_agent, second_agent])
            db.flush()

            old_conversation = Conversation(type="agent_dialogue", title="old")
            new_conversation = Conversation(type="agent_dialogue", title="new")
            db.add_all([old_conversation, new_conversation])
            db.flush()

            db.add_all(
                [
                    AgentDialogue(
                        conversation_id=old_conversation.id,
                        source_agent_id=first_agent.id,
                        target_agent_id=second_agent.id,
                        topic="旧会话",
                        status="completed",
                        initiator_type="user",
                        window_seconds=300,
                        soft_message_limit=12,
                        hard_message_limit=20,
                        soft_limit_warned_at=None,
                        last_speaker_agent_id=first_agent.id,
                    ),
                    AgentDialogue(
                        conversation_id=new_conversation.id,
                        source_agent_id=second_agent.id,
                        target_agent_id=first_agent.id,
                        topic="新会话",
                        status="active",
                        initiator_type="user",
                        window_seconds=300,
                        soft_message_limit=12,
                        hard_message_limit=20,
                        soft_limit_warned_at=None,
                        last_speaker_agent_id=second_agent.id,
                    ),
                ]
            )
            db.flush()

            db.add_all(
                [
                    Message(
                        id="msg_old_dialogue",
                        conversation_id=old_conversation.id,
                        sender_type="agent",
                        sender_label="liaotian",
                        content="旧消息",
                        status="completed",
                    ),
                    Message(
                        id="msg_new_dialogue",
                        conversation_id=new_conversation.id,
                        sender_type="agent",
                        sender_label="TestBot2",
                        content="新消息",
                        status="completed",
                    ),
                ]
            )
            db.commit()

        response = self.client.get("/api/conversations")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        dialogue_items = [item for item in payload if item["type"] == "agent_dialogue"]
        self.assertEqual(len(dialogue_items), 1)
        self.assertEqual(dialogue_items[0]["last_message_preview"], "新消息")

    def test_list_conversation_messages_supports_incremental_polling(self) -> None:
        """
        首次全量后，后续带 cursor 只应返回新增消息和新增 dispatch。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            first_message = Message(
                id="msg_001",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="第一条消息",
                status="completed",
            )
            first_dispatch = MessageDispatch(
                id="dsp_001",
                message_id=first_message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=agent.id,
                dispatch_mode="direct",
                channel_message_id=first_message.id,
                status="completed",
            )
            db.add_all([first_message, first_dispatch])
            db.commit()
            conversation_id = conversation.id

        first_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(first_response.status_code, 200)
        first_payload = first_response.json()
        self.assertEqual(len(first_payload["messages"]), 1)
        self.assertEqual(len(first_payload["dispatches"]), 1)
        self.assertEqual(first_payload["next_message_cursor"], "msg_001")
        self.assertEqual(first_payload["next_dispatch_cursor"], "dsp_001")

        with self.SessionLocal() as db:
            second_message = Message(
                id="msg_002",
                conversation_id=conversation.id,
                sender_type="agent",
                sender_label="Main Agent",
                content="第二条消息",
                status="completed",
            )
            second_dispatch = MessageDispatch(
                id="dsp_002",
                message_id="msg_001",
                conversation_id=conversation.id,
                instance_id=1,
                agent_id=1,
                dispatch_mode="direct",
                channel_message_id="msg_001",
                status="completed",
            )
            db.add_all([second_message, second_dispatch])
            db.commit()

        incremental_response = self.client.get(
            f"/api/conversations/{conversation_id}/messages",
            params={"messageAfter": "msg_001", "dispatchAfter": "dsp_001"},
        )
        self.assertEqual(incremental_response.status_code, 200)
        incremental_payload = incremental_response.json()
        # 真实聊天里 assistant 消息会被 chunk 持续更新同一条记录，
        # 所以第一阶段改成“每次返回当前会话完整列表”，
        # 由前端按 id merge，避免遗漏同一条消息的后续内容。
        self.assertEqual([item["id"] for item in incremental_payload["messages"]], ["msg_001", "msg_002"])
        self.assertEqual([item["id"] for item in incremental_payload["dispatches"]], ["dsp_001", "dsp_002"])
        self.assertEqual(incremental_payload["next_message_cursor"], "msg_002")
        self.assertEqual(incremental_payload["next_dispatch_cursor"], "dsp_002")
        self.assertEqual(incremental_payload["messages"][1]["parts"][0]["kind"], "markdown")

    def test_list_conversation_messages_returns_recent_page_by_default(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            for index in range(1, 6):
                db.add(
                    Message(
                        id=f"msg_{index:03d}",
                        conversation_id=conversation.id,
                        sender_type="user",
                        sender_label="User",
                        content=f"message {index}",
                        status="completed",
                    )
                )
            db.commit()
            conversation_id = conversation.id

        response = self.client.get(f"/api/conversations/{conversation_id}/messages?limit=2")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["messages"]], ["msg_004", "msg_005"])
        self.assertTrue(payload["has_more_messages"])
        self.assertEqual(payload["oldest_loaded_message_id"], "msg_004")

    def test_list_conversation_messages_can_load_older_page(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            for index in range(1, 6):
                db.add(
                    Message(
                        id=f"msg_{index:03d}",
                        conversation_id=conversation.id,
                        sender_type="user",
                        sender_label="User",
                        content=f"message {index}",
                        status="completed",
                    )
                )
            db.commit()
            conversation_id = conversation.id

        response = self.client.get(
            f"/api/conversations/{conversation_id}/messages?limit=2&beforeMessageId=msg_004&includeDispatches=false"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["messages"]], ["msg_002", "msg_003"])
        self.assertTrue(payload["has_more_messages"])
        self.assertEqual(payload["oldest_loaded_message_id"], "msg_002")
        self.assertEqual(payload["dispatches"], [])

    def test_message_response_exposes_attachment_parts(self) -> None:
        """
        兼容升级阶段里，后端应该继续保留 content，
        但同时把附件标记拆成 parts，方便前端直接渲染。
        """
        with self.SessionLocal() as db:
            conversation = Conversation(type="group", title="富内容群")
            db.add(conversation)
            db.flush()

            db.add(
                Message(
                    id="msg_attachment_001",
                    conversation_id=conversation.id,
                    sender_type="agent",
                    sender_label="Agent",
                    content=(
                        "请查看下面的附件。\n\n"
                        "[[attachment:测试报告.pdf|application/pdf|https://example.com/report.pdf]]"
                    ),
                    status="completed",
                )
            )
            db.commit()
            conversation_id = conversation.id

        response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["messages"]), 1)

        message = payload["messages"][0]
        self.assertEqual(message["content"], "请查看下面的附件。\n\n[[attachment:测试报告.pdf|application/pdf|https://example.com/report.pdf]]")
        self.assertEqual(message["parts"][0]["kind"], "markdown")
        self.assertEqual(message["parts"][0]["content"], "请查看下面的附件。")
        self.assertEqual(message["parts"][1]["kind"], "attachment")
        self.assertEqual(message["parts"][1]["name"], "测试报告.pdf")
        self.assertEqual(message["parts"][1]["mime_type"], "application/pdf")
        self.assertEqual(message["parts"][1]["url"], "https://example.com/report.pdf")

    def test_message_response_exposes_tool_card_parts(self) -> None:
        """
        工具摘要卡片也应该通过 parts 暴露给前端，
        这样消息页才能逐步对齐 OpenClaw 风格的结构化执行结果。
        """
        with self.SessionLocal() as db:
            conversation = Conversation(type="group", title="工具结果群")
            db.add(conversation)
            db.flush()

            db.add(
                Message(
                    id="msg_tool_001",
                    conversation_id=conversation.id,
                    sender_type="agent",
                    sender_label="Agent",
                    content=(
                        "下面是本次巡检摘要。\n\n"
                        "[[tool:预发巡检|completed|共检查 12 项，全部正常]]"
                    ),
                    status="completed",
                )
            )
            db.commit()
            conversation_id = conversation.id

        response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["messages"]), 1)

        message = payload["messages"][0]
        self.assertEqual(message["parts"][0]["kind"], "markdown")
        self.assertEqual(message["parts"][0]["content"], "下面是本次巡检摘要。")
        self.assertEqual(message["parts"][1]["kind"], "tool_card")
        self.assertEqual(message["parts"][1]["title"], "预发巡检")
        self.assertEqual(message["parts"][1]["status"], "completed")
        self.assertEqual(message["parts"][1]["summary"], "共检查 12 项，全部正常")

    def test_webchat_mirror_appends_agent_message_to_existing_direct_conversation(self) -> None:
        """
        OpenClaw Web UI 里的 agent 回复，应能追加镜像到现有 direct conversation。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            db.add(
                Message(
                    id="msg_existing_001",
                    conversation_id=conversation.id,
                    sender_type="user",
                    sender_label="User",
                    content="旧消息",
                    status="completed",
                )
            )
            db.commit()
            conversation_id = conversation.id

        response = self.client.post(
            "/api/v1/clawswarm/webchat-mirror",
            headers={"Authorization": "Bearer callback-token-123"},
            json={
                "channelId": "webchat",
                "sessionKey": "agent:main:main",
                "messageId": "webchat-msg-001",
                "senderType": "assistant",
                "content": "这是从 OpenClaw Web UI 镜像过来的回复",
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["conversationId"], conversation_id)
        self.assertTrue(payload["messageId"].startswith("msg_web_"))

        messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(messages_response.status_code, 200)
        messages_payload = messages_response.json()
        self.assertEqual(messages_payload["messages"][0]["id"], "msg_existing_001")
        self.assertEqual(messages_payload["messages"][1]["id"], payload["messageId"])
        self.assertEqual(messages_payload["messages"][1]["sender_type"], "agent")
        self.assertEqual(messages_payload["messages"][1]["sender_label"], "Main Agent")
        self.assertEqual(messages_payload["messages"][1]["source"], "webchat")
        self.assertEqual(messages_payload["messages"][1]["content"], "这是从 OpenClaw Web UI 镜像过来的回复")

    def test_webchat_mirror_is_idempotent_for_same_provider_message(self) -> None:
        """
        同一个 WebChat provider message 重复投递时，不应重复生成镜像消息。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.commit()
            conversation_id = conversation.id

        request_payload = {
            "channelId": "webchat",
            "sessionKey": "agent:main:main",
            "messageId": "webchat-msg-002",
            "senderType": "assistant",
            "content": "重复事件也只应保留一条消息",
        }
        headers = {"Authorization": "Bearer callback-token-123"}

        first = self.client.post("/api/v1/clawswarm/webchat-mirror", headers=headers, json=request_payload)
        second = self.client.post("/api/v1/clawswarm/webchat-mirror", headers=headers, json=request_payload)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)

        messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(messages_response.status_code, 200)
        messages_payload = messages_response.json()
        mirrored = [item for item in messages_payload["messages"] if item["sender_type"] == "agent"]
        self.assertEqual(len(mirrored), 1)
        self.assertTrue(mirrored[0]["id"].startswith("msg_web_"))
        self.assertEqual(mirrored[0]["content"], "重复事件也只应保留一条消息")

    def test_webchat_mirror_persists_user_message_into_existing_direct_conversation(self) -> None:
        """
        Web UI 中用户自己发出的消息，也应该追加进同一条 direct conversation。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.commit()
            conversation_id = conversation.id

        response = self.client.post(
            "/api/v1/clawswarm/webchat-mirror",
            headers={"Authorization": "Bearer callback-token-123"},
            json={
                "channelId": "webchat",
                "sessionKey": "agent:main:main",
                "messageId": "webchat-msg-user-001",
                "senderType": "user",
                "content": "大兴天气",
            },
        )
        self.assertEqual(response.status_code, 200)

        messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(messages_response.status_code, 200)
        messages_payload = messages_response.json()
        mirrored = messages_payload["messages"][0]
        self.assertEqual(mirrored["sender_type"], "user")
        self.assertEqual(mirrored["sender_label"], "User (CSU-0001)")
        self.assertEqual(mirrored["source"], "webchat")
        self.assertEqual(mirrored["content"], "大兴天气")

    def test_webchat_mirror_uses_payload_timestamp_for_created_at_and_ordering(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.commit()
            conversation_id = conversation.id

        later_ms = 1_700_000_000_000
        earlier_ms = later_ms - 60_000
        headers = {"Authorization": "Bearer callback-token-123"}

        first = self.client.post(
            "/api/v1/clawswarm/webchat-mirror",
            headers=headers,
            json={
                "channelId": "webchat",
                "sessionKey": "agent:main:main",
                "messageId": "webchat-msg-later",
                "senderType": "assistant",
                "content": "较晚的消息",
                "timestamp": later_ms,
            },
        )
        second = self.client.post(
            "/api/v1/clawswarm/webchat-mirror",
            headers=headers,
            json={
                "channelId": "webchat",
                "sessionKey": "agent:main:main",
                "messageId": "webchat-msg-earlier",
                "senderType": "assistant",
                "content": "较早的消息",
                "timestamp": earlier_ms,
            },
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)

        messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(messages_response.status_code, 200)
        messages_payload = messages_response.json()
        self.assertEqual([item["content"] for item in messages_payload["messages"]], ["较早的消息", "较晚的消息"])
        self.assertTrue(messages_payload["messages"][0]["created_at"].startswith("2023-11-14T22:12:20"))
        self.assertTrue(messages_payload["messages"][1]["created_at"].startswith("2023-11-14T22:13:20"))

    def test_callback_is_idempotent_for_duplicate_reply_final(self) -> None:
        """
        同一个 reply.final 重复投递时，不应重复生成 agent 消息，也不应重复写 callback event。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            message = Message(
                id="msg_user_001",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="请回复我",
                status="accepted",
            )
            dispatch = MessageDispatch(
                id="dsp_user_001",
                message_id=message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=agent.id,
                dispatch_mode="direct",
                channel_message_id=message.id,
                status="accepted",
            )
            db.add_all([message, dispatch])
            db.commit()

        body = {
            "eventId": "evt_final_001",
            "eventType": "reply.final",
            "correlation": {
                "messageId": "msg_user_001",
                "agentId": "main",
                "sessionKey": "clawswarm:test",
            },
            "payload": {"text": "这是最终回复"},
        }
        headers = {"Authorization": "Bearer callback-token-123"}

        first = self.client.post("/api/v1/clawswarm/events", json=body, headers=headers)
        second = self.client.post("/api/v1/clawswarm/events", json=body, headers=headers)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)

        with self.SessionLocal() as db:
            callback_events = list(db.scalars(select(MessageCallbackEvent)))
            agent_messages = list(db.scalars(select(Message).where(Message.sender_type == "agent")))
            updated_dispatch = db.get(MessageDispatch, "dsp_user_001")
            updated_user_message = db.get(Message, "msg_user_001")

            self.assertEqual(len(callback_events), 1)
            self.assertEqual(len(agent_messages), 1)
            self.assertEqual(agent_messages[0].content, "这是最终回复")
            self.assertEqual(updated_dispatch.status, "completed")
            self.assertEqual(updated_dispatch.session_key, "clawswarm:test")
            self.assertEqual(updated_user_message.status, "completed")

    def test_send_message_uses_local_agent_mock_when_enabled(self) -> None:
        """
        本地联调模式下，即使不连 OpenClaw / channel，
        发送消息后也应该能由 scheduler-server 自己生成 agent 回复。
        """
        original_flag = settings.local_agent_mock_enabled
        settings.local_agent_mock_enabled = True
        try:
            with self.SessionLocal() as db:
                instance = OpenClawInstance(
                    name="OpenClaw A",
                    channel_base_url="https://example.com",
                    channel_account_id="default",
                    channel_signing_secret="signing-secret-123456",
                    callback_token="callback-token-123",
                    status="active",
                )
                db.add(instance)
                db.flush()

                agent = AgentProfile(
                    instance_id=instance.id,
                    agent_key="ops-agent",
                    display_name="Lyra 运维",
                    role_name="ops",
                    enabled=True,
                )
                db.add(agent)
                db.flush()

                conversation = Conversation(
                    type="direct",
                    title="OpenClaw A / Lyra 运维",
                    direct_instance_id=instance.id,
                    direct_agent_id=agent.id,
                )
                db.add(conversation)
                db.commit()
                conversation_id = conversation.id

            response = self.client.post(
                f"/api/conversations/{conversation_id}/messages",
                json={"content": "请给我一份巡检摘要", "mentions": []},
            )
            self.assertEqual(response.status_code, 200)

            messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
            self.assertEqual(messages_response.status_code, 200)
            payload = messages_response.json()
            self.assertEqual(len(payload["messages"]), 2)

            agent_messages = [item for item in payload["messages"] if item["sender_type"] == "agent"]
            self.assertEqual(len(agent_messages), 1)
            self.assertTrue(any(part["kind"] == "tool_card" for part in agent_messages[0]["parts"]))
            self.assertTrue(any(part["kind"] == "attachment" for part in agent_messages[0]["parts"]))
        finally:
            settings.local_agent_mock_enabled = original_flag

    def test_group_dispatch_injects_group_context_per_target_agent(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Group",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            pm = AgentProfile(
                instance_id=instance.id,
                agent_key="pm",
                display_name="项目经理",
                role_name="项目经理",
                enabled=True,
                cs_id="CSA-0001",
            )
            engineer = AgentProfile(
                instance_id=instance.id,
                agent_key="execution-engineer",
                display_name="执行工程师",
                role_name="执行工程师",
                enabled=True,
                cs_id="CSA-0002",
            )
            db.add_all([pm, engineer])
            db.flush()

            group = ChatGroup(name="小项目群", description="测试群聊上下文")
            db.add(group)
            db.flush()

            db.add_all(
                [
                    ChatGroupMember(group_id=group.id, instance_id=instance.id, agent_id=pm.id),
                    ChatGroupMember(group_id=group.id, instance_id=instance.id, agent_id=engineer.id),
                ]
            )
            db.flush()

            conversation = Conversation(type="group", title="小项目群", group_id=group.id)
            db.add(conversation)
            db.commit()
            conversation_id = conversation.id

        mocked_send = AsyncMock(return_value={"traceId": "trace-group-context"})
        with patch("src.api.routes.conversations.channel_client.send_inbound", new=mocked_send):
            response = self.client.post(
                f"/api/conversations/{conversation_id}/messages",
                json={"content": "请先分别介绍自己，再说明你负责什么。", "mentions": []},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(mocked_send.await_count, 2)

        first_payload = mocked_send.await_args_list[0].kwargs["payload"]
        second_payload = mocked_send.await_args_list[1].kwargs["payload"]

        self.assertEqual(first_payload["chat"]["type"], "group")
        self.assertEqual(second_payload["chat"]["type"], "group")
        self.assertEqual(first_payload["targetAgentIds"], ["pm"])
        self.assertEqual(second_payload["targetAgentIds"], ["execution-engineer"])

        self.assertIn("[ClawSwarm Group Context]", first_payload["text"])
        self.assertIn("Group: 小项目群", first_payload["text"])
        self.assertIn("Your identity: 项目经理 (项目经理, CSA-0001)", first_payload["text"])
        self.assertIn("执行工程师 (执行工程师, CSA-0002)", first_payload["text"])
        self.assertIn("Current speaker: User (CSU-0001)", first_payload["text"])

        self.assertIn("Your identity: 执行工程师 (执行工程师, CSA-0002)", second_payload["text"])
        self.assertIn("项目经理 (项目经理, CSA-0001)", second_payload["text"])
        self.assertIn("Instruction:", second_payload["text"])

    def test_delete_group_removes_group_conversation_history(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Group",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="pm",
                display_name="项目经理",
                role_name="项目经理",
                enabled=True,
                cs_id="CSA-0001",
            )
            db.add(agent)
            db.flush()

            group = ChatGroup(name="待删除群", description="删除群测试")
            db.add(group)
            db.flush()

            member = ChatGroupMember(group_id=group.id, instance_id=instance.id, agent_id=agent.id)
            conversation = Conversation(type="group", title="待删除群", group_id=group.id)
            db.add_all([member, conversation])
            db.flush()

            message = Message(
                id="msg_group_delete_1",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="请删除这个群",
                status="completed",
            )
            db.add(message)
            db.flush()

            dispatch = MessageDispatch(
                id="dsp_group_delete_1",
                message_id=message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=agent.id,
                dispatch_mode="group_broadcast",
                status="completed",
            )
            db.add(dispatch)
            db.flush()

            callback = MessageCallbackEvent(
                dispatch_id=dispatch.id,
                event_id="evt_group_delete_1",
                event_type="reply.final",
                payload_json={"text": "done"},
            )
            db.add(callback)
            db.commit()
            group_id = group.id
            conversation_id = conversation.id

        response = self.client.delete(f"/api/groups/{group_id}")
        self.assertEqual(response.status_code, 204)

        with self.SessionLocal() as db:
            self.assertIsNone(db.get(ChatGroup, group_id))
            self.assertIsNone(db.scalar(select(ChatGroupMember).where(ChatGroupMember.group_id == group_id)))
            self.assertIsNone(db.get(Conversation, conversation_id))
            self.assertIsNone(db.get(Message, "msg_group_delete_1"))
            self.assertIsNone(db.get(MessageDispatch, "dsp_group_delete_1"))
            self.assertIsNone(db.scalar(select(MessageCallbackEvent).where(MessageCallbackEvent.event_id == "evt_group_delete_1")))

    def test_sync_removed_agent_deletes_contact_conversation_history(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            removed_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="execution-engineer",
                display_name="执行工程师",
                role_name="执行工程师",
                enabled=True,
                cs_id="CSA-0009",
            )
            kept_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="project-manager",
                display_name="项目经理",
                role_name="项目经理",
                enabled=True,
                cs_id="CSA-0010",
            )
            db.add_all([removed_agent, kept_agent])
            db.flush()

            conversation = Conversation(
                type="direct",
                title=f"{instance.name} / {removed_agent.display_name}",
                direct_instance_id=instance.id,
                direct_agent_id=removed_agent.id,
            )
            db.add(conversation)
            db.flush()

            message = Message(
                id="msg_removed_agent_1",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="这条记录应该被清掉",
                status="completed",
            )
            db.add(message)
            db.flush()

            dispatch = MessageDispatch(
                id="dsp_removed_agent_1",
                message_id=message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=removed_agent.id,
                dispatch_mode="direct",
                status="completed",
            )
            db.add(dispatch)
            db.flush()

            callback = MessageCallbackEvent(
                dispatch_id=dispatch.id,
                event_id="evt_removed_agent_1",
                event_type="reply.final",
                payload_json={"text": "done"},
            )
            db.add(callback)
            dialogue_conversation = Conversation(
                type="agent_dialogue",
                title="执行工程师 ↔ 项目经理",
            )
            db.add(dialogue_conversation)
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=dialogue_conversation.id,
                source_agent_id=removed_agent.id,
                target_agent_id=kept_agent.id,
                topic="待清理的历史协作",
                status="active",
                initiator_type="agent",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
            )
            db.add(dialogue)
            db.flush()

            dialogue_message = Message(
                id="msg_removed_dialogue_1",
                conversation_id=dialogue_conversation.id,
                sender_type="agent",
                sender_label=removed_agent.display_name,
                content="这条协作记录也应该被清掉",
                status="completed",
            )
            db.add(dialogue_message)
            db.flush()

            dialogue_dispatch = MessageDispatch(
                id="dsp_removed_dialogue_1",
                message_id=dialogue_message.id,
                conversation_id=dialogue_conversation.id,
                instance_id=instance.id,
                agent_id=removed_agent.id,
                dispatch_mode="direct",
                status="completed",
            )
            db.add(dialogue_dispatch)
            db.flush()

            dialogue_callback = MessageCallbackEvent(
                dispatch_id=dialogue_dispatch.id,
                event_id="evt_removed_dialogue_1",
                event_type="reply.final",
                payload_json={"text": "done"},
            )
            db.add(dialogue_callback)
            db.commit()
            removed_agent_id = removed_agent.id
            conversation_id = conversation.id
            dialogue_conversation_id = dialogue_conversation.id

            sync_instance_agents(
                db,
                instance,
                [
                    {
                        "id": kept_agent.agent_key,
                        "name": kept_agent.display_name,
                    }
                ],
            )
            db.commit()

        with self.SessionLocal() as db:
            removed_agent = db.get(AgentProfile, removed_agent_id)
            assert removed_agent is not None
            self.assertTrue(removed_agent.removed_from_openclaw)
            self.assertIsNone(db.get(Conversation, conversation_id))
            self.assertIsNone(db.get(Conversation, dialogue_conversation_id))
            self.assertIsNone(db.get(Message, "msg_removed_agent_1"))
            self.assertIsNone(db.get(Message, "msg_removed_dialogue_1"))
            self.assertIsNone(db.get(MessageDispatch, "dsp_removed_agent_1"))
            self.assertIsNone(db.get(MessageDispatch, "dsp_removed_dialogue_1"))
            self.assertIsNone(db.scalar(select(MessageCallbackEvent).where(MessageCallbackEvent.event_id == "evt_removed_agent_1")))
            self.assertIsNone(db.scalar(select(MessageCallbackEvent).where(MessageCallbackEvent.event_id == "evt_removed_dialogue_1")))
            self.assertIsNone(db.scalar(select(AgentDialogue).where(AgentDialogue.conversation_id == dialogue_conversation_id)))

        response = self.client.get("/api/conversations")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_instance_sync_agents_also_deletes_removed_agent_contact_history(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw B",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            removed_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="testbot2",
                display_name="TestBot2",
                role_name="测试 Bot",
                enabled=True,
                cs_id="CSA-0010",
            )
            kept_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="main",
                role_name="助手",
                enabled=True,
                cs_id="CSA-0001",
            )
            db.add_all([removed_agent, kept_agent])
            db.flush()

            direct_conversation = Conversation(
                type="direct",
                title=f"{instance.name} / {removed_agent.display_name}",
                direct_instance_id=instance.id,
                direct_agent_id=removed_agent.id,
            )
            dialogue_conversation = Conversation(
                type="agent_dialogue",
                title="main ↔ TestBot2",
            )
            db.add_all([direct_conversation, dialogue_conversation])
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=dialogue_conversation.id,
                source_agent_id=kept_agent.id,
                target_agent_id=removed_agent.id,
                topic="测试残留清理",
                status="active",
                initiator_type="agent",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
            )
            db.add(dialogue)
            db.flush()

            direct_message = Message(
                id="msg_testbot2_direct_1",
                conversation_id=direct_conversation.id,
                sender_type="agent",
                sender_label="TestBot2",
                content="direct",
                status="completed",
            )
            dialogue_message = Message(
                id="msg_testbot2_dialogue_1",
                conversation_id=dialogue_conversation.id,
                sender_type="agent",
                sender_label="TestBot2",
                content="dialogue",
                status="completed",
            )
            db.add_all([direct_message, dialogue_message])
            db.flush()

            direct_dispatch = MessageDispatch(
                id="dsp_testbot2_direct_1",
                message_id=direct_message.id,
                conversation_id=direct_conversation.id,
                instance_id=instance.id,
                agent_id=removed_agent.id,
                dispatch_mode="direct",
                status="completed",
            )
            dialogue_dispatch = MessageDispatch(
                id="dsp_testbot2_dialogue_1",
                message_id=dialogue_message.id,
                conversation_id=dialogue_conversation.id,
                instance_id=instance.id,
                agent_id=removed_agent.id,
                dispatch_mode="agent_dialogue_relay",
                status="completed",
            )
            db.add_all([direct_dispatch, dialogue_dispatch])
            db.flush()

            db.add_all(
                [
                    MessageCallbackEvent(
                        dispatch_id=direct_dispatch.id,
                        event_id="evt_testbot2_direct_1",
                        event_type="reply.final",
                        payload_json={"text": "done"},
                    ),
                    MessageCallbackEvent(
                        dispatch_id=dialogue_dispatch.id,
                        event_id="evt_testbot2_dialogue_1",
                        event_type="reply.final",
                        payload_json={"text": "done"},
                    ),
                ]
            )
            db.commit()
            instance_id = instance.id

        with patch("src.api.routes.instances.fetch_channel_agents", return_value=[{"id": "main", "name": "main"}]):
            response = self.client.post(f"/api/instances/{instance_id}/sync-agents")

        self.assertEqual(response.status_code, 200)

        with self.SessionLocal() as db:
            removed_agent = db.scalar(select(AgentProfile).where(AgentProfile.agent_key == "testbot2"))
            assert removed_agent is not None
            self.assertTrue(removed_agent.removed_from_openclaw)
            self.assertEqual(
                list(
                    db.scalars(
                        select(Conversation.id).where(
                            (Conversation.direct_agent_id == removed_agent.id)
                            | (Conversation.title == "main ↔ TestBot2")
                        )
                    )
                ),
                [],
            )

        conversations_response = self.client.get("/api/conversations")
        self.assertEqual(conversations_response.status_code, 200)
        payload = conversations_response.json()
        self.assertFalse(any("TestBot2" in (item.get("display_title") or "") for item in payload))

    def test_delete_instance_removes_private_history_but_keeps_group_history(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Delete Target",
                channel_base_url="https://delete.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            peer_instance = OpenClawInstance(
                name="Peer OpenClaw",
                channel_base_url="https://peer.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-abcdef",
                callback_token="callback-token-456",
                status="active",
            )
            db.add_all([instance, peer_instance])
            db.flush()

            deleted_agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Delete Me",
                role_name="assistant",
                enabled=True,
                cs_id="CSA-DEL-001",
            )
            peer_agent = AgentProfile(
                instance_id=peer_instance.id,
                agent_key="peer",
                display_name="Peer Agent",
                role_name="assistant",
                enabled=True,
                cs_id="CSA-PEER-001",
            )
            db.add_all([deleted_agent, peer_agent])
            db.flush()

            direct_conversation = Conversation(
                type="direct",
                title="Delete Me Direct",
                direct_instance_id=instance.id,
                direct_agent_id=deleted_agent.id,
            )
            dialogue_conversation = Conversation(
                type="agent_dialogue",
                title="Delete Me ↔ Peer Agent",
            )
            group = ChatGroup(name="Keep Group", description="群和群消息应保留")
            db.add_all([direct_conversation, dialogue_conversation, group])
            db.flush()

            group_conversation = Conversation(type="group", title="Keep Group", group_id=group.id)
            db.add(group_conversation)
            db.flush()

            db.add_all(
                [
                    ChatGroupMember(group_id=group.id, instance_id=instance.id, agent_id=deleted_agent.id),
                    ChatGroupMember(group_id=group.id, instance_id=peer_instance.id, agent_id=peer_agent.id),
                ]
            )
            db.flush()

            dialogue = AgentDialogue(
                conversation_id=dialogue_conversation.id,
                source_agent_id=deleted_agent.id,
                target_agent_id=peer_agent.id,
                topic="shared dialogue",
                status="active",
                initiator_type="agent",
                window_seconds=300,
                soft_message_limit=12,
                hard_message_limit=20,
                soft_limit_warned_at=None,
            )
            db.add(dialogue)
            db.flush()

            direct_message = Message(
                id="msg_delete_instance_direct_1",
                conversation_id=direct_conversation.id,
                sender_type="user",
                sender_label="User",
                content="delete direct",
                status="completed",
            )
            dialogue_message = Message(
                id="msg_delete_instance_dialogue_1",
                conversation_id=dialogue_conversation.id,
                sender_type="agent",
                sender_label="Delete Me",
                content="delete dialogue",
                status="completed",
            )
            group_message = Message(
                id="msg_delete_instance_group_1",
                conversation_id=group_conversation.id,
                sender_type="agent",
                sender_label="Delete Me",
                content="keep group",
                status="completed",
            )
            db.add_all([direct_message, dialogue_message, group_message])
            db.flush()

            direct_dispatch = MessageDispatch(
                id="dsp_delete_instance_direct_1",
                message_id=direct_message.id,
                conversation_id=direct_conversation.id,
                instance_id=instance.id,
                agent_id=deleted_agent.id,
                dispatch_mode="direct",
                status="completed",
            )
            dialogue_dispatch = MessageDispatch(
                id="dsp_delete_instance_dialogue_1",
                message_id=dialogue_message.id,
                conversation_id=dialogue_conversation.id,
                instance_id=instance.id,
                agent_id=deleted_agent.id,
                dispatch_mode="agent_dialogue_relay",
                status="completed",
            )
            group_dispatch = MessageDispatch(
                id="dsp_delete_instance_group_1",
                message_id=group_message.id,
                conversation_id=group_conversation.id,
                instance_id=instance.id,
                agent_id=deleted_agent.id,
                dispatch_mode="group_broadcast",
                status="completed",
            )
            db.add_all([direct_dispatch, dialogue_dispatch, group_dispatch])
            db.flush()

            db.add_all(
                [
                    MessageCallbackEvent(
                        dispatch_id=direct_dispatch.id,
                        event_id="evt_delete_instance_direct_1",
                        event_type="reply.final",
                        payload_json={"text": "done"},
                    ),
                    MessageCallbackEvent(
                        dispatch_id=dialogue_dispatch.id,
                        event_id="evt_delete_instance_dialogue_1",
                        event_type="reply.final",
                        payload_json={"text": "done"},
                    ),
                    MessageCallbackEvent(
                        dispatch_id=group_dispatch.id,
                        event_id="evt_delete_instance_group_1",
                        event_type="reply.final",
                        payload_json={"text": "done"},
                    ),
                ]
            )
            db.commit()
            instance_id = instance.id
            deleted_agent_id = deleted_agent.id
            peer_agent_id = peer_agent.id
            direct_conversation_id = direct_conversation.id
            dialogue_conversation_id = dialogue_conversation.id
            group_id = group.id
            group_conversation_id = group_conversation.id

        response = self.client.delete(f"/api/instances/{instance_id}")
        self.assertEqual(response.status_code, 204)

        with self.SessionLocal() as db:
            self.assertIsNone(db.get(OpenClawInstance, instance_id))
            self.assertIsNone(db.get(AgentProfile, deleted_agent_id))
            self.assertIsNone(db.get(Conversation, direct_conversation_id))
            self.assertIsNone(db.get(Conversation, dialogue_conversation_id))
            self.assertIsNone(db.get(Message, "msg_delete_instance_direct_1"))
            self.assertIsNone(db.get(Message, "msg_delete_instance_dialogue_1"))
            self.assertIsNone(db.get(MessageDispatch, "dsp_delete_instance_direct_1"))
            self.assertIsNone(db.get(MessageDispatch, "dsp_delete_instance_dialogue_1"))
            self.assertIsNone(
                db.scalar(select(MessageCallbackEvent).where(MessageCallbackEvent.event_id == "evt_delete_instance_direct_1"))
            )
            self.assertIsNone(
                db.scalar(select(MessageCallbackEvent).where(MessageCallbackEvent.event_id == "evt_delete_instance_dialogue_1"))
            )
            self.assertIsNone(db.scalar(select(AgentDialogue).where(AgentDialogue.conversation_id == dialogue_conversation_id)))

            self.assertIsNotNone(db.get(ChatGroup, group_id))
            self.assertIsNotNone(db.get(Conversation, group_conversation_id))
            self.assertIsNotNone(db.get(Message, "msg_delete_instance_group_1"))
            self.assertIsNotNone(db.get(MessageDispatch, "dsp_delete_instance_group_1"))
            self.assertIsNotNone(
                db.scalar(select(MessageCallbackEvent).where(MessageCallbackEvent.event_id == "evt_delete_instance_group_1"))
            )
            self.assertIsNone(
                db.scalar(
                    select(ChatGroupMember).where(
                        ChatGroupMember.group_id == group_id,
                        ChatGroupMember.agent_id == deleted_agent_id,
                    )
                )
            )
            self.assertIsNotNone(db.get(AgentProfile, peer_agent_id))

    def test_list_instances_returns_static_status_and_health_endpoint_returns_runtime_status(self) -> None:
        with self.SessionLocal() as db:
            active_instance = OpenClawInstance(
                name="OpenClaw Active",
                channel_base_url="https://active.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            offline_instance = OpenClawInstance(
                name="OpenClaw Offline",
                channel_base_url="https://offline.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            disabled_instance = OpenClawInstance(
                name="OpenClaw Disabled",
                channel_base_url="https://disabled.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="disabled",
            )
            db.add_all([active_instance, offline_instance, disabled_instance])
            db.commit()
            active_id = active_instance.id
            offline_id = offline_instance.id
            disabled_id = disabled_instance.id

        def fake_probe(base_url: str) -> bool:
            return "active.example.com" in base_url

        with patch("src.api.routes.instances.probe_channel_health", side_effect=fake_probe):
            list_response = self.client.get("/api/instances")
            health_response = self.client.get("/api/instances/health")

        self.assertEqual(list_response.status_code, 200)
        list_payload = {item["id"]: item for item in list_response.json()}
        self.assertEqual(list_payload[active_id]["status"], "active")
        self.assertEqual(list_payload[offline_id]["status"], "active")
        self.assertEqual(list_payload[disabled_id]["status"], "disabled")

        self.assertEqual(health_response.status_code, 200)
        health_payload = {item["id"]: item for item in health_response.json()}
        self.assertEqual(health_payload[active_id]["status"], "active")
        self.assertEqual(health_payload[offline_id]["status"], "offline")
        self.assertEqual(health_payload[disabled_id]["status"], "disabled")

        with self.SessionLocal() as db:
            self.assertEqual(db.get(OpenClawInstance, active_id).status, "active")
            self.assertEqual(db.get(OpenClawInstance, offline_id).status, "active")
            self.assertEqual(db.get(OpenClawInstance, disabled_id).status, "disabled")

    def test_connect_instance_generates_separate_credentials_and_returns_them(self) -> None:
        with patch("src.api.routes.instances.fetch_channel_agents", return_value=[{"id": "main", "name": "Main"}]):
            response = self.client.post(
                "/api/instances/connect",
                json={
                    "name": "OpenClaw Connect",
                    "channel_base_url": "https://example.com",
                    "channel_account_id": "default",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIn("credentials", payload)
        self.assertIn("outbound_token", payload["credentials"])
        self.assertIn("inbound_signing_secret", payload["credentials"])
        self.assertNotEqual(payload["credentials"]["outbound_token"], payload["credentials"]["inbound_signing_secret"])

        with self.SessionLocal() as db:
            instance = db.scalar(select(OpenClawInstance).where(OpenClawInstance.name == "OpenClaw Connect"))
            assert instance is not None
            self.assertEqual(instance.callback_token, payload["credentials"]["outbound_token"])
            self.assertEqual(instance.channel_signing_secret, payload["credentials"]["inbound_signing_secret"])

    def test_connect_instance_still_creates_credentials_when_channel_is_not_ready(self) -> None:
        with patch(
            "src.api.routes.instances.fetch_channel_agents",
            side_effect=HTTPException(status_code=503, detail="OpenClaw instance is unreachable"),
        ):
            response = self.client.post(
                "/api/instances/connect",
                json={
                    "name": "OpenClaw Deferred Connect",
                    "channel_base_url": "https://example.com",
                    "channel_account_id": "default",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["imported_agent_count"], 0)
        self.assertEqual(payload["agent_keys"], [])
        self.assertTrue(payload["credentials"]["outbound_token"])
        self.assertTrue(payload["credentials"]["inbound_signing_secret"])

        with self.SessionLocal() as db:
            instance = db.scalar(select(OpenClawInstance).where(OpenClawInstance.name == "OpenClaw Deferred Connect"))
            assert instance is not None
            self.assertEqual(instance.callback_token, payload["credentials"]["outbound_token"])
            self.assertEqual(instance.channel_signing_secret, payload["credentials"]["inbound_signing_secret"])

    def test_send_direct_message_returns_clear_detail_when_channel_signature_mismatch(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Auth",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw Auth / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.commit()
            conversation_id = conversation.id

        request = httpx.Request("POST", "https://example.com/clawswarm/v1/inbound")
        response = httpx.Response(status_code=401, request=request)
        with patch(
            "src.integrations.channel_client.httpx.AsyncClient.request",
            new=AsyncMock(side_effect=httpx.HTTPStatusError("401 Unauthorized", request=request, response=response)),
        ):
            result = self.client.post(
                f"/api/conversations/{conversation_id}/messages",
                json={"content": "你好"},
            )

        self.assertEqual(result.status_code, 400, result.text)
        self.assertEqual(result.json()["detail"], "OpenClaw instance signature mismatch")

    def test_sync_agents_returns_clear_detail_when_channel_is_unreachable(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Offline",
                channel_base_url="https://offline.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.commit()
            instance_id = instance.id

        connect_error = httpx.ConnectError("connect failed")
        mocked_client = unittest.mock.MagicMock()
        mocked_client.get.side_effect = connect_error

        with patch("src.api.routes.instances.httpx.Client") as client_cls:
            client_cls.return_value.__enter__.return_value = mocked_client
            result = self.client.post(f"/api/instances/{instance_id}/sync-agents")

        self.assertEqual(result.status_code, 503, result.text)
        self.assertEqual(result.json()["detail"], "OpenClaw instance is unreachable")

    def test_sync_agents_returns_clear_detail_when_channel_times_out(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Timeout",
                channel_base_url="https://timeout.example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.commit()
            instance_id = instance.id

        timeout_error = httpx.ReadTimeout("timed out")
        mocked_client = unittest.mock.MagicMock()
        mocked_client.get.side_effect = timeout_error

        with patch("src.api.routes.instances.httpx.Client") as client_cls:
            client_cls.return_value.__enter__.return_value = mocked_client
            result = self.client.post(f"/api/instances/{instance_id}/sync-agents")

        self.assertEqual(result.status_code, 504, result.text)
        self.assertEqual(result.json()["detail"], "OpenClaw timed out")

    def test_settings_default_database_url_uses_persistent_app_data_path(self) -> None:
        config_module = importlib.import_module("src.core.config")
        self.assertEqual(config_module.DEFAULT_CONTAINER_DATABASE_URL, "sqlite:////opt/clawswarm/app.db")
        self.assertEqual(config_module.DEFAULT_LOCAL_DATABASE_URL, "sqlite:///./data/app.db")

    def test_app_serves_built_web_client_when_dist_directory_exists(self) -> None:
        web_dist = Path(self.temp_dir.name) / "web-dist"
        assets_dir = web_dist / "assets"
        assets_dir.mkdir(parents=True)
        (web_dist / "index.html").write_text(
            "<!doctype html><html><body><div id='app'>clawswarm</div></body></html>",
            encoding="utf-8",
        )
        (assets_dir / "app.js").write_text("console.log('ok')", encoding="utf-8")

        settings.web_dist_dir = str(web_dist)
        app = create_app()
        client = TestClient(app)

        root_response = client.get("/")
        route_response = client.get("/messages/conversation/1")
        asset_response = client.get("/assets/app.js")
        api_response = client.get("/api/health")

        self.assertEqual(root_response.status_code, 200)
        self.assertIn("clawswarm", root_response.text)
        self.assertEqual(route_response.status_code, 200)
        self.assertIn("clawswarm", route_response.text)
        self.assertEqual(asset_response.status_code, 200)
        self.assertIn("console.log", asset_response.text)
        self.assertEqual(api_response.status_code, 200)

    def test_get_instance_credentials_returns_current_copy_values(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Credentials",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.commit()
            instance_id = instance.id

        response = self.client.get(f"/api/instances/{instance_id}/credentials")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {
                "outbound_token": "callback-token-123",
                "inbound_signing_secret": "signing-secret-123456",
            },
        )

    def test_create_group_can_include_initial_members(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            pm = AgentProfile(
                instance_id=instance.id,
                agent_key="project-manager",
                display_name="项目经理",
                role_name="项目经理",
                enabled=True,
            )
            engineer = AgentProfile(
                instance_id=instance.id,
                agent_key="execution-engineer",
                display_name="执行工程师",
                role_name="执行工程师",
                enabled=True,
            )
            db.add_all([pm, engineer])
            db.commit()
            instance_id = instance.id
            pm_id = pm.id
            engineer_id = engineer.id

        response = self.client.post(
            "/api/groups",
            json={
                "name": "新项目群",
                "description": "创建时直接带成员",
                "members": [
                    {"instance_id": instance_id, "agent_id": pm_id},
                    {"instance_id": instance_id, "agent_id": engineer_id},
                ],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        group_id = response.json()["id"]

        with self.SessionLocal() as db:
            group = db.get(ChatGroup, group_id)
            self.assertIsNotNone(group)
            members = list(
                db.scalars(
                    select(ChatGroupMember)
                    .where(ChatGroupMember.group_id == group_id)
                    .order_by(ChatGroupMember.id)
                )
            )
            self.assertEqual(len(members), 2)
            self.assertEqual({member.agent_id for member in members}, {pm_id, engineer_id})

    def test_callback_reply_final_with_parts_is_exposed_as_rich_message(self) -> None:
        """
        当 channel 回调里已经带了结构化 parts 时，
        scheduler-server 应该优先保留这些信息，而不是退回成纯文本。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw A",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw A / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            message = Message(
                id="msg_user_parts_001",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="请给我巡检摘要",
                status="accepted",
            )
            dispatch = MessageDispatch(
                id="dsp_user_parts_001",
                message_id=message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=agent.id,
                dispatch_mode="direct",
                channel_message_id=message.id,
                status="accepted",
            )
            db.add_all([message, dispatch])
            db.commit()
            conversation_id = conversation.id

        body = {
            "eventId": "evt_final_parts_001",
            "eventType": "reply.final",
            "correlation": {
                "messageId": "msg_user_parts_001",
                "agentId": "main",
                "sessionKey": "clawswarm:test-parts",
            },
            "payload": {
                "text": "巡检摘要如下",
                "parts": [
                    {"kind": "markdown", "content": "巡检摘要如下。"},
                    {"kind": "tool_card", "title": "预发巡检", "status": "completed", "summary": "共检查 12 项，全部正常"},
                    {
                        "kind": "attachment",
                        "name": "巡检报告.pdf",
                        "mimeType": "application/pdf",
                        "url": "https://example.com/report.pdf",
                    },
                ],
            },
        }
        headers = {"Authorization": "Bearer callback-token-123"}

        response = self.client.post("/api/v1/clawswarm/events", json=body, headers=headers)
        self.assertEqual(response.status_code, 200)

        messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(messages_response.status_code, 200)
        payload = messages_response.json()

        agent_messages = [item for item in payload["messages"] if item["sender_type"] == "agent"]
        self.assertEqual(len(agent_messages), 1)
        rich_message = agent_messages[0]
        self.assertEqual(rich_message["parts"][0]["kind"], "markdown")
        self.assertEqual(rich_message["parts"][0]["content"], "巡检摘要如下。")
        self.assertEqual(rich_message["parts"][1]["kind"], "tool_card")
        self.assertEqual(rich_message["parts"][1]["title"], "预发巡检")
        self.assertEqual(rich_message["parts"][1]["status"], "completed")
        self.assertEqual(rich_message["parts"][2]["kind"], "attachment")
        self.assertEqual(rich_message["parts"][2]["name"], "巡检报告.pdf")
        self.assertEqual(rich_message["parts"][2]["mime_type"], "application/pdf")

    def test_callback_reply_chunk_creates_and_updates_streaming_agent_message(self) -> None:
        """
        为了配合 WebSocket 实时展示，reply.chunk 到来时就应该生成/更新 agent 消息，
        而不是等到 reply.final 才一次性出现。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Stream",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw Stream / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            user_message = Message(
                id="msg_user_stream_001",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="请流式回复",
                status="accepted",
            )
            dispatch = MessageDispatch(
                id="dsp_user_stream_001",
                message_id=user_message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=agent.id,
                dispatch_mode="direct",
                channel_message_id=user_message.id,
                status="accepted",
            )
            db.add_all([user_message, dispatch])
            db.commit()
            conversation_id = conversation.id

        headers = {"Authorization": "Bearer callback-token-123"}

        first_chunk = self.client.post(
            "/api/v1/clawswarm/events",
            json={
                "eventId": "evt_chunk_001",
                "eventType": "reply.chunk",
                "correlation": {
                    "messageId": "msg_user_stream_001",
                    "agentId": "main",
                    "sessionKey": "agent:main:main",
                },
                "payload": {"text": "第一段"},
            },
            headers=headers,
        )
        self.assertEqual(first_chunk.status_code, 200)

        second_chunk = self.client.post(
            "/api/v1/clawswarm/events",
            json={
                "eventId": "evt_chunk_002",
                "eventType": "reply.chunk",
                "correlation": {
                    "messageId": "msg_user_stream_001",
                    "agentId": "main",
                    "sessionKey": "agent:main:main",
                },
                "payload": {"text": "第二段"},
            },
            headers=headers,
        )
        self.assertEqual(second_chunk.status_code, 200)

        interim_messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(interim_messages_response.status_code, 200)
        interim_payload = interim_messages_response.json()
        interim_agent_messages = [item for item in interim_payload["messages"] if item["sender_type"] == "agent"]
        self.assertEqual(len(interim_agent_messages), 1)
        self.assertEqual(interim_agent_messages[0]["status"], "streaming")
        self.assertEqual(interim_agent_messages[0]["content"], "第一段第二段")

        final_response = self.client.post(
            "/api/v1/clawswarm/events",
            json={
                "eventId": "evt_final_stream_001",
                "eventType": "reply.final",
                "correlation": {
                    "messageId": "msg_user_stream_001",
                    "agentId": "main",
                    "sessionKey": "agent:main:main",
                },
                "payload": {"text": "第一段第二段，最终完成"},
            },
            headers=headers,
        )
        self.assertEqual(final_response.status_code, 200)

        final_messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(final_messages_response.status_code, 200)
        final_payload = final_messages_response.json()
        final_agent_messages = [item for item in final_payload["messages"] if item["sender_type"] == "agent"]
        self.assertEqual(len(final_agent_messages), 1)
        self.assertEqual(final_agent_messages[0]["status"], "completed")
        self.assertEqual(final_agent_messages[0]["content"], "第一段第二段，最终完成")

    def test_callback_empty_reply_final_does_not_create_empty_agent_message(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Empty Final",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw Empty Final / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            user_message = Message(
                id="msg_user_empty_final_001",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="第二条消息",
                status="accepted",
            )
            dispatch = MessageDispatch(
                id="dsp_user_empty_final_001",
                message_id=user_message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=agent.id,
                dispatch_mode="direct",
                channel_message_id=user_message.id,
                status="accepted",
            )
            db.add_all([user_message, dispatch])
            db.commit()
            conversation_id = conversation.id

        response = self.client.post(
            "/api/v1/clawswarm/events",
            json={
                "eventId": "evt_empty_final_001",
                "eventType": "reply.final",
                "correlation": {
                    "messageId": "msg_user_empty_final_001",
                    "agentId": "main",
                    "sessionKey": "agent:main:main",
                },
                "payload": {"text": ""},
            },
            headers={"Authorization": "Bearer callback-token-123"},
        )
        self.assertEqual(response.status_code, 200)

        messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(messages_response.status_code, 200)
        payload = messages_response.json()
        agent_messages = [item for item in payload["messages"] if item["sender_type"] == "agent"]
        self.assertEqual(agent_messages, [])

    def test_callback_empty_reply_final_keeps_streamed_content(self) -> None:
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Empty Final Stream",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="OpenClaw Empty Final Stream / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            user_message = Message(
                id="msg_user_empty_final_stream_001",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="连续消息",
                status="accepted",
            )
            dispatch = MessageDispatch(
                id="dsp_user_empty_final_stream_001",
                message_id=user_message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=agent.id,
                dispatch_mode="direct",
                channel_message_id=user_message.id,
                status="accepted",
            )
            db.add_all([user_message, dispatch])
            db.commit()
            conversation_id = conversation.id

        headers = {"Authorization": "Bearer callback-token-123"}
        chunk_response = self.client.post(
            "/api/v1/clawswarm/events",
            json={
                "eventId": "evt_empty_final_stream_chunk_001",
                "eventType": "reply.chunk",
                "correlation": {
                    "messageId": "msg_user_empty_final_stream_001",
                    "agentId": "main",
                    "sessionKey": "agent:main:main",
                },
                "payload": {"text": "收到！测试消息 2 ✅ 测试消息 3 ✅"},
            },
            headers=headers,
        )
        self.assertEqual(chunk_response.status_code, 200)

        final_response = self.client.post(
            "/api/v1/clawswarm/events",
            json={
                "eventId": "evt_empty_final_stream_final_001",
                "eventType": "reply.final",
                "correlation": {
                    "messageId": "msg_user_empty_final_stream_001",
                    "agentId": "main",
                    "sessionKey": "agent:main:main",
                },
                "payload": {"text": ""},
            },
            headers=headers,
        )
        self.assertEqual(final_response.status_code, 200)

        messages_response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(messages_response.status_code, 200)
        payload = messages_response.json()
        agent_messages = [item for item in payload["messages"] if item["sender_type"] == "agent"]
        self.assertEqual(len(agent_messages), 1)
        self.assertEqual(agent_messages[0]["content"], "收到！测试消息 2 ✅ 测试消息 3 ✅")
        self.assertEqual(agent_messages[0]["status"], "completed")

    def test_stale_streaming_dispatch_is_finalized_when_loading_messages(self) -> None:
        """
        如果 OpenClaw 在回复过程中重启，dispatch 可能永远停在 streaming。
        会话读取时应当把超时未结束的记录自动收尾，避免前端一直显示“正在回复”。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Recover",
                channel_base_url="https://example.com",
                channel_account_id="default",
                channel_signing_secret="signing-secret-123456",
                callback_token="callback-token-123",
                status="active",
            )
            db.add(instance)
            db.flush()

            agent = AgentProfile(
                instance_id=instance.id,
                agent_key="main",
                display_name="Main Agent",
                role_name="assistant",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            conversation = Conversation(
                type="direct",
                title="Recover / Main Agent",
                direct_instance_id=instance.id,
                direct_agent_id=agent.id,
            )
            db.add(conversation)
            db.flush()

            user_message = Message(
                id="msg_user_recover_001",
                conversation_id=conversation.id,
                sender_type="user",
                sender_label="User",
                content="这条回复被中断了",
                status="streaming",
            )
            dispatch = MessageDispatch(
                id="dsp_user_recover_001",
                message_id=user_message.id,
                conversation_id=conversation.id,
                instance_id=instance.id,
                agent_id=agent.id,
                dispatch_mode="direct",
                channel_message_id=user_message.id,
                status="streaming",
            )
            agent_message = Message(
                id="msg_agent_dsp_user_recover_001",
                conversation_id=conversation.id,
                sender_type="agent",
                sender_label="Main Agent",
                content="回复到一半",
                status="streaming",
            )
            db.add_all([user_message, dispatch, agent_message])
            db.commit()

            old_timestamp = datetime.utcnow() - timedelta(minutes=5)
            dispatch.updated_at = old_timestamp
            user_message.updated_at = old_timestamp
            agent_message.updated_at = old_timestamp
            db.commit()
            conversation_id = conversation.id

        response = self.client.get(f"/api/conversations/{conversation_id}/messages")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        dispatches = {item["id"]: item for item in payload["dispatches"]}
        messages = {item["id"]: item for item in payload["messages"]}

        self.assertEqual(dispatches["dsp_user_recover_001"]["status"], "failed")
        self.assertEqual(messages["msg_user_recover_001"]["status"], "failed")
        self.assertEqual(messages["msg_agent_dsp_user_recover_001"]["status"], "failed")

if __name__ == "__main__":
    unittest.main()
