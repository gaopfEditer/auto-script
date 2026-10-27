"""将本地 potential.json 发布到 GitHub gh-pages（仅 candidates，无全市场原始数据）。"""
from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_REPO = "gaopfEditer/crypto-news"
DEFAULT_BRANCH = "gh-pages"
DEFAULT_PATH = "potential.json"
API_ROOT = "https://api.github.com"


def _load_github_token() -> str:
    tok = (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    if tok:
        return tok
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if env_path.is_file():
        try:
            from dotenv import dotenv_values

            vals = dotenv_values(env_path)
            tok = str(vals.get("GITHUB_TOKEN") or vals.get("GH_TOKEN") or "").strip()
            if tok:
                return tok
        except ImportError:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                if k.strip() in ("GITHUB_TOKEN", "GH_TOKEN"):
                    return v.strip().strip('"').strip("'")
    return ""


def sanitize_export_doc(raw: dict[str, Any]) -> dict[str, Any]:
    """只保留看板/export 字段，丢弃任何全市场原始行。"""
    allowed = {
        "updated_utc8",
        "refresh_hours",
        "source_note",
        "risk_hint",
        "candidates",
        "fast_scan_at_utc8",
        "slow_scan_at_utc8",
    }
    out = {k: raw[k] for k in allowed if k in raw}
    cands = out.get("candidates")
    if not isinstance(cands, list):
        out["candidates"] = []
    else:
        clean: list[dict[str, Any]] = []
        for c in cands:
            if not isinstance(c, dict) or not c.get("symbol"):
                continue
            clean.append(c)
        out["candidates"] = clean
    if "source_note" not in out:
        out["source_note"] = "local filtered candidates only"
    return out


def read_and_validate(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("potential.json 根节点必须是 object")
    return sanitize_export_doc(data)


def _request(
    method: str,
    url: str,
    token: str,
    body: dict[str, Any] | None = None,
) -> tuple[int, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "oi-mornitor-potential-publish",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        return exc.code, payload


def get_file_sha(
    token: str,
    owner: str,
    repo: str,
    path: str,
    branch: str,
    *,
    die: bool = True,
) -> str | None:
    url = f"{API_ROOT}/repos/{owner}/{repo}/contents/{path}?ref={branch}"
    status, text = _request("GET", url, token)
    if status == 404:
        return None
    if status != 200:
        msg = f"GET contents 失败 HTTP {status}\n{text}"
        if die:
            print(msg, file=sys.stderr)
            raise SystemExit(1)
        raise RuntimeError(msg)
    meta = json.loads(text)
    sha = meta.get("sha") if isinstance(meta, dict) else None
    return str(sha) if sha else None


def publish_potential_json(
    local_path: Path | str,
    *,
    repo: str | None = None,
    branch: str | None = None,
    file_path: str | None = None,
    token: str | None = None,
    commit_message: str | None = None,
    die_on_error: bool = True,
) -> bool:
    """GET sha → PUT base64 更新 gh-pages 上的 potential.json。"""
    path = Path(local_path).expanduser().resolve()
    def _fail(msg: str, code: int = 1) -> bool:
        print(msg, file=sys.stderr)
        if die_on_error:
            raise SystemExit(code)
        return False

    if not path.is_file():
        return _fail(f"文件不存在: {path}")

    tok = (token or _load_github_token()).strip()
    if not tok:
        return _fail("缺少 GITHUB_TOKEN（环境变量或 discord-collector/.env）")

    repo_full = (repo or os.environ.get("POTENTIAL_GH_REPO") or DEFAULT_REPO).strip()
    if "/" not in repo_full:
        return _fail(f"无效仓库: {repo_full}")
    owner, repo_name = repo_full.split("/", 1)
    branch_name = (branch or os.environ.get("POTENTIAL_GH_BRANCH") or DEFAULT_BRANCH).strip()
    gh_path = (file_path or os.environ.get("POTENTIAL_GH_PATH") or DEFAULT_PATH).strip().lstrip("/")

    doc = read_and_validate(path)
    content_text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    content_b64 = base64.b64encode(content_text.encode("utf-8")).decode("ascii")

    sha = get_file_sha(tok, owner, repo_name, gh_path, branch_name)
    url = f"{API_ROOT}/repos/{owner}/{repo_name}/contents/{gh_path}"
    msg = commit_message or f"chore: update {gh_path} ({doc.get('updated_utc8') or 'scan'})"
    body: dict[str, Any] = {
        "message": msg,
        "content": content_b64,
        "branch": branch_name,
    }
    if sha:
        body["sha"] = sha

    status, text = _request("PUT", url, tok, body)
    if status not in (200, 201):
        return _fail(f"PUT contents 失败 HTTP {status}\n{text}")
    print(
        f"已发布 {owner}/{repo_name}@{branch_name}:{gh_path} "
        f"（{len(doc.get('candidates') or [])} candidates）"
    )
    return True
