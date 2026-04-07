"""
这个文件负责数据库连接和 Session 管理。
第一阶段默认使用 SQLite。
"""
from pathlib import Path
from typing import Generator
from uuid import uuid4

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from src.core.config import settings


Base = declarative_base()


def _prepare_sqlite_path(database_url: str) -> None:
    if database_url.startswith("sqlite:///"):
        raw = database_url.removeprefix("sqlite:///")
        path = Path(raw)
        if not path.is_absolute():
            path = Path.cwd() / path
        path.parent.mkdir(parents=True, exist_ok=True)


_prepare_sqlite_path(settings.database_url)

is_sqlite = settings.database_url.startswith("sqlite")
connect_args = (
    {
        "check_same_thread": False,
        # callback 写入和消息写入会并发打到同一个 SQLite 文件，给它明确的等待窗口，
        # 避免默认超短等待把正常争用直接放大成 "database is locked"。
        "timeout": 30,
    }
    if is_sqlite
    else {}
)
engine = create_engine(
    settings.database_url,
    echo=False,
    future=True,
    connect_args=connect_args,
    poolclass=NullPool if is_sqlite else None,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


if is_sqlite:
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        try:
            # WAL 更适合我们现在这种“读多写多 + callback 并发补写”的场景。
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA synchronous=NORMAL;")
            # 第一阶段先不用数据库强外键，把级联清理放在代码层控制，避免共享数据被底层约束误伤。
            cursor.execute("PRAGMA foreign_keys=OFF;")
            cursor.execute("PRAGMA busy_timeout=30000;")
        finally:
            cursor.close()


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_runtime_schema() -> None:
    """
    第一阶段还没接 Alembic，这里只做非常小的启动期补丁，
    避免已有 SQLite 开发库因为缺少新列而直接报错。
    """
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    statements: list[str] = []

    if "tasks" in table_names:
        columns = {column["name"] for column in inspector.get_columns("tasks")}

        # 旧开发库最开始没有 parent_task_id，这里只补我们当前确实需要的列和索引，
        # 不把启动阶段偷偷演变成一套复杂迁移系统。
        if "parent_task_id" not in columns:
            statements.append("ALTER TABLE tasks ADD COLUMN parent_task_id VARCHAR(64)")
            statements.append("CREATE INDEX IF NOT EXISTS ix_tasks_parent_task_id ON tasks (parent_task_id)")

    if "messages" in table_names:
        message_columns = {column["name"] for column in inspector.get_columns("messages")}
        if "sender_cs_id" not in message_columns:
            statements.append("ALTER TABLE messages ADD COLUMN sender_cs_id VARCHAR(32)")
            statements.append("CREATE INDEX IF NOT EXISTS ix_messages_sender_cs_id ON messages (sender_cs_id)")

    if "agent_profiles" in table_names:
        agent_columns = {column["name"] for column in inspector.get_columns("agent_profiles")}
        if "created_via_clawswarm" not in agent_columns:
            statements.append("ALTER TABLE agent_profiles ADD COLUMN created_via_clawswarm BOOLEAN DEFAULT 0")
        if "cs_id" not in agent_columns:
            statements.append("ALTER TABLE agent_profiles ADD COLUMN cs_id VARCHAR(32)")
            statements.append("CREATE INDEX IF NOT EXISTS ix_agent_profiles_cs_id ON agent_profiles (cs_id)")
        if "removed_from_openclaw" not in agent_columns:
            statements.append("ALTER TABLE agent_profiles ADD COLUMN removed_from_openclaw BOOLEAN DEFAULT 0")

    if "agent_dialogues" not in table_names:
        # 第一阶段直接用启动期补丁兜底，避免老的 SQLite 开发库缺表后整条会话链起不来。
        statements.extend(
            [
                """
                CREATE TABLE IF NOT EXISTS agent_dialogues (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    conversation_id INTEGER NOT NULL,
                    source_agent_id INTEGER NOT NULL,
                    target_agent_id INTEGER NOT NULL,
                    topic VARCHAR(500) NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'active',
                    initiator_type VARCHAR(20) NOT NULL DEFAULT 'user',
                    initiator_agent_id INTEGER NULL,
                    max_turns INTEGER NOT NULL DEFAULT 0,
                    current_turn INTEGER NOT NULL DEFAULT 0,
                    window_seconds INTEGER NOT NULL DEFAULT 300,
                    soft_message_limit INTEGER NOT NULL DEFAULT 12,
                    hard_message_limit INTEGER NOT NULL DEFAULT 20,
                    soft_limit_warned_at DATETIME NULL,
                    last_speaker_agent_id INTEGER NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(conversation_id) REFERENCES conversations (id),
                    FOREIGN KEY(source_agent_id) REFERENCES agent_profiles (id),
                    FOREIGN KEY(target_agent_id) REFERENCES agent_profiles (id),
                    FOREIGN KEY(initiator_agent_id) REFERENCES agent_profiles (id),
                    FOREIGN KEY(last_speaker_agent_id) REFERENCES agent_profiles (id)
                )
                """,
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_agent_dialogues_conversation_id ON agent_dialogues (conversation_id)",
                "CREATE INDEX IF NOT EXISTS ix_agent_dialogues_source_agent_id ON agent_dialogues (source_agent_id)",
                "CREATE INDEX IF NOT EXISTS ix_agent_dialogues_target_agent_id ON agent_dialogues (target_agent_id)",
                "CREATE INDEX IF NOT EXISTS ix_agent_dialogues_initiator_agent_id ON agent_dialogues (initiator_agent_id)",
                "CREATE INDEX IF NOT EXISTS ix_agent_dialogues_last_speaker_agent_id ON agent_dialogues (last_speaker_agent_id)",
            ]
        )
    else:
        dialogue_columns = {column["name"] for column in inspector.get_columns("agent_dialogues")}
        if "window_seconds" not in dialogue_columns:
            statements.append("ALTER TABLE agent_dialogues ADD COLUMN window_seconds INTEGER NOT NULL DEFAULT 300")
        if "soft_message_limit" not in dialogue_columns:
            statements.append("ALTER TABLE agent_dialogues ADD COLUMN soft_message_limit INTEGER NOT NULL DEFAULT 12")
        if "hard_message_limit" not in dialogue_columns:
            statements.append("ALTER TABLE agent_dialogues ADD COLUMN hard_message_limit INTEGER NOT NULL DEFAULT 20")
        if "soft_limit_warned_at" not in dialogue_columns:
            statements.append("ALTER TABLE agent_dialogues ADD COLUMN soft_limit_warned_at DATETIME NULL")

    if "openclaw_instances" in table_names and is_sqlite:
        instance_columns = {column["name"] for column in inspector.get_columns("openclaw_instances")}
        with engine.begin() as connection:
            index_rows = connection.execute(text("PRAGMA index_list('openclaw_instances')")).mappings().all()
            name_is_unique = False
            for row in index_rows:
                if not row.get("unique"):
                    continue
                index_name = row["name"]
                index_info = connection.execute(text(f"PRAGMA index_info('{index_name}')")).mappings().all()
                index_columns = [item["name"] for item in index_info]
                if index_columns == ["name"]:
                    name_is_unique = True
                    break

            if "instance_key" not in instance_columns or name_is_unique:
                connection.execute(text("PRAGMA foreign_keys=OFF"))
                connection.execute(
                    text(
                        """
                        CREATE TABLE IF NOT EXISTS openclaw_instances__new (
                            id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                            instance_key VARCHAR(36) NOT NULL,
                            name VARCHAR(120) NOT NULL,
                            channel_base_url VARCHAR(500) NOT NULL,
                            channel_account_id VARCHAR(120) NOT NULL DEFAULT 'default',
                            channel_signing_secret VARCHAR(255) NOT NULL,
                            callback_token VARCHAR(255) NOT NULL,
                            status VARCHAR(32) NOT NULL DEFAULT 'active',
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        )
                        """
                    )
                )
                rows = connection.execute(
                    text(
                        """
                        SELECT id, name, channel_base_url, channel_account_id,
                               channel_signing_secret, callback_token, status,
                               created_at, updated_at
                        FROM openclaw_instances
                        ORDER BY id
                        """
                    )
                ).mappings().all()
                for row in rows:
                    connection.execute(
                        text(
                            """
                            INSERT INTO openclaw_instances__new (
                                id, instance_key, name, channel_base_url, channel_account_id,
                                channel_signing_secret, callback_token, status, created_at, updated_at
                            ) VALUES (
                                :id, :instance_key, :name, :channel_base_url, :channel_account_id,
                                :channel_signing_secret, :callback_token, :status, :created_at, :updated_at
                            )
                            """
                        ),
                        {
                            "id": row["id"],
                            "instance_key": str(uuid4()),
                            "name": row["name"],
                            "channel_base_url": row["channel_base_url"],
                            "channel_account_id": row["channel_account_id"],
                            "channel_signing_secret": row["channel_signing_secret"],
                            "callback_token": row["callback_token"],
                            "status": row["status"],
                            "created_at": row["created_at"],
                            "updated_at": row["updated_at"],
                        },
                    )
                connection.execute(text("DROP TABLE openclaw_instances"))
                connection.execute(text("ALTER TABLE openclaw_instances__new RENAME TO openclaw_instances"))
                connection.execute(
                    text(
                        "CREATE UNIQUE INDEX IF NOT EXISTS ix_openclaw_instances_instance_key "
                        "ON openclaw_instances (instance_key)"
                    )
                )
                connection.execute(text("PRAGMA foreign_keys=ON"))

    if "app_users" in table_names:
        user_columns = {column["name"] for column in inspector.get_columns("app_users")}
        if "display_name" not in user_columns:
            statements.append("ALTER TABLE app_users ADD COLUMN display_name VARCHAR(120)")
            statements.append("UPDATE app_users SET display_name = username WHERE display_name IS NULL OR display_name = ''")

    if not statements:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
