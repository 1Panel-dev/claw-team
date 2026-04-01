"""
这是 scheduler-server 的 FastAPI 入口。
它负责组装配置、数据库和全部第一阶段 API 路由。
"""
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from src.api.routes import address_book, agent_dialogues, agents, callbacks, conversations, groups, health, instances, tasks, ws
from src.core.config import settings
from src.core.db import Base, engine, ensure_runtime_schema
import src.models  # noqa: F401


def _configure_web_client_routes(app: FastAPI) -> None:
    web_dist_dir = Path(settings.web_dist_dir).expanduser()
    index_file = web_dist_dir / "index.html"
    if not index_file.is_file():
        return

    @app.get("/", include_in_schema=False)
    def serve_web_index() -> FileResponse:
        return FileResponse(index_file)

    @app.get("/assets/{asset_path:path}", include_in_schema=False)
    def serve_web_asset(asset_path: str) -> FileResponse:
        asset_file = web_dist_dir / "assets" / asset_path
        if not asset_file.is_file():
            raise HTTPException(status_code=404)
        return FileResponse(asset_file)

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_web_app(full_path: str) -> FileResponse:
        if full_path.startswith(("api/", "ws")):
            raise HTTPException(status_code=404)

        target = web_dist_dir / full_path
        if target.is_file():
            return FileResponse(target)
        return FileResponse(index_file)


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
    _configure_web_client_routes(app)

    return app


app = create_app()
