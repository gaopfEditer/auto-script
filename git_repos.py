#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
根据 .env 中的目录列表，批量拉取或推送 Git 仓库。
用法:
  python git_repos.py          # 拉取所有目录中的代码
  python git_repos.py --push   # 推送所有目录中的代码
  python git_repos.py -p       # 同上
  python git_repos.py -p --auto-commit            # 有变更则自动提交并推送
  python git_repos.py -p --auto-commit --message "msg"  # 指定提交信息

pull / push 网络等原因失败时，会自动重试最多 5 次（每次间隔约 2 秒）。
可在脚本顶部修改 GIT_MAX_RETRIES、GIT_RETRY_DELAY_SEC。
"""

import os
import re
import subprocess
import sys
import time
from pathlib import Path

# 脚本所在目录（.env 默认放这里）
SCRIPT_DIR = Path(__file__).resolve().parent
ENV_FILE = SCRIPT_DIR / ".env"
# pull / push 失败时的重试次数（不含首次），例如 5 表示最多共尝试 6 次
GIT_MAX_RETRIES = 5
GIT_RETRY_DELAY_SEC = 2.0


def load_env(path: Path) -> dict:
    """简单解析 .env 文件，支持多行和 | 分隔。"""
    env = {}
    if not path.exists():
        return env
    content = path.read_text(encoding="utf-8", errors="replace")
    current_key = None
    current_values = []
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        # 仅当行首是变量名（字母/下划线开头）且含 = 时视为 KEY=VALUE
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*\s*=", stripped):
            if current_key is not None and current_values:
                env[current_key] = " ".join(current_values)
            key, _, rest = stripped.partition("=")
            current_key = key.strip()
            rest = rest.strip().strip('"').strip("'")
            current_values = [rest] if rest else []
        else:
            if current_key is not None:
                current_values.append(stripped.strip('"').strip("'"))
    if current_key is not None and current_values:
        env[current_key] = " ".join(current_values)
    return env


def get_repo_dirs() -> list[Path]:
    """从 .env 读取 REPO_DIRS，返回规范化的目录路径列表。"""
    env = load_env(ENV_FILE)
    raw = env.get("REPO_DIRS", "").strip()
    if not raw:
        return []
    # 支持 | 或换行/空格分隔
    parts = re.split(r"[\s|]+", raw)
    dirs = []
    for p in parts:
        p = p.strip().strip('"').strip("'")
        if not p:
            continue
        path = Path(p)
        if not path.is_absolute():
            path = SCRIPT_DIR / path
        path = path.resolve()
        if path not in dirs:
            dirs.append(path)
    return dirs


def is_git_repo(path: Path) -> bool:
    return (path / ".git").is_dir()


def run_git(path: Path, args: list[str]) -> tuple[bool, str]:
    """在指定目录执行 git 命令，返回 (成功, 输出)。"""
    try:
        r = subprocess.run(
            ["git"] + args,
            cwd=path,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        out = (r.stdout or "").strip() + "\n" + (r.stderr or "").strip()
        return r.returncode == 0, out.strip()
    except FileNotFoundError:
        return False, "未找到 git 命令"
    except subprocess.TimeoutExpired:
        return False, "执行超时"
    except Exception as e:
        return False, str(e)


def run_git_with_retries(
    path: Path, args: list[str], name: str = "git"
) -> tuple[bool, str, int]:
    """
    执行 git 命令，失败则重试 GIT_MAX_RETRIES 次。
    返回 (是否成功, 最后一次输出, 总尝试次数)。
    """
    last_out = ""
    total = GIT_MAX_RETRIES + 1
    for attempt in range(1, total + 1):
        ok, last_out = run_git(path, args)
        if ok:
            return True, last_out, attempt
        if attempt < total:
            print(
                f"       [{name}] 第 {attempt}/{total} 次失败，"
                f"{GIT_RETRY_DELAY_SEC:.0f}s 后重试…"
            )
            time.sleep(GIT_RETRY_DELAY_SEC)
    return False, last_out, total


def get_git_status_porcelain(path: Path) -> tuple[bool, str]:
    return run_git(path, ["status", "--porcelain"])


def has_upstream(path: Path) -> bool:
    ok, _ = run_git(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    return ok


def count_ahead_commits(path: Path) -> int | None:
    ok, out = run_git(path, ["rev-list", "--count", "@{u}..HEAD"])
    if not ok:
        return None
    try:
        return int(out.strip().splitlines()[-1])
    except Exception:
        return None


def auto_commit_if_needed(path: Path, message: str) -> tuple[bool, str]:
    ok, status = get_git_status_porcelain(path)
    if not ok:
        return False, status
    if not status.strip():
        return True, ""
    ok, out = run_git(path, ["add", "-A"])
    if not ok:
        return False, out
    ok, out = run_git(path, ["commit", "-m", message])
    return ok, out


def main():
    push_mode = "--push" in sys.argv or "-p" in sys.argv
    action = "推送" if push_mode else "拉取"
    auto_commit = "--auto-commit" in sys.argv
    msg = "chore: auto commit"
    if "--message" in sys.argv:
        try:
            msg = sys.argv[sys.argv.index("--message") + 1]
        except Exception:
            pass

    if not ENV_FILE.exists():
        print(f"未找到配置文件: {ENV_FILE}")
        print("请复制 .env.example 为 .env 并填写 REPO_DIRS 目录列表。")
        sys.exit(1)

    dirs = get_repo_dirs()
    if not dirs:
        print("REPO_DIRS 为空或未配置，请检查 .env 中的 REPO_DIRS。")
        sys.exit(1)

    print(f"共 {len(dirs)} 个目录，开始{action}...")
    print("=" * 50)
    failed = []

    for d in dirs:
        if not d.exists():
            print(f"[跳过] 不存在: {d}")
            failed.append((d, "目录不存在"))
            continue
        if not is_git_repo(d):
            print(f"[跳过] 非 Git 仓库: {d}")
            failed.append((d, "不是 Git 仓库"))
            continue

        if not push_mode:
            ok, out, tries = run_git_with_retries(d, ["pull"], name="pull")
            if ok:
                print(f"[成功] {d}")
                if tries > 1:
                    print(f"       （第 {tries} 次尝试成功）")
                if out:
                    for line in out.splitlines()[:5]:
                        print(f"       {line}")
            else:
                print(f"[失败] {d}")
                if out:
                    for line in out.splitlines()[:8]:
                        print(f"       {line}")
                failed.append((d, out or "未知错误"))
            continue

        # push 模式：先给出“是否真的有东西可推”的结论
        if not has_upstream(d):
            ok, branch = run_git(d, ["branch", "--show-current"])
            branch = branch.strip() if ok else ""
            print(f"[失败] {d}")
            print("       未设置远端 upstream，无法判断 ahead/推送。")
            if branch:
                print(f"       当前分支: {branch}")
                print(f"       建议先执行: git push -u origin {branch}")
            failed.append((d, "未设置 upstream"))
            continue

        ok, status = get_git_status_porcelain(d)
        if not ok:
            print(f"[失败] {d}")
            for line in status.splitlines()[:8]:
                print(f"       {line}")
            failed.append((d, status or "git status 失败"))
            continue

        dirty = bool(status.strip())
        ahead = count_ahead_commits(d)

        if dirty and auto_commit:
            okc, outc = auto_commit_if_needed(d, msg)
            if not okc:
                print(f"[失败] {d}")
                print("       自动提交失败：")
                for line in outc.splitlines()[:10]:
                    print(f"       {line}")
                failed.append((d, outc or "自动提交失败"))
                continue
            ahead = count_ahead_commits(d)
            dirty = False

        if dirty and not auto_commit:
            print(f"[跳过] {d}")
            print("       有未提交变更（未开启 --auto-commit），没有可推送提交。")
            for line in status.splitlines()[:8]:
                print(f"       {line}")
            continue

        if ahead is None:
            print(f"[失败] {d}")
            print("       无法判断是否领先远端（rev-list 失败）。")
            failed.append((d, "无法判断 ahead"))
            continue

        if ahead <= 0:
            print(f"[跳过] {d}")
            print("       没有可推送的提交（本地未领先远端）。")
            continue

        ok, out, tries = run_git_with_retries(d, ["push"], name="push")
        if ok:
            print(f"[成功] {d}")
            print(f"       已推送提交数: {ahead}")
            if tries > 1:
                print(f"       （第 {tries} 次尝试成功）")
            if out:
                for line in out.splitlines()[:5]:
                    print(f"       {line}")
        else:
            print(f"[失败] {d}")
            if out:
                for line in out.splitlines()[:8]:
                    print(f"       {line}")
            failed.append((d, out or "未知错误"))

    print("=" * 50)
    if failed:
        print(f"{action}完成，{len(failed)} 个失败。")
        sys.exit(1)
    print(f"全部{action}成功。")


if __name__ == "__main__":
    main()
