#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从接口读取任务列表，在任务节点到达时进行提示。
支持：日度任务、长期任务、间歇调整。

用法:
  python task_notifier.py                    # 使用默认配置运行
  python task_notifier.py --config tasks.json
  python task_notifier.py --url "https://api.example.com/tasks"

配置（.env 或环境变量）:
  TASK_API_URL  任务列表 API 地址（GET 返回 JSON）
  TASK_CONFIG   本地 JSON 文件路径（与 TASK_API_URL 二选一，本地优先）
"""

import json
import os
import sys
import time
import urllib.request
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# 脚本目录
SCRIPT_DIR = Path(__file__).resolve().parent
# 默认本地配置
DEFAULT_CONFIG_PATH = SCRIPT_DIR / "tasks_config.json"
# 轮询间隔（秒）
CHECK_INTERVAL = 30
# 已提示过的节点在多少秒内不再重复提示
COOLDOWN_SECONDS = 60


def load_env() -> dict:
    """从 .env 读取配置（简单解析）。"""
    env_path = SCRIPT_DIR / ".env"
    env = {}
    if not env_path.exists():
        return env
    content = env_path.read_text(encoding="utf-8", errors="replace")
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in env:
            env[key] = value
    # 环境变量优先级更高
    for k, v in os.environ.items():
        if k.startswith("TASK_"):
            env[k] = v
    return env


def fetch_json_from_url(url: str, timeout: int = 10) -> dict:
    """从 URL GET 请求获取 JSON。"""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def load_json_file(path: Path) -> dict:
    """从本地文件加载 JSON。"""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_task_data(config_path: Optional[Path], api_url: Optional[str]) -> dict:
    """优先从本地 config 加载，否则从 API 拉取。"""
    if config_path and config_path.exists():
        return load_json_file(config_path)
    if api_url and api_url.strip():
        return fetch_json_from_url(api_url.strip())
    if DEFAULT_CONFIG_PATH.exists():
        return load_json_file(DEFAULT_CONFIG_PATH)
    return {}


@dataclass
class TaskNode:
    """一个可触发的任务节点。"""
    task_type: str   # daily | long_term | intermittent
    task_id: str
    title: str
    message: str
    trigger_at: datetime
    extra: str = ""  # 如里程碑名称、第几次间歇等
    last_notified: float = 0  # 上次提示时间戳，用于冷却


def parse_time_today(hhmm: str) -> datetime:
    """解析 'HH:MM' 或 'HH:MM:SS' 为今天的 datetime。"""
    parts = hhmm.strip().split(":")
    h, m = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
    s = int(parts[2]) if len(parts) > 2 else 0
    now = datetime.now()
    return now.replace(hour=h, minute=m, second=s, microsecond=0)


def parse_datetime(s: str) -> Optional[datetime]:
    """解析 'YYYY-MM-DD HH:MM' 或类似格式。"""
    s = s.strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def build_nodes(data: dict) -> list[TaskNode]:
    """将 API/JSON 数据转换为 TaskNode 列表（含今日/当前周期内会触发的）。"""
    nodes: list[TaskNode] = []
    now = datetime.now()
    today = now.date()

    # 日度任务：每天 trigger_at 触发
    for t in data.get("daily_tasks", []):
        trigger_at_str = t.get("trigger_at") or t.get("time")
        if not trigger_at_str:
            continue
        try:
            trigger_at = parse_time_today(trigger_at_str)
            if trigger_at >= now or (trigger_at.date() == today and (now - trigger_at).total_seconds() < 3600):
                nodes.append(TaskNode(
                    task_type="daily",
                    task_id=str(t.get("id", "")),
                    title=str(t.get("title", "日度任务")),
                    message=str(t.get("message", "")) if t.get("message") is not None else "",
                    trigger_at=trigger_at,
                    extra="",
                ))
        except (ValueError, TypeError):
            continue

    # 长期任务：按 milestones 的 at 作为节点
    for t in data.get("long_term_tasks", []):
        for m in t.get("milestones", []):
            at_str = m.get("at") or m.get("time")
            if not at_str:
                continue
            trigger_at = parse_datetime(at_str)
            if not trigger_at or trigger_at < now:
                continue
            if (trigger_at - now).total_seconds() > 7 * 24 * 3600:
                continue  # 只保留 7 天内的节点，减少内存
            nodes.append(TaskNode(
                task_type="long_term",
                task_id=str(t.get("id", "")),
                title=str(t.get("title", "长期任务")),
                message=str(m.get("message", "")) if m.get("message") is not None else "",
                trigger_at=trigger_at,
                extra=str(m.get("name", "")),
            ))

    # 间歇调整：按 interval_minutes 周期性触发（从启动时刻起算）
    for t in data.get("intermittent_tasks", []):
        try:
            interval = int(t.get("interval_minutes", 60))
        except (TypeError, ValueError):
            continue
        if interval <= 0:
            continue
        # 下一个触发点：启动后第一个整间隔
        nodes.append(TaskNode(
            task_type="intermittent",
            task_id=str(t.get("id", "")),
            title=str(t.get("title", "间歇调整")),
            message=str(t.get("message", "")) if t.get("message") is not None else "",
            trigger_at=now + timedelta(minutes=interval),
            extra=f"每 {interval} 分钟",
        ))

    return nodes


def sort_and_dedup_nodes(nodes: list[TaskNode]) -> list[TaskNode]:
    """按触发时间排序；间歇任务只保留“下一个”触发点，由后续逻辑再次生成。"""
    return sorted(nodes, key=lambda n: n.trigger_at)


def show_notification(title: str, message: str) -> None:
    """系统提示：Windows/macOS 全局弹窗；其他回退控制台 + 响铃。"""
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, message, title, 0x40)
        except Exception:
            print(f"\n【{title}】\n{message}\n")
            print("\a", end="", flush=True)
    elif sys.platform == "darwin":
        # 全局弹窗（可打断当前操作）：display dialog
        safe_title = title.replace('"', '\\"')
        safe_msg = message.replace('"', '\\"')
        script = f'display dialog "{safe_msg}" with title "{safe_title}" buttons {{"OK"}} default button "OK"'
        try:
            subprocess.run(["osascript", "-e", script], check=False, capture_output=True, text=True)
        except Exception:
            print(f"\n【{title}】\n{message}\n")
            print("\a", end="", flush=True)
    else:
        print(f"\n【{title}】\n{message}\n")
        print("\a", end="", flush=True)


def run_loop(config_path: Optional[Path], api_url: Optional[str], interval: int = CHECK_INTERVAL) -> None:
    """主循环：定期拉取任务、计算节点、到点提示。"""
    env = load_env()
    api_url = api_url or env.get("TASK_API_URL", "").strip()
    config_path = config_path or (SCRIPT_DIR / env.get("TASK_CONFIG", "") if env.get("TASK_CONFIG") else None) or DEFAULT_CONFIG_PATH

    intermittent_next: dict[str, datetime] = {}  # task_id -> next trigger time
    notified: set[tuple[str, str, float]] = set()  # (task_id, node_key) -> trigger_at timestamp
    last_fetch = 0.0
    data: dict = {}
    nodes: list[TaskNode] = []

    print("任务提醒已启动。日度任务 / 长期任务 / 间歇调整 会在节点到达时弹窗提示。")
    print("配置:", "本地" if (config_path and config_path.exists()) else "API", config_path or api_url or "无")
    print("检查间隔:", interval, "秒。Ctrl+C 退出。\n")

    while True:
        try:
            now = datetime.now()
            now_ts = time.time()
            # 定期重新拉取
            if now_ts - last_fetch > 300:
                data = get_task_data(config_path, api_url)
                last_fetch = now_ts
                nodes = build_nodes(data)
                # 为间歇任务维护下一次触发时间
                for n in nodes:
                    if n.task_type == "intermittent":
                        if n.task_id not in intermittent_next or intermittent_next[n.task_id] <= now:
                            intermittent_next[n.task_id] = n.trigger_at

            # 重新计算当前应检查的节点（含间歇的下一次）
            check_nodes: list[TaskNode] = []
            for n in nodes:
                if n.task_type == "intermittent":
                    next_t = intermittent_next.get(n.task_id)
                    if next_t and next_t <= now + timedelta(seconds=interval + 5):
                        check_nodes.append(TaskNode(
                            task_type=n.task_type,
                            task_id=n.task_id,
                            title=n.title,
                            message=n.message,
                            trigger_at=next_t,
                            extra=n.extra,
                        ))
                else:
                    if n.trigger_at <= now + timedelta(seconds=interval + 5):
                        check_nodes.append(n)

            for n in sort_and_dedup_nodes(check_nodes):
                if n.trigger_at > now:
                    continue
                node_key = f"{n.trigger_at.isoformat()}"
                if (n.task_id, node_key, n.trigger_at.timestamp()) in notified:
                    continue
                if now_ts - getattr(n, "last_notified", 0) < COOLDOWN_SECONDS:
                    continue
                # 触发提示
                type_label = {"daily": "日度任务", "long_term": "长期任务", "intermittent": "间歇调整"}.get(n.task_type, "任务")
                title = f"[{type_label}] {n.title}"
                msg_main = (n.message or "").strip()
                if not msg_main:
                    msg_main = "请处理。"
                msg = f"{msg_main}\n{n.extra}".strip() if n.extra else msg_main
                show_notification(title, msg)
                notified.add((n.task_id, node_key, n.trigger_at.timestamp()))
                # 间歇任务：排下一次
                if n.task_type == "intermittent":
                    match_minutes = 45
                    for t in data.get("intermittent_tasks", []):
                        if str(t.get("id")) == n.task_id:
                            match_minutes = int(t.get("interval_minutes", 45))
                            break
                    intermittent_next[n.task_id] = now + timedelta(minutes=match_minutes)

        except KeyboardInterrupt:
            print("\n已退出。")
            break
        except Exception as e:
            print(f"[错误] {e}", flush=True)
        time.sleep(interval)


def main():
    config_path = None
    api_url = None
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--config" and i + 1 < len(args):
            config_path = Path(args[i + 1]).resolve()
            if not config_path.is_absolute():
                config_path = SCRIPT_DIR / args[i + 1]
            i += 2
        elif args[i] == "--url" and i + 1 < len(args):
            api_url = args[i + 1]
            i += 2
        else:
            i += 1

    run_loop(config_path=config_path, api_url=api_url)


if __name__ == "__main__":
    main()
