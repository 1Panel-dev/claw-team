"""
这些测试覆盖 scheduler-server 第一阶段最关键的后端行为。

当前重点验证：
1. 会话列表接口是否能返回前端侧栏需要的摘要信息。
2. 消息列表接口是否支持最小增量拉取。
3. callback 重复投递时，是否还能保持幂等。
"""
from __future__ import annotations

from datetime import datetime, timedelta
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from src.api.deps import db_session
from src.core.db import Base
from src.main import create_app
from src.models.agent_profile import AgentProfile
from src.models.chat_group import ChatGroup
from src.models.conversation import Conversation
from src.models.message import Message
from src.models.message_callback_event import MessageCallbackEvent
from src.models.message_dispatch import MessageDispatch
from src.models.openclaw_instance import OpenClawInstance
from src.models.task import Task
from src.core.config import settings


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

        def override_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        self.app.dependency_overrides[db_session] = override_db
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.app.dependency_overrides.clear()
        self.engine.dispose()
        self.temp_dir.cleanup()

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
            "/api/v1/claw-team/webchat-mirror",
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

        first = self.client.post("/api/v1/claw-team/webchat-mirror", headers=headers, json=request_payload)
        second = self.client.post("/api/v1/claw-team/webchat-mirror", headers=headers, json=request_payload)
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
            "/api/v1/claw-team/webchat-mirror",
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
        self.assertEqual(mirrored["sender_label"], "User")
        self.assertEqual(mirrored["source"], "webchat")
        self.assertEqual(mirrored["content"], "大兴天气")

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
                "sessionKey": "claw-team:test",
            },
            "payload": {"text": "这是最终回复"},
        }
        headers = {"Authorization": "Bearer callback-token-123"}

        first = self.client.post("/api/v1/claw-team/events", json=body, headers=headers)
        second = self.client.post("/api/v1/claw-team/events", json=body, headers=headers)

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
            self.assertEqual(updated_dispatch.session_key, "claw-team:test")
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
                "sessionKey": "claw-team:test-parts",
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

        response = self.client.post("/api/v1/claw-team/events", json=body, headers=headers)
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
            "/api/v1/claw-team/events",
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
            "/api/v1/claw-team/events",
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
            "/api/v1/claw-team/events",
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

    def test_tasks_crud_roundtrip(self) -> None:
        """
        任务模块第一阶段至少要能真实完成：
        创建、查询、完成。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Tasks",
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
                agent_key="task-agent",
                display_name="任务 Agent",
                role_name="executor",
                enabled=True,
            )
            db.add(agent)
            db.commit()
            instance_id = instance.id
            agent_id = agent.id

        create_response = self.client.post(
            "/api/tasks",
            json={
                "title": "补任务接口",
                "description": "把任务页改成真实后端数据",
                "priority": "high",
                "tags": ["任务", "接口"],
                "assignee_instance_id": instance_id,
                "assignee_agent_id": agent_id,
            },
        )
        self.assertEqual(create_response.status_code, 200)
        created = create_response.json()
        self.assertEqual(created["source"], "server")
        self.assertEqual(created["status"], "in_progress")
        self.assertEqual(created["assignee"]["agent_name"], "任务 Agent")
        self.assertEqual(len(created["timeline"]), 1)

        list_response = self.client.get("/api/tasks", params={"status": "in_progress", "keyword": "任务接口"})
        self.assertEqual(list_response.status_code, 200)
        listed = list_response.json()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], created["id"])

        complete_response = self.client.post(
            f"/api/tasks/{created['id']}/complete",
            json={"comment": "接口已接通"},
        )
        self.assertEqual(complete_response.status_code, 200)
        completed = complete_response.json()
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["comment_count"], 2)
        self.assertEqual(completed["timeline"][-1]["content"], "接口已接通")

        with self.SessionLocal() as db:
            task = db.get(Task, created["id"])
            self.assertIsNotNone(task)
            self.assertEqual(task.status, "completed")

    def test_tasks_support_parent_and_child_structure(self) -> None:
        """
        第一阶段允许两级任务：
        一个父任务下面挂若干子任务，但不能再往下继续拆。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Hierarchy",
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
                agent_key="hierarchy-agent",
                display_name="层级 Agent",
                role_name="executor",
                enabled=True,
            )
            db.add(agent)
            db.commit()
            instance_id = instance.id
            agent_id = agent.id

        create_response = self.client.post(
            "/api/tasks",
            json={
                "title": "完成登录模块收尾",
                "description": "把登录模块收敛到可交付状态。",
                "priority": "high",
                "tags": ["登录"],
                "assignee_instance_id": instance_id,
                "assignee_agent_id": agent_id,
                "children": [
                    {
                        "title": "补齐登录页交互",
                        "description": "完善输入反馈和错误提示。",
                        "priority": "high",
                        "tags": ["前端"],
                    },
                    {
                        "title": "补齐登录测试",
                        "description": "增加关键流程测试覆盖。",
                        "priority": "medium",
                        "tags": ["测试"],
                    },
                ],
            },
        )
        self.assertEqual(create_response.status_code, 200)
        created = create_response.json()
        self.assertIsNone(created["parent_task_id"])
        self.assertEqual(len(created["children"]), 2)
        self.assertEqual(created["children"][0]["parent_task_id"], created["id"])
        self.assertEqual(created["children"][1]["parent_task_id"], created["id"])

        list_response = self.client.get("/api/tasks", params={"status": "all", "keyword": "登录模块"})
        self.assertEqual(list_response.status_code, 200)
        listed = list_response.json()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], created["id"])
        self.assertEqual(len(listed[0]["children"]), 2)

    def test_tasks_reject_third_level_children(self) -> None:
        """
        子任务不允许继续创建孙任务，避免层级无限扩展。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Third Level",
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
                agent_key="nested-agent",
                display_name="嵌套 Agent",
                role_name="executor",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            parent = Task(
                id="task_parent_001",
                title="父任务",
                description="父任务",
                priority="medium",
                status="in_progress",
                source="server",
                assignee_instance_id=instance.id,
                assignee_agent_id=agent.id,
                tags_json='["父任务"]',
                comment_count=1,
            )
            child = Task(
                id="task_child_001",
                parent_task_id=parent.id,
                title="子任务",
                description="子任务",
                priority="medium",
                status="in_progress",
                source="server",
                assignee_instance_id=instance.id,
                assignee_agent_id=agent.id,
                tags_json='["子任务"]',
                comment_count=1,
            )
            db.add_all([parent, child])
            db.commit()
            instance_id = instance.id
            agent_id = agent.id

        response = self.client.post(
            "/api/tasks",
            json={
                "title": "孙任务",
                "description": "不应被允许。",
                "priority": "medium",
                "tags": [],
                "assignee_instance_id": instance_id,
                "assignee_agent_id": agent_id,
                "parent_task_id": "task_child_001",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "third-level tasks are not supported")

    def test_delete_task_removes_direct_children(self) -> None:
        """
        删除父任务时，应一并删除它的直接子任务和时间线事件。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Delete",
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
                agent_key="delete-agent",
                display_name="删除 Agent",
                role_name="executor",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            parent = Task(
                id="task_delete_parent_001",
                title="待删除父任务",
                description="测试删除",
                priority="medium",
                status="in_progress",
                source="server",
                assignee_instance_id=instance.id,
                assignee_agent_id=agent.id,
                tags_json='["删除"]',
                comment_count=1,
            )
            child = Task(
                id="task_delete_child_001",
                parent_task_id=parent.id,
                title="待删除子任务",
                description="测试删除",
                priority="medium",
                status="in_progress",
                source="server",
                assignee_instance_id=instance.id,
                assignee_agent_id=agent.id,
                tags_json='["删除"]',
                comment_count=1,
            )
            db.add_all([parent, child])
            db.commit()

        response = self.client.delete("/api/tasks/task_delete_parent_001")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["task_id"], "task_delete_parent_001")
        self.assertTrue(payload["deleted"])
        self.assertEqual(payload["deleted_child_count"], 1)

        with self.SessionLocal() as db:
            self.assertIsNone(db.get(Task, "task_delete_parent_001"))
            self.assertIsNone(db.get(Task, "task_delete_child_001"))

    def test_task_append_comment(self) -> None:
        """
        Task Skill 需要能给任务追加进展评论，
        所以后端至少要支持追加一条任务时间线事件。
        """
        with self.SessionLocal() as db:
            instance = OpenClawInstance(
                name="OpenClaw Comment",
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
                agent_key="comment-agent",
                display_name="评论 Agent",
                role_name="executor",
                enabled=True,
            )
            db.add(agent)
            db.flush()

            task = Task(
                id="task_comment_001",
                title="补任务评论接口",
                description="让任务支持追加评论",
                priority="medium",
                status="in_progress",
                source="server",
                assignee_instance_id=instance.id,
                assignee_agent_id=agent.id,
                tags_json='["任务"]',
                comment_count=1,
            )
            db.add(task)
            db.commit()

        response = self.client.post(
            "/api/tasks/task_comment_001/comments",
            json={"comment": "已完成接口设计，下一步补 Skill 调用。", "author_type": "agent"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["task_id"], "task_comment_001")
        self.assertEqual(payload["comment_count"], 2)
        self.assertEqual(payload["latest_entry"]["type"], "agent")
        self.assertEqual(payload["latest_entry"]["label"], "Agent 更新")
        self.assertEqual(payload["latest_entry"]["content"], "已完成接口设计，下一步补 Skill 调用。")


if __name__ == "__main__":
    unittest.main()
