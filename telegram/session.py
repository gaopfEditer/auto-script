"""创建并启动 Telethon 客户端（供 list_groups / poll_groups 等复用）。"""

from __future__ import annotations

import asyncio
import atexit
import os
import sqlite3
import time
import traceback
from pathlib import Path

try:
    import fcntl
except ImportError:
    fcntl = None  # type: ignore

from telethon import TelegramClient
from telethon.sessions import SQLiteSession

from config import (
    describe_telegram_network,
    get_api_hash,
    get_api_id,
    get_connect_timeout,
    get_connection_retries,
    get_session_name,
    get_telegram_client_extra_kwargs,
)


class ResilientSQLiteSession(SQLiteSession):
    """
    Telethon 默认 sqlite3.connect 未设 timeout，.session 被占用时易立刻 OperationalError。
    拉长等待并设置 PRAGMA busy_timeout，缓解「刚关掉上一进程」或短暂争用。
    注意：同一 .session 仍不能长期被两个进程同时打开（例如 listen 与 poll_groups 并行）。
    """

    def _cursor(self):
        if self._conn is None:
            sec = float(os.environ.get("TELEGRAM_SQLITE_BUSY_TIMEOUT", "60").strip() or "60")
            self._conn = sqlite3.connect(
                self.filename,
                check_same_thread=False,
                timeout=sec,
            )
            # PRAGMA 不支持 ? 占位符，只能拼接整数（已 clamp，避免注入）
            busy_ms = int(min(max(sec * 1000, 100), 2147483000))
            self._conn.execute(f"PRAGMA busy_timeout={busy_ms}")
        return self._conn.cursor()


_SESSION_LOCK_HINT = (
    "会话文件 .session 是 SQLite：不能两个脚本/终端同时用同一 TELEGRAM_SESSION_NAME。\n"
    "请先停掉其它正在跑的 listen.py / poll_groups.py / list_groups.py，或给另一脚本另设 "
    "TELEGRAM_SESSION_NAME（会各用一套登录态）。\n"
    "若已全停仍报错，可稍等几秒再试，或加大 TELEGRAM_SQLITE_BUSY_TIMEOUT（秒）。\n"
    "本仓库在 POSIX 下默认使用 *.session.runlock 单实例锁；第二次启动会立刻失败并提示，避免「假死」。\n"
    "确需并行请设 TELEGRAM_ALLOW_MULTI=1（仍可能因 SQLite 卡住）。"
)

_run_lock_fd: object | None = None
_run_lock_path: Path | None = None
_atexit_lock_registered = False


def _run_lock_file(session_stem: str, cwd: Path) -> Path:
    return (cwd / f"{session_stem}.session.runlock").resolve()


def _release_session_run_lock() -> None:
    """进程退出或连接失败时释放单实例锁（勿在成功连接后于中途调用）。"""
    global _run_lock_fd, _run_lock_path
    if _run_lock_fd is None:
        return
    try:
        if fcntl is not None:
            fcntl.flock(_run_lock_fd.fileno(), fcntl.LOCK_UN)
        _run_lock_fd.close()
    except Exception:
        pass
    _run_lock_fd = None
    _run_lock_path = None


def _acquire_session_run_lock(session_stem: str, cwd: Path) -> None:
    """
    同一工作目录、同一 session 名：只允许一个进程打开 Telethon，避免第二次 connect 卡在 SQLite。
    进程正常退出时内核会释放 flock；崩溃后锁也会释放，下次可正常启动。
    """
    global _run_lock_fd, _run_lock_path, _atexit_lock_registered

    raw = os.environ.get("TELEGRAM_ALLOW_MULTI", "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return
    if fcntl is None:
        print(
            "[*] 当前平台无 fcntl，未启用 .session.runlock 单实例锁；"
            "请勿多开同一 TELEGRAM_SESSION_NAME。",
            flush=True,
        )
        return
    if _run_lock_fd is not None:
        return

    path = _run_lock_file(session_stem, cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = open(path, "a+", encoding="utf-8")
    fd.seek(0)
    fd.truncate()
    fd.write(f"{os.getpid()}\n")
    fd.flush()
    try:
        fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fd.close()
        other = ""
        try:
            other = path.read_text(encoding="utf-8").strip().splitlines()[0]
        except Exception:
            pass
        print(
            f"[!] 无法获取会话运行锁: {path}\n"
            f"    已有其它进程占用同一 TELEGRAM_SESSION_NAME（锁内记录 pid≈{other}）。\n"
            "    请先结束其它终端里的 poll_groups / listen / list_groups，或改用不同 TELEGRAM_SESSION_NAME。\n"
            "    确需并行（不推荐）可设置环境变量 TELEGRAM_ALLOW_MULTI=1。",
            flush=True,
        )
        raise SystemExit(3)

    _run_lock_fd = fd
    _run_lock_path = path
    if not _atexit_lock_registered:
        atexit.register(_release_session_run_lock)
        _atexit_lock_registered = True
    print(f"[+] 单实例锁: {path}（进程退出自动释放）", flush=True)


async def create_and_start_client() -> tuple[TelegramClient, Path]:
    """
    connect + start，返回 (client, 当前工作目录下的 .session 路径)。
    调用方须在结束时 await client.disconnect()。
    """
    api_id = get_api_id()
    api_hash = get_api_hash()
    session = get_session_name()
    timeout = get_connect_timeout()
    retries = get_connection_retries()
    cwd = Path.cwd()
    session_path = (cwd / f"{session}.session").resolve()

    print(f"[+] 工作目录: {cwd}", flush=True)
    print(f"[+] 会话文件: {session_path} (存在={session_path.is_file()})", flush=True)
    print(
        f"[+] api_id={api_id}  connect_timeout={timeout}s  connection_retries={retries}",
        flush=True,
    )
    extra = get_telegram_client_extra_kwargs()
    print(f"[+] 网络: {describe_telegram_network(extra)}", flush=True)

    _acquire_session_run_lock(session, cwd)

    client: TelegramClient | None = None
    try:
        print("[+] 正在连接 Telegram（可选 TELEGRAM_LOG_LEVEL=DEBUG）…", flush=True)
        client = TelegramClient(
            ResilientSQLiteSession(session),
            api_id,
            api_hash,
            timeout=timeout,
            connection_retries=retries,
            **extra,
        )
        t0 = time.monotonic()
        connect_attempts = int(os.environ.get("TELEGRAM_SQLITE_CONNECT_RETRIES", "5").strip() or "5")
        last_lock_err: sqlite3.OperationalError | None = None
        for attempt in range(1, connect_attempts + 1):
            try:
                print(
                    "[*] client.connect() 中…（超时由 TelegramClient 的 connect_timeout 控制；"
                    "勿用 asyncio.wait_for 包裹 connect，否则取消协程可能损坏后续启动。）\n"
                    "[*] 已有 .session 时一般无需再输手机号/验证码；只有删了 session 或登录失效才要重新登录。",
                    flush=True,
                )
                await client.connect()
                print(f"[+] connect() 成功，耗时 {time.monotonic() - t0:.2f}s", flush=True)
                last_lock_err = None
                break
            except sqlite3.OperationalError as e:
                msg = str(e).lower()
                if "locked" not in msg:
                    print(f"[!] connect() 失败: {type(e).__name__}: {e}", flush=True)
                    traceback.print_exc()
                    raise
                last_lock_err = e
                print(
                    f"[!] 会话数据库被占用（{e}），{attempt}/{connect_attempts}。"
                    f" 将尝试 disconnect 后等待 2s…\n{_SESSION_LOCK_HINT}",
                    flush=True,
                )
                try:
                    await client.disconnect()
                except Exception:
                    pass
                if attempt >= connect_attempts:
                    break
                await asyncio.sleep(2)
        if last_lock_err is not None:
            print(f"[!] connect() 仍失败: {last_lock_err}", flush=True)
            traceback.print_exc()
            raise last_lock_err

        print(
            "[*] 若 stderr 出现 Encrypting / Handling RPC 等 DEBUG，属正常协议日志；"
            "默认 TELEGRAM_LOG_LEVEL=INFO。",
            flush=True,
        )
        print(
            "[*] 若提示「Please enter your phone」：请输入手机号与验证码（或 Bot token）。",
            flush=True,
        )
        print(
            "[*] client.start() 中…（已有 .session 会很快；否则会等待你在本终端输入手机号/验证码）",
            flush=True,
        )

        await client.start()
        print(f"[+] 已授权会话就绪，start() 总耗时 {time.monotonic() - t0:.2f}s", flush=True)
        try:
            client.session.save()
        except Exception:
            pass
        return client, session_path
    except SystemExit:
        raise
    except BaseException:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass
        _release_session_run_lock()
        raise
