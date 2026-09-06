"""
把 channel_profiles.json 中配置的群实时消息推到 discord-collector UI。

若 profile 含 main（主要发言人，中/英文逗号分隔），则仅推送发言人模糊匹配到名单的消息。

collect:ui 需在跑：POST http://127.0.0.1:3851/api/telegram/live/ingest
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from cards_client import _channel_avatar_for_api
from config import get_cards_api_base_url, resolve_channel_profile


def channel_profiles_path() -> Path:
    return Path(__file__).resolve().parent / "channel_profiles.json"


def media_file_to_url(path: str | Path) -> str:
    """本地 media 文件 → collector 静态路径（经 Vite 代理 /telegram-media）。"""
    p = Path(path)
    name = p.name
    if not name:
        return ""
    return f"/telegram-media/{name}"


def local_paths_to_media_urls(paths: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in paths or []:
        u = media_file_to_url(raw)
        if not u or u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def load_profile_chat_ids() -> list[int]:
    path = channel_profiles_path()
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(raw, dict):
        return []
    out: list[int] = []
    for k in raw.keys():
        try:
            out.append(int(str(k).strip()))
        except ValueError:
            continue
    return out


def parse_main_sender_patterns(raw: str | None) -> list[str]:
    """main 字段：多个用户名以中文逗号或英文逗号分隔。"""
    if not raw or not str(raw).strip():
        return []
    parts = re.split(r"[,，]", str(raw))
    return [p.strip() for p in parts if p.strip()]


def _norm_sender_token(s: str) -> str:
    t = (s or "").strip().lower()
    # 去掉展示名里的 (@username)
    t = re.sub(r"\(@[^)]*\)", "", t)
    t = re.sub(r"\s+", "", t)
    return t


def sender_matches_main(sender: str, patterns: list[str]) -> bool:
    """
    模糊匹配：子串包含，或 SequenceMatcher ≥ 0.6。
    patterns 为空时视为不过滤（全通过）。
    """
    if not patterns:
        return True
    sn = _norm_sender_token(sender)
    if not sn:
        return False
    # 也尝试裸 username（无 @）
    sn_alt = sn.lstrip("@")
    for p in patterns:
        pn = _norm_sender_token(p)
        if not pn:
            continue
        if pn in sn or pn in sn_alt or sn in pn or sn_alt in pn:
            return True
        if SequenceMatcher(None, pn, sn).ratio() >= 0.6:
            return True
        if sn_alt != sn and SequenceMatcher(None, pn, sn_alt).ratio() >= 0.6:
            return True
    return False


def _iso(at: datetime | None) -> str:
    if at is None:
        return datetime.now(timezone.utc).isoformat()
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return at.astimezone(timezone.utc).isoformat()


class UiFeedPusher:
    def __init__(self) -> None:
        self._base = get_cards_api_base_url().rstrip("/")
        self._url = f"{self._base}/api/telegram/live/ingest"

    def enabled(self) -> bool:
        return bool(self._base)

    def should_push_sender(self, chat_id: int, sender: str, *, title: str = "") -> bool:
        """无 main 配置则推；有则仅匹配名单。"""
        profile = resolve_channel_profile(chat_id, fallback_title=title or str(chat_id))
        patterns = parse_main_sender_patterns(profile.get("main") or "")
        return sender_matches_main(sender, patterns)

    def push_message(
        self,
        *,
        chat_id: int,
        msg_id: int,
        sender: str,
        text: str,
        title: str = "",
        at: datetime | None = None,
        image_urls: list[str] | None = None,
        image_paths: list[str] | None = None,
    ) -> bool:
        if not self.enabled():
            return False
        text = (text or "").strip()
        urls = list(image_urls or [])
        if image_paths:
            urls.extend(local_paths_to_media_urls(image_paths))
        # 去重保序
        seen: set[str] = set()
        uniq: list[str] = []
        for u in urls:
            s = str(u or "").strip()
            if not s or s in seen:
                continue
            seen.add(s)
            uniq.append(s)
        urls = uniq
        if not text and not urls:
            return False
        profile = resolve_channel_profile(chat_id, fallback_title=title or str(chat_id))
        patterns = parse_main_sender_patterns(profile.get("main") or "")
        if patterns and not sender_matches_main(sender, patterns):
            return False
        avatar_resolved = profile.get("avatar") or ""
        avatar_url = _channel_avatar_for_api(str(avatar_resolved))
        # 头像若是绝对 URL，前端仍可用；媒体统一相对路径走代理
        payload: dict[str, Any] = {
            "id": f"{chat_id}:{msg_id}",
            "chatId": str(chat_id),
            "chatName": str(profile.get("name") or title or chat_id),
            "avatarUrl": avatar_url,
            "sender": sender or "—",
            "text": (text or "")[:4000],
            "messageId": int(msg_id),
            "at": _iso(at),
            "imageUrls": urls[:12],
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self._url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return 200 <= int(getattr(resp, "status", 200) or 200) < 300
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:200]
            print(f"[!] UI feed HTTP {e.code}: {body}", flush=True)
            return False
        except Exception as e:
            print(f"[!] UI feed 推送失败: {e}", flush=True)
            return False
