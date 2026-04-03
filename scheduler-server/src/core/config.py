"""
这个文件负责读取服务启动配置。
当前第一阶段只保留最小配置集合，避免还没跑通就过度设计。
"""
from pydantic import BaseModel
import os
from pathlib import Path

DEFAULT_CONTAINER_DATABASE_URL = "sqlite:////app/data/app.db"
DEFAULT_LOCAL_DATABASE_URL = "sqlite:///./data/app.db"
DEFAULT_WEB_DIST_DIR = "/app/web"


def _default_database_url() -> str:
    if Path("/app").exists():
        return DEFAULT_CONTAINER_DATABASE_URL
    return DEFAULT_LOCAL_DATABASE_URL


def _env_flag(name: str, default: bool) -> bool:
    """
    把环境变量解析成布尔值。
    这样 .env.dev 里既可以写 1/0，也可以写 true/false。
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class Settings(BaseModel):
    app_env: str = os.getenv("APP_ENV", "development")
    app_host: str = os.getenv("APP_HOST", "127.0.0.1")
    app_port: int = int(os.getenv("APP_PORT", "8080"))
    database_url: str = os.getenv("DATABASE_URL", _default_database_url())
    web_dist_dir: str = os.getenv("WEB_DIST_DIR", DEFAULT_WEB_DIST_DIR)
    default_channel_account_id: str = os.getenv("DEFAULT_CHANNEL_ACCOUNT_ID", "default")
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    # 远程联调阶段，OpenClaw 的 channel 走的是自签证书 HTTPS。
    # 这里保留一个显式开关，避免把 verify=False 写死在业务代码里。
    channel_allow_insecure_tls: bool = _env_flag("CHANNEL_ALLOW_INSECURE_TLS", False)
    # 本地前后端联调时，如果 OpenClaw / channel 不可用，
    # 可以打开这个开关，由 scheduler-server 自己生成一条模拟 Agent 回复。
    local_agent_mock_enabled: bool = _env_flag("LOCAL_AGENT_MOCK_ENABLED", False)
    auth_secret: str = os.getenv("AUTH_SECRET", "claw-team-dev-auth-secret")
    default_login_username: str = os.getenv("DEFAULT_LOGIN_USERNAME", "admin")
    default_login_password: str = os.getenv("DEFAULT_LOGIN_PASSWORD", "admin123456")


settings = Settings()
