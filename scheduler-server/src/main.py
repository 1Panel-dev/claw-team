"""
这是 scheduler-server 的 FastAPI 入口。
它负责组装配置、数据库和全部第一阶段 API 路由。
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.api.routes import address_book, agent_dialogues, agents, callbacks, conversations, groups, health, instances, tasks, ws
from src.core.db import Base, engine, ensure_runtime_schema
import src.models  # noqa: F401


def create_app() -> FastAPI:
    app = FastAPI(title="Claw Team Scheduler Server", version="0.1.0")

    # 第一阶段先直接用 create_all 建表，后续再切换到 Alembic 管理迁移。
    Base.metadata.create_all(bind=engine)
    ensure_runtime_schema()

    # 本地前后端联调默认是：
    # - scheduler-server: 127.0.0.1:8080
    # - web-client: localhost/127.0.0.1:5173
    # 这里先显式放开常用开发源，避免浏览器被 CORS 拦住。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://192.168.200.49:5173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(instances.router)
    app.include_router(agents.router)
    app.include_router(agent_dialogues.router)
    app.include_router(address_book.router)
    app.include_router(groups.router)
    app.include_router(conversations.router)
    app.include_router(tasks.router)
    app.include_router(callbacks.router)
    app.include_router(ws.router)

    return app


app = create_app()
