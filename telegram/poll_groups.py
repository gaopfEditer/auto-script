"""
按固定间隔轮询「监控列表」中的群组/频道，只拉取列表内 id 的新消息；水位保存在本地 JSON。

与 listen.py 的实时推送不同：本脚本适合定时扫一遍、或不想长驻事件循环的场景。

配置：
  - TELEGRAM_MONITORED_GROUP_IDS 和/或 telegram/monitored_groups.txt（见 monitored_groups.example.txt）
  - TELEGRAM_POLL_INTERVAL 轮询间隔秒（默认 30）
  - TELEGRAM_POLL_STATE_FILE 可选，默认 telegram/.poll_state.json

用法:
  cd telegram && python poll_groups.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from pathlib import Path

from telethon.errors import FloodWaitError
from telethon.tl.types import Channel, Chat, User

from config import (
    get_monitored_group_ids,
    get_poll_interval_seconds,
    get_poll_state_path,
    monitored_groups_file_default,
)
from logging_setup import setup_telethon_logging
from message_format import format_message_console
from session import create_and_start_client

_PREVIEW = int(os.environ.get("TELEGRAM_MESSAGE_PREVIEW_LEN", "120"))


def _boot_key(gid: int) -> str:
    return f"__boot__{gid}"


async def _filter_resolvable_ids(client, ids: list[int]) -> list[int]:
    """
    仅保留当前会话能解析的 peer。裸 user_id（私聊）若无 access_hash 会失败，须从列表移除或先与对方产生对话。
    超级群/频道 id 多为 -100…。
    """
    ok: list[int] = []
    for gid in ids:
        try:
            await client.get_input_entity(gid)
            ok.append(gid)
        except ValueError as e:
            print(
                f"[!] 跳过 id={gid}：无法解析为可访问的对话。\n"
                f"    常见原因：把「用户 id」写进了列表（正数），而 Telethon 需要该用户在会话缓存里"
                f"（一般要先有私聊往来）；本脚本更适合已加入的群/超级群（多为 -100 开头）。\n"
                f"    原始错误: {e}",
                flush=True,
            )
    return ok


def _load_state(path: Path) -> dict[str, int]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    out: dict[str, int] = {}
    for k, v in data.items():
        try:
            out[str(k)] = int(v)
        except (TypeError, ValueError):
            continue
    return out


def _save_state(path: Path, state: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


async def _bootstrap_chat_history(client, chat_id: int, state: dict[str, int]) -> bool:
    """
    首次：拉取并打印最近 N 条历史，然后把水位设为其中最大 message.id。
    用 __boot__ 标记避免 last=0 时每轮误判为未初始化。
    """
    key = str(chat_id)
    bk = _boot_key(chat_id)
    if int(state.get(bk, 0)) == 1:
        return True

    n = int(os.environ.get("TELEGRAM_BOOTSTRAP_MESSAGES", "10").strip() or "10")
    rows: list = []
    try:
        async for m in client.iter_messages(chat_id, limit=n):
            rows.append(m)
    except ValueError as e:
        print(
            f"[!] 拉取历史失败 chat={chat_id}：{e}\n"
            "    请确认已加入该群/频道，或有查看历史权限。",
            flush=True,
        )
        return False

    if not rows:
        try:
            async for m in client.iter_messages(chat_id, limit=1):
                rows.append(m)
                break
        except ValueError:
            pass

    rows.reverse()
    print(f"[*] chat {chat_id} 最近 {len(rows)} 条历史（启动快照，共请求上限 {n} 条）:", flush=True)
    for message in rows:
        await format_message_console(
            client,
            message,
            preview=_PREVIEW,
            prefix=f"    [历史 {message.date}]",
        )

    mx = max((m.id for m in rows), default=0)
    state[key] = mx
    state[bk] = 1
    print(
        f"[*] chat {chat_id} 水位 last_msg_id={mx}（之后只打印 id 大于该值的新消息）",
        flush=True,
    )
    return True


async def _pull_new(
    client,
    chat_id: int,
    last_id: int,
) -> tuple[list, int]:
    """
    返回 (新消息按时间升序, 新的 last_id)。
    last_id>0：只取比该 id 新的消息（最多 100 条一页）。
    last_id==0：尚无水位时只取当前最新 1 条，避免与历史快照重复刷屏。
    """
    batch: list = []
    try:
        if last_id > 0:
            async for message in client.iter_messages(chat_id, limit=100):
                if message.id <= last_id:
                    break
                batch.append(message)
        else:
            async for message in client.iter_messages(chat_id, limit=1):
                batch.append(message)
                break
    except ValueError:
        return [], last_id
    batch.reverse()
    new_last = last_id
    for m in batch:
        new_last = max(new_last, m.id)
    return batch, new_last


def _entity_kind(ent: object) -> str:
    if isinstance(ent, User):
        return "用户"
    if isinstance(ent, Chat):
        return "普通群"
    if isinstance(ent, Channel):
        if getattr(ent, "megagroup", False):
            return "超级群"
        if getattr(ent, "broadcast", False):
            return "频道"
        return "Channel（其它）"
    return type(ent).__name__


async def print_group_entity_info(client, group_id: int) -> None:
    """连接后打印 get_entity 解析到的群/频道信息。"""
    try:
        ent = await client.get_entity(group_id)
    except ValueError:
        print(f"[!] id={group_id} 无法解析，请确认账号已加入该群/频道。", flush=True)
        return
    except Exception as e:
        print(f"[!] id={group_id} get_entity 出错: {type(e).__name__}: {e}", flush=True)
        return

    title = getattr(ent, "title", None) or getattr(ent, "first_name", "") or "(无标题)"
    username = getattr(ent, "username", None)
    kind = _entity_kind(ent)
    print(f"[*] 对话 id={group_id}", flush=True)
    print(f"    标题: {title}", flush=True)
    print(
        f"    公开用户名: @{username}" if username else "    公开用户名: (无，私有或仅邀请)",
        flush=True,
    )
    print(f"    类型: {kind}", flush=True)
    if isinstance(ent, Channel):
        print(
            f"    megagroup={getattr(ent, 'megagroup', False)}  "
            f"broadcast={getattr(ent, 'broadcast', False)}  "
            f"（超级群 megagroup=True；广播频道 broadcast=True）",
            flush=True,
        )


async def main() -> None:
    group_ids = get_monitored_group_ids()
    if not group_ids:
        default_file = monitored_groups_file_default()
        print(
            "[!] 监控列表为空。请在以下任一方式配置群组 id：\n"
            f"  1) 创建文件 {default_file}（每行一个 id，# 可注释）\n"
            "  2) 或在 .env 设置 TELEGRAM_MONITORED_GROUP_IDS=-100xxx,-100yyy\n"
            "  3) 或设置 TELEGRAM_MONITORED_GROUPS_FILE 指向你的列表文件\n"
            "可用 list_groups.py（用户号）先列出 id。",
            flush=True,
        )
        raise SystemExit(2)

    state_path = get_poll_state_path()
    interval = get_poll_interval_seconds()
    state = _load_state(state_path)

    print(f"[+] 监控 {len(group_ids)} 个对话: {group_ids}", flush=True)
    print(f"[+] 轮询间隔 {interval}s，状态文件 {state_path}", flush=True)

    client, _session_path = await create_and_start_client()

    try:
        while True:
            raw_ids = get_monitored_group_ids()
            group_ids = await _filter_resolvable_ids(client, raw_ids)
            if group_ids:
                print(f"[+] 实际可拉取 {len(group_ids)} 个对话: {group_ids}", flush=True)
                for gid in group_ids:
                    await print_group_entity_info(client, gid)
                break
            print(
                "[!] 当前没有任何可解析的群/频道 id（例如文件里只有注释、或只剩私聊正数 user id）。\n"
                f"    请编辑 {monitored_groups_file_default()}：取消群 id 前的 #，并写入已加入的超级群（-100…）。\n"
                f"    {interval}s 后自动重新读取列表；保持已登录连接。（Ctrl+C 退出）",
                flush=True,
            )
            await asyncio.sleep(interval)

        seed_failed: list[int] = []
        for gid in group_ids:
            if not await _bootstrap_chat_history(client, gid, state):
                seed_failed.append(gid)
        if seed_failed:
            group_ids = [g for g in group_ids if g not in seed_failed]
            print(f"[+] 启动快照失败已剔除: {seed_failed}，剩余 {group_ids}", flush=True)
        if not group_ids:
            print("[!] 没有可轮询的对话，退出。", flush=True)
            raise SystemExit(2)
        _save_state(state_path, state)

        skip_gids: set[int] = set()
        round_no = 0
        while True:
            round_no += 1
            print(f"--- 轮次 {round_no} ---", flush=True)
            for gid in group_ids:
                if gid in skip_gids:
                    continue
                key = str(gid)
                try:
                    if int(state.get(_boot_key(gid), 0)) != 1:
                        if not await _bootstrap_chat_history(client, gid, state):
                            skip_gids.add(gid)
                            continue
                        _save_state(state_path, state)

                    last = int(state.get(key, 0))
                    new_msgs, new_last = await _pull_new(client, gid, last)
                    if new_msgs:
                        for message in new_msgs:
                            await format_message_console(
                                client,
                                message,
                                preview=_PREVIEW,
                                prefix=f"  [新消息 {message.date}] chat={gid}",
                            )
                        state[key] = new_last
                        _save_state(state_path, state)
                except FloodWaitError as e:
                    wait = int(e.seconds) + 1
                    print(f"[!] FloodWait {e.seconds}s（chat={gid}），等待 {wait}s…", flush=True)
                    await asyncio.sleep(wait)
                except Exception as e:
                    print(f"[!] chat={gid} 拉取失败: {type(e).__name__}: {e}", flush=True)
                    traceback.print_exc()

            await asyncio.sleep(interval)
    finally:
        await client.disconnect()


if __name__ == "__main__":
    setup_telethon_logging()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[*] 已退出", flush=True)
        sys.exit(130)
