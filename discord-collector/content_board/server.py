"""图文内容板 HTTP API（aiohttp + SQLite）。默认 :8767。"""
from __future__ import annotations

import argparse
import logging
import mimetypes
import os
from pathlib import Path
from typing import Any

from aiohttp import web

from content_board.store import ContentStore

log = logging.getLogger("content_board")
PKG_ROOT = Path(__file__).resolve().parent
DEFAULT_HOST = os.getenv("CONTENT_BOARD_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.getenv("CONTENT_BOARD_PORT", "8767"))
DATA_DIR = Path(os.getenv("CONTENT_BOARD_DATA", str(PKG_ROOT / "data")))


def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda o: __import__("json").dumps(o, ensure_ascii=False))


async def handle_health(_request: web.Request) -> web.Response:
    return _json({"ok": True, "service": "content_board"})


async def handle_list_posts(request: web.Request) -> web.Response:
    store: ContentStore = request.app["store"]
    try:
        limit = int(request.query.get("limit", "50"))
    except ValueError:
        limit = 50
    try:
        offset = int(request.query.get("offset", "0"))
    except ValueError:
        offset = 0
    return _json({"ok": True, **store.list_posts(limit=limit, offset=offset)})


async def handle_get_post(request: web.Request) -> web.Response:
    store: ContentStore = request.app["store"]
    try:
        post_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        return _json({"ok": False, "error": "invalid id"}, status=400)
    post = store.get_post(post_id)
    if not post:
        return _json({"ok": False, "error": "not found"}, status=404)
    return _json({"ok": True, "post": post})


async def handle_create_post(request: web.Request) -> web.Response:
    store: ContentStore = request.app["store"]
    ct = request.content_type or ""
    title = ""
    body = ""
    files: list[tuple[bytes, str, str]] = []

    if "multipart" in ct:
        reader = await request.multipart()
        while True:
            part = await reader.next()
            if part is None:
                break
            name = part.name or ""
            if name == "title":
                title = (await part.text()).strip()
            elif name == "body":
                body = await part.text()
            elif name in ("image", "images", "file", "files"):
                raw = await part.read(decode=False)
                if raw:
                    files.append(
                        (
                            raw,
                            part.filename or "image.jpg",
                            part.headers.get("Content-Type", ""),
                        )
                    )
    else:
        try:
            payload = await request.json()
        except Exception:
            return _json({"ok": False, "error": "invalid json"}, status=400)
        title = str(payload.get("title") or "").strip()
        body = str(payload.get("body") or "")

    if not title and not body and not files:
        return _json({"ok": False, "error": "title/body/image 至少填一项"}, status=400)

    post = store.create_post(title=title, body=body)
    for raw, fname, mime in files:
        store.add_image(post["id"], data=raw, original_name=fname, content_type=mime)
    post = store.get_post(post["id"])
    return _json({"ok": True, "post": post}, status=201)


async def handle_update_post(request: web.Request) -> web.Response:
    store: ContentStore = request.app["store"]
    try:
        post_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        return _json({"ok": False, "error": "invalid id"}, status=400)
    try:
        payload = await request.json()
    except Exception:
        return _json({"ok": False, "error": "invalid json"}, status=400)
    title = payload.get("title")
    body = payload.get("body")
    if title is not None:
        title = str(title)
    if body is not None:
        body = str(body)
    post = store.update_post(post_id, title=title, body=body)
    if not post:
        return _json({"ok": False, "error": "not found"}, status=404)
    return _json({"ok": True, "post": post})


async def handle_delete_post(request: web.Request) -> web.Response:
    store: ContentStore = request.app["store"]
    try:
        post_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        return _json({"ok": False, "error": "invalid id"}, status=400)
    if not store.delete_post(post_id):
        return _json({"ok": False, "error": "not found"}, status=404)
    return _json({"ok": True})


async def handle_upload_image(request: web.Request) -> web.Response:
    store: ContentStore = request.app["store"]
    try:
        post_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        return _json({"ok": False, "error": "invalid id"}, status=400)
    if "multipart" not in (request.content_type or ""):
        return _json({"ok": False, "error": "需要 multipart"}, status=400)
    reader = await request.multipart()
    saved = None
    while True:
        part = await reader.next()
        if part is None:
            break
        if (part.name or "") not in ("image", "images", "file", "files"):
            continue
        raw = await part.read(decode=False)
        if not raw:
            continue
        saved = store.add_image(
            post_id,
            data=raw,
            original_name=part.filename or "image.jpg",
            content_type=part.headers.get("Content-Type", ""),
        )
        break
    if saved is None:
        if store.get_post(post_id) is None:
            return _json({"ok": False, "error": "not found"}, status=404)
        return _json({"ok": False, "error": "未收到图片"}, status=400)
    return _json({"ok": True, "image": saved, "post": store.get_post(post_id)}, status=201)


async def handle_delete_image(request: web.Request) -> web.Response:
    store: ContentStore = request.app["store"]
    try:
        image_id = int(request.match_info["id"])
    except (KeyError, ValueError):
        return _json({"ok": False, "error": "invalid id"}, status=400)
    if not store.delete_image(image_id):
        return _json({"ok": False, "error": "not found"}, status=404)
    return _json({"ok": True})


async def handle_file(request: web.Request) -> web.Response:
    store: ContentStore = request.app["store"]
    filename = request.match_info.get("filename", "")
    path = store.resolve_file(filename)
    if not path:
        return _json({"ok": False, "error": "not found"}, status=404)
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return web.FileResponse(path, headers={"Content-Type": ctype, "Cache-Control": "public, max-age=86400"})


def create_app(*, data_dir: Path | None = None) -> web.Application:
    root = data_dir or DATA_DIR
    store = ContentStore(root / "content.db", root / "uploads")
    app = web.Application(client_max_size=32 * 1024 * 1024)
    app["store"] = store
    app.router.add_get("/api/health", handle_health)
    app.router.add_get("/api/content/health", handle_health)
    app.router.add_get("/api/content/posts", handle_list_posts)
    app.router.add_get("/api/content/posts/{id}", handle_get_post)
    app.router.add_post("/api/content/posts", handle_create_post)
    app.router.add_put("/api/content/posts/{id}", handle_update_post)
    app.router.add_delete("/api/content/posts/{id}", handle_delete_post)
    app.router.add_post("/api/content/posts/{id}/images", handle_upload_image)
    app.router.add_delete("/api/content/images/{id}", handle_delete_image)
    app.router.add_get("/api/content/files/{filename}", handle_file)
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Content board API")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--data", default=str(DATA_DIR))
    args = parser.parse_args()
    app = create_app(data_dir=Path(args.data))
    log.info("content_board listening http://%s:%s  data=%s", args.host, args.port, args.data)
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
