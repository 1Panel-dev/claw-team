"""
这个文件负责数据库连接和 Session 管理。
第一阶段默认使用 SQLite。
"""
from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine, event, inspect, text
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
engine = create_engine(settings.database_url, echo=False, future=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


if is_sqlite:
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        try:
            # WAL 更适合我们现在这种“读多写多 + callback 并发补写”的场景。
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA synchronous=NORMAL;")
            cursor.execute("PRAGMA foreign_keys=ON;")
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

    if "agent_profiles" in table_names:
        agent_columns = {column["name"] for column in inspector.get_columns("agent_profiles")}
        if "created_via_claw_team" not in agent_columns:
            statements.append("ALTER TABLE agent_profiles ADD COLUMN created_via_claw_team BOOLEAN DEFAULT 0")
        if "ct_id" not in agent_columns:
            statements.append("ALTER TABLE agent_profiles ADD COLUMN ct_id VARCHAR(32)")
            statements.append("CREATE INDEX IF NOT EXISTS ix_agent_profiles_ct_id ON agent_profiles (ct_id)")

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

    if not statements:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
