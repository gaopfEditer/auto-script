"""从环境变量加载 Telegram API 配置（勿在代码中硬编码 api_hash）。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from dotenv import load_dotenv

# 优先加载仓库根目录的 .env（与 auto-script 同级或上级常见布局）
_root = Path(__file__).resolve().parent.parent
_telegram_dir = Path(__file__).resolve().parent
load_dotenv(_root / ".env")
load_dotenv(_telegram_dir / ".env")


def _require_int(name: str) -> int:
    raw = os.environ.get(name)
    if not raw:
        raise RuntimeError(f"缺少环境变量 {name}，请在 .env 中配置（参考仓库根目录 .env.example）")
    return int(raw.strip())


def get_api_id() -> int:
    return _require_int("TELEGRAM_API_ID")


def get_api_hash() -> str:
    h = os.environ.get("TELEGRAM_API_HASH", "").strip()
    if not h:
        raise RuntimeError(
            "缺少环境变量 TELEGRAM_API_HASH，请在 .env 中配置；切勿提交到 Git。"
        )
    return h


def get_session_name() -> str:
    return os.environ.get("TELEGRAM_SESSION_NAME", "telegram_client").strip() or "telegram_client"


def get_connect_timeout() -> int:
    """单次连接超时（秒），网络差或需看日志时可加大。"""
    raw = os.environ.get("TELEGRAM_CONNECT_TIMEOUT", "60").strip()
    return int(raw) if raw else 60


def get_connection_retries() -> int:
    raw = os.environ.get("TELEGRAM_CONNECTION_RETRIES", "5").strip()
    return int(raw) if raw else 5


def get_telegram_client_extra_kwargs() -> dict[str, Any]:
    """
    供 TelegramClient(..., **kwargs) 合并使用。

    - MTProto 代理：设置 TELEGRAM_MT_PROXY_HOST / PORT / SECRET（与 TELEGRAM_PROXY_URL 二选一）
    - 普通 SOCKS5/HTTP：设置 TELEGRAM_PROXY_URL，需已安装 python-socks[asyncio]
    """
    mt_host = os.environ.get("TELEGRAM_MT_PROXY_HOST", "").strip()
    mt_port = os.environ.get("TELEGRAM_MT_PROXY_PORT", "").strip()
    mt_secret = os.environ.get("TELEGRAM_MT_PROXY_SECRET", "").strip()
    if mt_host and mt_port:
        from telethon import connection

        secret = mt_secret if mt_secret else "00000000000000000000000000000000"
        return {
            "connection": connection.ConnectionTcpMTProxyRandomizedIntermediate,
            "proxy": (mt_host, int(mt_port), secret),
        }

    url = os.environ.get("TELEGRAM_PROXY_URL", "").strip()
    if not url:
        return {}

    parsed = urlparse(url)
    scheme = (parsed.scheme or "socks5").lower()
    host = parsed.hostname
    port = parsed.port
    if not host or not port:
        raise RuntimeError(
            "TELEGRAM_PROXY_URL 须含主机与端口，例如 socks5://127.0.0.1:7891 或 http://127.0.0.1:7890"
        )

    rdns = scheme in ("socks5h", "socks4a")
    type_map = {
        "socks5": "socks5",
        "socks5h": "socks5",
        "socks4": "socks4",
        "socks4a": "socks4",
        "http": "http",
        "https": "http",
    }
    proxy_type = type_map.get(scheme)
    if not proxy_type:
        raise RuntimeError(
            f"TELEGRAM_PROXY_URL 协议 {scheme!r} 不支持，请用 socks5 / socks5h / http / https"
        )

    proxy: dict[str, Any] = {
        "proxy_type": proxy_type,
        "addr": host,
        "port": int(port),
    }
    if rdns:
        proxy["rdns"] = True
    if parsed.username:
        proxy["username"] = unquote(parsed.username)
    if parsed.password:
        proxy["password"] = unquote(parsed.password)
    return {"proxy": proxy}


def describe_telegram_network(extra: dict[str, Any]) -> str:
    """简短说明当前网络配置（不含密码）。"""
    if not extra:
        return (
            "未配置代理。若长时间停在「Connecting to 149.154…:443」，多为到 Telegram 机房的链路被屏蔽，"
            "请在 .env 设置 TELEGRAM_PROXY_URL（例如本机 Clash 的 SOCKS5 端口），或 MTProto 代理三项变量。"
        )
    if "connection" in extra:
        p = extra["proxy"]
        if isinstance(p, tuple) and len(p) >= 2:
            return f"MTProto 代理 → {p[0]}:{p[1]}"
        return "MTProto 代理（已配置）"
    p = extra.get("proxy") or {}
    if isinstance(p, dict):
        user = p.get("username")
        auth = f" 用户={user!r}" if user else ""
        rdns = f" rdns={p.get('rdns')}" if "rdns" in p else ""
        return f"{p.get('proxy_type')} → {p.get('addr')}:{p.get('port')}{rdns}{auth}"
    return "已配置代理"


def get_target_chat_ids() -> list[int]:
    """逗号分隔的整数 peer id，用于 listen 脚本过滤；空表示监听所有已加入对话的新消息。"""
    raw = os.environ.get("TELEGRAM_TARGET_CHAT_IDS", "").strip()
    if not raw:
        return []
    out: list[int] = []
    for part in raw.replace("|", ",").split(","):
        part = part.strip()
        if part:
            out.append(int(part))
    return out


def _parse_id_line_list(raw: str) -> list[int]:
    out: list[int] = []
    for part in raw.replace("|", ",").split(","):
        part = part.strip()
        if part:
            out.append(int(part))
    return out


def get_monitored_group_ids() -> list[int]:
    """
    poll_groups 使用的群组/频道 id 列表：合并
    - 环境变量 TELEGRAM_MONITORED_GROUP_IDS（逗号分隔）
    - 文件：TELEGRAM_MONITORED_GROUPS_FILE；未设置时若存在 telegram/monitored_groups.txt 则读取
    每行一个整数，# 开头为注释。结果去重且保持顺序。
    """
    ids: list[int] = []
    raw = os.environ.get("TELEGRAM_MONITORED_GROUP_IDS", "").strip()
    if raw:
        ids.extend(_parse_id_line_list(raw))

    file_env = os.environ.get("TELEGRAM_MONITORED_GROUPS_FILE", "").strip()
    if file_env:
        path = Path(file_env)
        if not path.is_absolute():
            path = _root / path
    else:
        path = _telegram_dir / "monitored_groups.txt"

    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            ids.append(int(line))

    seen: set[int] = set()
    ordered: list[int] = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            ordered.append(i)
    return ordered


def monitored_groups_file_default() -> Path:
    """默认监控列表路径（便于报错提示）。"""
    return _telegram_dir / "monitored_groups.txt"


def get_poll_interval_seconds() -> float:
    raw = os.environ.get("TELEGRAM_POLL_INTERVAL", "30").strip()
    return float(raw) if raw else 30.0


def get_poll_state_path() -> Path:
    raw = os.environ.get("TELEGRAM_POLL_STATE_FILE", "").strip()
    if raw:
        p = Path(raw)
        return p.resolve() if p.is_absolute() else (_root / p).resolve()
    return (_telegram_dir / ".poll_state.json").resolve()
