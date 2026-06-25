"""FastAPI HTTP 服务 — 与 Node 版 youtube-fetch API 兼容."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .cdp_client import CdpTranscriptClient
from .config import Settings, load_settings
from .fetch_queue import FetchQueue
from .fetch_transcript import TranscriptFetcher
from .logger import get_logger, set_log_level
from .video_id import parse_youtube_video_id

settings: Settings
client: CdpTranscriptClient
fetcher: TranscriptFetcher
queue: FetchQueue
log = get_logger("server")


class TranscriptBody(BaseModel):
    url: str | None = None
    videoId: str | None = Field(None, alias="videoId")
    v: str | None = None
    lang: str | None = None
    raw: bool | str | None = None
    save: bool | str | None = None

    model_config = {"populate_by_name": True}


class QueueBody(BaseModel):
    url: str | None = None
    urls: list[str] | None = None
    lang: str | None = None


def _truthy(v: Any) -> bool:
    if v is True:
        return True
    return str(v).lower() in ("1", "true", "yes")


def _read_video_input(
    video_id_param: str | None = None,
    query: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
) -> str:
    if video_id_param:
        return video_id_param
    q = query or {}
    b = body or {}
    for key in ("url", "videoId", "v"):
        val = q.get(key) or b.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


async def handle_transcript(
    input_str: str, lang: str | None, raw_only: bool, save: bool
) -> tuple[int, dict[str, Any]]:
    video_id = parse_youtube_video_id(input_str)
    if not video_id:
        return 400, {"ok": False, "error": "无法解析 YouTube video id", "input": input_str}
    if not client.ready:
        return 503, {"ok": False, "error": "CDP 未就绪，请确认 Chrome 已开启 remote debugging"}

    try:
        if raw_only:
            markdown = await client.fetch_transcript_text(video_id, lang)
            return 200, {
                "ok": True,
                "videoId": video_id,
                "lang": lang,
                "format": "markdown",
                "text": markdown,
            }
        out = await fetcher.fetch_transcript(video_id, lang, save)
        saved = out.get("saved")
        return 200, {
            "ok": True,
            "videoId": video_id,
            "lang": lang,
            "title": out["title"],
            "sourceUrl": out["sourceUrl"],
            "languageLine": out["languageLine"],
            "charCount": out["charCount"],
            "wordCount": out["wordCount"],
            "transcript": out["transcript"],
            "saved": {"md": saved["mdPath"], "json": saved["jsonPath"]} if saved else None,
        }
    except Exception as e:
        log.warning("拉取失败 videoId=%s: %s", video_id, e)
        return 502, {"ok": False, "error": str(e), "videoId": video_id}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global settings, client, fetcher, queue
    settings = load_settings()
    set_log_level(settings.log_level)
    client = CdpTranscriptClient(
        settings.cdp_connect_url,
        settings.transcript_site,
        settings.fetch_timeout_ms,
        get_logger("cdp"),
    )
    await client.connect()
    fetcher = TranscriptFetcher(client, settings.archives_dir, get_logger("fetch"))
    queue = FetchQueue(
        settings.archives_dir,
        get_logger("queue"),
        fetcher.fetch_and_archive,
    )
    log.info("HTTP API http://127.0.0.1:%s", settings.port)
    yield
    await client.close()


app = FastAPI(title="youtube-fetch-py", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "cdpReady": client.ready,
        "cdpUrl": settings.cdp_connect_url,
        "site": settings.transcript_site,
        "queue": queue.snapshot(),
        "runtime": "python",
    }


@app.get("/api/transcript/{video_id}")
async def get_transcript_by_id(
    video_id: str,
    lang: str | None = Query(None),
    raw: str | None = Query(None),
    save: str | None = Query(None),
):
    status, body = await handle_transcript(
        video_id, lang, _truthy(raw), _truthy(save)
    )
    return JSONResponse(status_code=status, content=body)


@app.get("/api/transcript")
async def get_transcript(
    request: Request,
    lang: str | None = Query(None),
    raw: str | None = Query(None),
    save: str | None = Query(None),
):
    input_str = _read_video_input(query=dict(request.query_params))
    if not input_str:
        return JSONResponse(400, {"ok": False, "error": "缺少 url / videoId 查询参数"})
    status, body = await handle_transcript(
        input_str, lang, _truthy(raw), _truthy(save)
    )
    return JSONResponse(status_code=status, content=body)


@app.post("/api/transcript")
async def post_transcript(body: TranscriptBody):
    input_str = _read_video_input(body=body.model_dump(by_alias=True))
    if not input_str:
        return JSONResponse(400, {"ok": False, "error": "请求体需包含 url 或 videoId"})
    status, resp = await handle_transcript(
        input_str,
        body.lang,
        _truthy(body.raw),
        _truthy(body.save),
    )
    return JSONResponse(status_code=status, content=resp)


@app.post("/api/queue")
async def post_queue(body: QueueBody):
    urls: list[str] = []
    if body.url and body.url.strip():
        urls.append(body.url.strip())
    if body.urls:
        urls.extend(u.strip() for u in body.urls if u and u.strip())
    if not urls:
        return JSONResponse(400, {"ok": False, "error": "请求体需包含 url 或 urls[]"})

    results = await queue.enqueue_many(urls, body.lang)
    invalid = [r for r in results if not r.get("ok")]
    status = 400 if len(invalid) == len(results) else 200
    return JSONResponse(
        status_code=status,
        content={"ok": len(invalid) < len(results), "results": results, "queue": queue.snapshot()},
    )


@app.get("/api/queue")
async def get_queue(limit: int = Query(80, ge=1, le=500)):
    return {"ok": True, **queue.list_jobs(limit)}
