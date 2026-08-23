"""从环境变量加载 Telegram API 配置（勿在代码中硬编码 api_hash）。"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from dotenv import load_dotenv

# 优先加载仓库根目录的 .env（与 auto-script 同级或上级常见布局）
_root = Path(__file__).resolve().parent.parent
_telegram_dir = Path(__file__).resolve().parent
load_dotenv(_root / ".env")
load_dotenv(_root / "discord-collector" / ".env")
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
    """逗号分隔的整数 peer id；listen.py 非空时优先用其过滤，空则改用 monitored_groups.txt 等。"""
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


def _monitored_groups_path() -> Path:
    file_env = os.environ.get("TELEGRAM_MONITORED_GROUPS_FILE", "").strip()
    if file_env:
        p = Path(file_env)
        return p.resolve() if p.is_absolute() else (_root / p).resolve()
    return (_telegram_dir / "monitored_groups.txt").resolve()


_MONITORED_KEYS = frozenset({"monitored", "groups", "chats", "监听群", "监控群", "次要群", "闲聊群"})
_MAIN_MONITORED_KEYS = frozenset(
    {"main_monitored", "main", "primary", "主群", "主要群", "发车群"}
)
_KEYWORD_KEYS = frozenset(
    {"sender_keywords", "sender", "keywords", "发件人", "发件人关键字"}
)
_PUSH_KEYS = frozenset({"push_chat", "push", "notify_chat", "推送群", "推送"})


def _classify_config_key(key: str) -> str | None:
    k = key.strip()
    if not k:
        return None
    kl = k.lower()
    if kl in _MAIN_MONITORED_KEYS or k in _MAIN_MONITORED_KEYS:
        return "main"
    if kl in _MONITORED_KEYS or k in _MONITORED_KEYS:
        return "monitored"
    if kl in _KEYWORD_KEYS or k in _KEYWORD_KEYS:
        return "keywords"
    if kl in _PUSH_KEYS or k in _PUSH_KEYS:
        return "push"
    return None


def _dedupe_preserve(seq: list[int]) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _split_csv_parts(val: str) -> list[str]:
    return [p.strip() for p in val.replace("|", ",").split(",") if p.strip()]


@dataclass
class ParsedMonitoredFile:
    """由 monitored_groups.txt 解析出的结构化配置。"""

    group_ids: list[int] = field(default_factory=list)
    """次要闲聊群（发车占比低）→ 规则推送到 push_chat。"""
    main_group_ids: list[int] = field(default_factory=list)
    """主要发车群（发车占比高）→ 写入 discord-collector 卡片 API。"""
    sender_keywords: list[str] = field(default_factory=list)
    push_chat_ids: list[int] = field(default_factory=list)


def parse_monitored_groups_file(text: str) -> ParsedMonitoredFile:
    """
    统一配置格式（UTF-8）：
    - key=value，value 内多个条目用英文逗号分隔，如 monitored=-100xxx,-100yyy
    - main_monitored= 主要发车来源；monitored= 次要闲聊群
    - 仍支持单独一行纯整数 peer id（负数超级群等），等价于写入 monitored=
    - # 开头整行为注释；不含 = 且非整数的行忽略
    """
    out = ParsedMonitoredFile()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            bucket = _classify_config_key(key)
            if bucket is None:
                continue
            parts = _split_csv_parts(val)
            if bucket == "monitored":
                for p in parts:
                    try:
                        out.group_ids.append(int(p))
                    except ValueError:
                        continue
            elif bucket == "main":
                for p in parts:
                    try:
                        out.main_group_ids.append(int(p))
                    except ValueError:
                        continue
            elif bucket == "keywords":
                out.sender_keywords.extend(parts)
            else:
                for p in parts:
                    try:
                        out.push_chat_ids.append(int(p))
                    except ValueError:
                        continue
            continue
        if re.fullmatch(r"-?\d+", line):
            try:
                out.group_ids.append(int(line))
            except ValueError:
                pass

    out.group_ids = _dedupe_preserve(out.group_ids)
    out.main_group_ids = _dedupe_preserve(out.main_group_ids)
    # 次要列表去掉已在主群里的 id，避免双投
    main_set = set(out.main_group_ids)
    out.group_ids = [x for x in out.group_ids if x not in main_set]
    seen_kw: set[str] = set()
    kw_ordered: list[str] = []
    for k in out.sender_keywords:
        if k not in seen_kw:
            seen_kw.add(k)
            kw_ordered.append(k)
    out.sender_keywords = kw_ordered
    out.push_chat_ids = _dedupe_preserve(out.push_chat_ids)
    return out


def read_parsed_monitored_groups_file() -> ParsedMonitoredFile | None:
    path = _monitored_groups_path()
    if not path.is_file():
        return None
    return parse_monitored_groups_file(path.read_text(encoding="utf-8"))


def get_notify_forward_config() -> tuple[list[str], list[int]]:
    """
    关键词转发：发件人展示名包含任一关键词时，可转发到推送群列表。
    来自 monitored_groups.txt 的 sender_keywords / push_chat 等键；
    环境变量 TELEGRAM_SENDER_KEYWORDS、TELEGRAM_PUSH_CHAT_ID 非空时覆盖文件对应项
    （推送 id 多个用逗号分隔）。
    """
    keywords: list[str] = []
    push_ids: list[int] = []
    parsed = read_parsed_monitored_groups_file()
    if parsed:
        keywords = list(parsed.sender_keywords)
        push_ids = list(parsed.push_chat_ids)

    env_kw = os.environ.get("TELEGRAM_SENDER_KEYWORDS", "").strip()
    if env_kw:
        keywords = _split_csv_parts(env_kw)
    env_push = os.environ.get("TELEGRAM_PUSH_CHAT_ID", "").strip()
    if env_push:
        push_ids = []
        for p in _split_csv_parts(env_push):
            try:
                push_ids.append(int(p))
            except ValueError:
                pass
        push_ids = _dedupe_preserve(push_ids)
    return keywords, push_ids


def get_monitored_group_ids() -> list[int]:
    """
    次要闲聊群 id（poll_groups / 规则推送 push_chat）：
    - 环境变量 TELEGRAM_MONITORED_GROUP_IDS
    - 文件 monitored= …
    不含 main_monitored（主发车群另见 get_main_monitored_group_ids）。
    """
    ids: list[int] = []
    raw = os.environ.get("TELEGRAM_MONITORED_GROUP_IDS", "").strip()
    if raw:
        ids.extend(_parse_id_line_list(raw))

    path = _monitored_groups_path()
    if path.is_file():
        ids.extend(parse_monitored_groups_file(path.read_text(encoding="utf-8")).group_ids)

    return _dedupe_preserve(ids)


def get_main_monitored_group_ids() -> list[int]:
    """主要发车来源 → 写入卡片 API。"""
    ids: list[int] = []
    raw = os.environ.get("TELEGRAM_MAIN_MONITORED_GROUP_IDS", "").strip()
    if raw:
        ids.extend(_parse_id_line_list(raw))
    path = _monitored_groups_path()
    if path.is_file():
        ids.extend(parse_monitored_groups_file(path.read_text(encoding="utf-8")).main_group_ids)
    return _dedupe_preserve(ids)


def get_all_listen_group_ids() -> list[int]:
    """listen.py 监听范围 = 主发车群 ∪ 次要闲聊群。"""
    return _dedupe_preserve([*get_main_monitored_group_ids(), *get_monitored_group_ids()])


def resolve_listen_chat_ids() -> tuple[list[int] | None, str]:
    """
    listen.py / list_groups.py 共用：要处理的群 id。
    - None：TELEGRAM_LISTEN_ALL，表示全部已加入对话
    - []：未配置
    - list：明确 id 列表
    """
    if os.environ.get("TELEGRAM_LISTEN_ALL", "").strip().lower() in ("1", "true", "yes", "on"):
        return None, "TELEGRAM_LISTEN_ALL=1（所有已加入对话）"
    env = get_target_chat_ids()
    if env:
        return env, "TELEGRAM_TARGET_CHAT_IDS"
    file_ids = get_all_listen_group_ids()
    if file_ids:
        return file_ids, "monitored_groups.txt (main_monitored ∪ monitored)"
    return [], ""


def get_cards_api_base_url() -> str:
    return (
        os.environ.get("CARDS_API_BASE_URL", "").strip()
        or os.environ.get("COLLECTOR_UI_BASE_URL", "").strip()
        or "http://127.0.0.1:3851"
    ).rstrip("/")


def get_cards_api_key() -> str:
    return (os.environ.get("CARDS_API_KEY") or "").strip()


def channel_profiles_path() -> Path:
    raw = os.environ.get("TELEGRAM_CHANNEL_PROFILES_FILE", "").strip()
    if raw:
        p = Path(raw)
        return p.resolve() if p.is_absolute() else (_root / p).resolve()
    return (_telegram_dir / "channel_profiles.json").resolve()


def load_channel_profiles() -> dict[str, dict[str, str]]:
    """
    Telegram chat_id → {name, avatar}。
    键可用 "-100…" 或去掉符号的数字串；缺省时空对象。
    """
    path = channel_profiles_path()
    if not path.is_file():
        return {}
    try:
        import json

        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    for k, v in raw.items():
        if not isinstance(v, dict):
            continue
        key = str(k).strip()
        out[key] = {
            "name": str(v.get("name") or v.get("channelName") or "").strip(),
            "avatar": str(v.get("avatar") or v.get("channelAvatar") or "").strip(),
        }
    return out


def telegram_avatar_dir() -> Path:
    return (_telegram_dir / "avatar").resolve()


def default_avatar_path_for_chat(chat_id: int) -> Path | None:
    """约定：telegram/avatar/{去掉符号的 chat_id}.png|.jpg|.webp"""
    stem = str(chat_id).lstrip("-")
    base = telegram_avatar_dir()
    for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        p = base / f"{stem}{ext}"
        if p.is_file():
            return p
    return None


def resolve_avatar_path(raw: str, *, chat_id: int) -> str:
    """
    解析头像配置：
    - http(s):// 原样返回
    - 空：尝试 telegram/avatar/{chat_id去符号}.png
    - 相对路径：相对 telegram/ 目录（推荐 avatar/100….png）
    - 绝对路径：直接用
    返回本地绝对路径字符串，或 http URL；找不到则空串。
    """
    s = (raw or "").strip()
    if s.startswith("http://") or s.startswith("https://") or s.startswith("data:"):
        return s
    if not s:
        found = default_avatar_path_for_chat(chat_id)
        return str(found) if found else ""
    p = Path(s)
    if not p.is_absolute():
        # 允许 avatar/xxx.png 或 /telegram/avatar/xxx.png 写法
        cleaned = s.lstrip("/")
        if cleaned.startswith("telegram/"):
            cleaned = cleaned[len("telegram/") :]
        p = (_telegram_dir / cleaned).resolve()
    if p.is_file():
        return str(p)
    # 仅写了文件名时落到 avatar/
    only = Path(s).name
    cand = telegram_avatar_dir() / only
    if cand.is_file():
        return str(cand)
    return ""


def resolve_channel_profile(chat_id: int, *, fallback_title: str = "") -> dict[str, str]:
    profiles = load_channel_profiles()
    key = str(chat_id)
    alt = key.lstrip("-")
    meta = profiles.get(key) or profiles.get(alt) or {}
    name = (meta.get("name") or "").strip() or (fallback_title or "").strip() or f"TG {chat_id}"
    avatar = resolve_avatar_path(meta.get("avatar") or "", chat_id=chat_id)
    return {"name": name, "avatar": avatar, "channelId": key}


def monitored_groups_file_default() -> Path:
    """监控列表文件路径（含 TELEGRAM_MONITORED_GROUPS_FILE 覆盖，便于报错提示）。"""
    return _monitored_groups_path()


def get_poll_interval_seconds() -> float:
    raw = os.environ.get("TELEGRAM_POLL_INTERVAL", "30").strip()
    return float(raw) if raw else 30.0


def get_poll_state_path() -> Path:
    raw = os.environ.get("TELEGRAM_POLL_STATE_FILE", "").strip()
    if raw:
        p = Path(raw)
        return p.resolve() if p.is_absolute() else (_root / p).resolve()
    return (_telegram_dir / ".poll_state.json").resolve()


def _env_bool(name: str, default: str = "1") -> bool:
    raw = os.environ.get(name, default).strip().lower()
    return raw in ("1", "true", "yes", "on")


def ai_trade_aggregate_enabled() -> bool:
    """监听群消息滑动窗口 + Ollama 聚合后推送（默认关；需显式 TELEGRAM_AI_TRADE_AGGREGATE=1）。"""
    return _env_bool("TELEGRAM_AI_TRADE_AGGREGATE", "0")


def ollama_trade_aggregate_enabled() -> bool:
    """同 ai_trade_aggregate_enabled（兼容旧导入名）。"""
    return ai_trade_aggregate_enabled()


def get_trade_context_window_size() -> int:
    raw = os.environ.get("TELEGRAM_TRADE_CONTEXT_SIZE", "30").strip()
    try:
        return max(5, int(raw))
    except ValueError:
        return 30


def get_trade_context_flush_seconds() -> float:
    raw = os.environ.get("TELEGRAM_TRADE_CONTEXT_FLUSH_SEC", "45").strip()
    try:
        return max(10.0, float(raw))
    except ValueError:
        return 45.0


def get_ollama_generate_url() -> str:
    return (
        os.environ.get("OLLAMA_GENERATE_URL", "http://127.0.0.1:11434/api/generate").strip()
        or "http://127.0.0.1:11434/api/generate"
    )


def get_ollama_model() -> str:
    return os.environ.get("OLLAMA_MODEL", "gemma4:26b").strip() or "gemma4:26b"


def get_ollama_generate_timeout_sec() -> int:
    raw = os.environ.get("OLLAMA_GENERATE_TIMEOUT_MS", "90000").strip()
    try:
        ms = int(raw)
        return max(15, ms // 1000)
    except ValueError:
        return 90


def get_telegram_send_url() -> str:
    return os.environ.get("TELEGRAM_SEND_URL", "http://127.0.0.1:8000/api/telegram/send").strip()


def get_telegram_push_chat_ids() -> list[int]:
    """推送目标（与 get_notify_forward_config 的 push 部分一致）。"""
    _, push_ids = get_notify_forward_config()
    return push_ids
