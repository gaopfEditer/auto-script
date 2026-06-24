"""串行入队队列."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

from .archive_exists import archive_exists
from .video_id import parse_youtube_video_id

JobStatus = Literal["pending", "running", "skipped", "done", "failed"]


@dataclass
class FetchJob:
    id: int
    video_id: str
    url: str
    lang: str | None
    status: JobStatus
    enqueued_at: str
    reason: str | None = None
    title: str | None = None
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "videoId": self.video_id,
            "url": self.url,
            "lang": self.lang,
            "status": self.status,
            "reason": self.reason,
            "title": self.title,
            "error": self.error,
            "enqueuedAt": self.enqueued_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
        }


class FetchQueue:
    def __init__(
        self,
        archives_dir: Path,
        log: logging.Logger,
        fetch_and_archive: Callable[[str, str | None], Awaitable[dict[str, Any]]],
        max_history: int = 200,
    ) -> None:
        self.archives_dir = archives_dir
        self.log = log
        self.fetch_and_archive = fetch_and_archive
        self.max_history = max_history
        self.jobs: list[FetchJob] = []
        self._seq = 0
        self._running: FetchJob | None = None
        self._chain: asyncio.Task | None = None

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    def _trim(self) -> None:
        if len(self.jobs) > self.max_history:
            del self.jobs[self.max_history :]

    async def _run_job(self, job: FetchJob) -> None:
        self._running = job
        job.status = "running"
        job.started_at = self._now()
        self.log.info("队列开始 #%s %s", job.id, job.video_id)
        try:
            out = await self.fetch_and_archive(job.video_id, job.lang)
            job.status = "done"
            job.title = out.get("title")
            job.finished_at = self._now()
            self.log.info("队列完成 #%s %s", job.id, job.video_id)
        except Exception as e:
            job.status = "failed"
            job.error = str(e)
            job.finished_at = self._now()
            self.log.warning("队列失败 #%s %s: %s", job.id, job.video_id, job.error)
        finally:
            self._running = None

    def _schedule(self, job: FetchJob) -> None:
        async def runner() -> None:
            if self._chain is not None:
                try:
                    await self._chain
                except Exception:
                    pass
            await self._run_job(job)

        self._chain = asyncio.create_task(runner())

    async def enqueue(self, url: str, lang: str | None = None) -> dict[str, Any]:
        raw_url = url.strip()
        video_id = parse_youtube_video_id(raw_url)
        if not video_id:
            return {"ok": False, "error": "无法解析 YouTube video id", "url": raw_url}

        canonical = (
            raw_url
            if ("youtube" in raw_url or "youtu.be" in raw_url)
            else f"https://www.youtube.com/watch?v={video_id}"
        )

        if archive_exists(self.archives_dir, video_id):
            self._seq += 1
            job = FetchJob(
                self._seq,
                video_id,
                canonical,
                lang,
                "skipped",
                self._now(),
                reason="archived",
                finished_at=self._now(),
            )
            self.jobs.insert(0, job)
            self._trim()
            return {"ok": True, "queued": False, "skipped": True, "job": job.to_dict()}

        dup = next(
            (
                j
                for j in self.jobs
                if j.video_id == video_id and j.status in ("pending", "running")
            ),
            None,
        )
        if dup:
            return {"ok": True, "queued": False, "duplicate": True, "job": dup.to_dict()}

        self._seq += 1
        job = FetchJob(self._seq, video_id, canonical, lang, "pending", self._now())
        self.jobs.insert(0, job)
        self._trim()
        self._schedule(job)
        return {"ok": True, "queued": True, "job": job.to_dict()}

    async def enqueue_many(self, urls: list[str], lang: str | None = None) -> list[dict[str, Any]]:
        results = []
        for url in urls:
            results.append(await self.enqueue(url, lang))
        return results

    def snapshot(self) -> dict[str, Any]:
        pending = sum(1 for j in self.jobs if j.status == "pending")
        return {
            "pending": pending,
            "running": 1 if self._running else 0,
            "runningJobId": self._running.id if self._running else None,
            "total": len(self.jobs),
        }

    def list_jobs(self, limit: int = 80) -> dict[str, Any]:
        lim = max(1, min(500, limit))
        return {**self.snapshot(), "jobs": [j.to_dict() for j in self.jobs[:lim]]}
