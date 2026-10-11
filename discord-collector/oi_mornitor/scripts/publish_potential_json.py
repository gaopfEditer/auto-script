#!/usr/bin/env python3
"""发布 potential.json → GitHub gh-pages（仅命中 candidates）。

用法:
  GITHUB_TOKEN=... python oi_mornitor/scripts/publish_potential_json.py \\
    oi_mornitor/data/potential.json

或（仓库根）:
  pnpm run oi:publish-potential -- oi_mornitor/data/potential.json

流程: GET contents/potential.json?ref=gh-pages 取 sha → PUT 同路径（base64 + sha）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from oi_mornitor.potential_github_publish import publish_potential_json


def main() -> None:
    p = argparse.ArgumentParser(description="Upload potential.json to crypto-news gh-pages")
    p.add_argument(
        "local_path",
        type=Path,
        help="本地 potential.json（仅含 candidates 的 export 文档）",
    )
    p.add_argument("--repo", default=None, help="默认 gaopfEditer/crypto-news 或 POTENTIAL_GH_REPO")
    p.add_argument("--branch", default=None, help="默认 gh-pages")
    p.add_argument("--path", dest="gh_path", default=None, help="仓库内路径，默认 potential.json")
    p.add_argument("-m", "--message", default=None, help="commit message")
    args = p.parse_args()
    publish_potential_json(
        args.local_path,
        repo=args.repo,
        branch=args.branch,
        file_path=args.gh_path,
        commit_message=args.message,
    )


if __name__ == "__main__":
    main()
