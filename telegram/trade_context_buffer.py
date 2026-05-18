"""按群维护滑动消息窗口，供 AI 聚合交易信息。"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Deque


@dataclass
class WindowMessage:
    msg_id: int
    sender: str
    text: str
    at: datetime

    def line_for_prompt(self, index: int) -> str:
        body = (self.text or "").replace("\n", " ").strip()
        if len(body) > 400:
            body = body[:400] + "…"
        ts = self.at.strftime("%m-%d %H:%M") if self.at else ""
        who = (self.sender or "?").strip()
        return f"{index}. [{ts}] {who}: {body or '(无文字)'}"


@dataclass
class ChatWindow:
    chat_id: int
    title: str = ""
    messages: Deque[WindowMessage] = field(default_factory=deque)
    pending_flush: bool = False

    def append(self, msg: WindowMessage, max_size: int) -> None:
        self.messages.append(msg)
        while len(self.messages) > max_size:
            self.messages.popleft()
        self.pending_flush = True

    def snapshot_for_ai(self) -> list[WindowMessage]:
        return list(self.messages)

    def clear_pending(self) -> None:
        self.pending_flush = False


class TradeContextBuffer:
    def __init__(self, *, max_size: int = 30) -> None:
        self.max_size = max(5, max_size)
        self._chats: dict[int, ChatWindow] = {}

    def add(
        self,
        chat_id: int,
        *,
        msg_id: int,
        sender: str,
        text: str,
        at: datetime | None = None,
        title: str = "",
    ) -> ChatWindow:
        win = self._chats.get(chat_id)
        if win is None:
            win = ChatWindow(chat_id=chat_id, title=title)
            self._chats[chat_id] = win
        elif title:
            win.title = title
        win.append(
            WindowMessage(
                msg_id=msg_id,
                sender=sender,
                text=text,
                at=at or datetime.now(timezone.utc),
            ),
            self.max_size,
        )
        return win

    def get(self, chat_id: int) -> ChatWindow | None:
        return self._chats.get(chat_id)
