"""配置项：OpenClaw 地址、鉴权与调度参数。"""
from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    activate_server: str = os.getenv("ACTIVATE_SERVER", "http://127.0.0.1:9000")
    openclaw_webhook_url: str = os.getenv("OPENCLAW_WEBHOOK_URL", "http://127.0.0.1:8080/webhook")
    shared_secret: str = os.getenv("OPENCLAW_SHARED_SECRET", "change-me")
    sqlite_db_path: str = os.getenv("ORCHESTRATOR_DB_PATH", "orchestrator.db")
    mysql_host: str = os.getenv("MYSQL_HOST", "127.0.0.1")
    mysql_port: int = int(os.getenv("MYSQL_PORT", "3306"))
    mysql_user: str = os.getenv("MYSQL_USER", "root")
    mysql_password: str = os.getenv("MYSQL_PASSWORD", "Cambridge#*DR")
    mysql_database: str = os.getenv("MYSQL_DATABASE", "orchestrator_center")
    poll_interval_seconds: float = float(os.getenv("ORCHESTRATOR_POLL_INTERVAL", "1.0"))
    max_retry_count: int = int(os.getenv("ORCHESTRATOR_MAX_RETRY", "3"))
    webhook_timeout_seconds: int = int(os.getenv("OPENCLAW_WEBHOOK_TIMEOUT", "15"))


SETTINGS = Settings()
