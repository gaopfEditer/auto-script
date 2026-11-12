"""短线策略 V1 回测任务（供 /oi 回测页与 /api/backtest/short-term-v1 使用）。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from oi_mornitor.backtest.regime_tips import tip_for, tips_payload
from oi_mornitor.backtest.sequoia_pipeline import resolve_klines_root
from oi_mornitor.backtest_trade_config import OI_BT_FEE_PCT, OI_BT_SLIPPAGE_PCT
from oi_mornitor.pattern_pause import is_paused_kind, kind_option_meta
from oi_mornitor.strategy.short_term_v1.ablation import EXPERIMENT_LABELS, experiment_options, flags_for
from oi_mornitor.strategy.short_term_v1.fills import FILL_RULES_ZH
from oi_mornitor.strategy.short_term_v1.params import (
    PRICE_PROXY_NOTE,
    RESEARCH_DISCLAIMER,
    defaults_dict,
)
from oi_mornitor.strategy.short_term_v1.patterns import default_pattern_kinds
from oi_mornitor.strategy.short_term_v1.setups import SETUP_LABELS, setup_options
from oi_mornitor.strategy.short_term_v1.tiers import TIER_LABELS, tier_catalog_for_api
from oi_mornitor.structure_backtest import KIND_OPTIONS

logger = logging.getLogger(__name__)

_PKG = Path(__file__).resolve().parents[1]
_OUT_DIR = _PKG / "data" / "short_term_v1"

_jobs: dict[str, "Stv1BacktestJob"] = {}
_jobs_lock = asyncio.Lock()
_MAX_JOBS = 8
_MAX_LIST = 40

CATEGORY = "short_term_v1"
CATEGORY_LABEL = "短线策略 V1"


@dataclass
class Stv1BacktestJob:
    id: str
    status: str = "pending"
    error: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] | None = None
    summary: dict[str, Any] | None = None
    items: list[dict[str, Any]] = field(default_factory=list)
    by_setup: dict[str, Any] = field(default_factory=dict)
    by_tier: dict[str, Any] = field(default_factory=dict)
    by_regime: dict[str, Any] = field(default_factory=dict)
    started_at: float = 0.0
    finished_at: float = 0.0
    category: str = CATEGORY
    category_label: str = CATEGORY_LABEL


def _kind_options() -> list[dict[str, Any]]:
    setups = [{"id": s["id"], "label": s["label"], "side": "", "paused": False, "group": "setup"} for s in setup_options()]
    pats: list[dict[str, Any]] = []
    for k in KIND_OPTIONS:
        meta = kind_option_meta(k["id"], k["label"], k["side"])
        meta["group"] = "pattern"
        pats.append(meta)
    return setups + pats


def stv1_options() -> dict[str, Any]:
    root = resolve_klines_root()
    default_kinds = default_pattern_kinds(include_paused=False)
    return {
        "category": CATEGORY,
        "categoryLabel": CATEGORY_LABEL,
        "experiments": experiment_options(),
        "defaultExperiment": "E",
        "kindOptions": _kind_options(),
        "defaultKinds": default_kinds,
        "setupOptions": setup_options(),
        "pausedNote": (
            "底部二次探底确认默认暂停（研究可勾选）；"
            "射击之星（含连续走平）默认启用，须过情境闸。"
        ),
        "pausedBottomSecondaryDefault": True,
        "pausedShootingStarDefault": False,
        "universes": [
            {"id": "crypto_no_equity", "label": "加密货币（不含美股代币）"},
            {"id": "majors", "label": "BTC / ETH"},
            {"id": "majors_sol", "label": "BTC / ETH / SOL"},
        ],
        "defaultUniverse": "crypto_no_equity",
        "tiers": tier_catalog_for_api(),
        "settleRules": FILL_RULES_ZH,
        "priceProxyNote": PRICE_PROXY_NOTE,
        "disclaimer": RESEARCH_DISCLAIMER,
        "defaults": defaults_dict(),
        "klinesRoot": str(root),
        "outDir": str(_OUT_DIR),
        "regimeTip": tip_for("short_term_v1"),
        "regimeTips": tips_payload("short_term_v1"),
        "feePct": OI_BT_FEE_PCT,
        "slippagePct": OI_BT_SLIPPAGE_PCT,
        "cli": (
            "PYTHONPATH=. oi_mornitor/venv/bin/python -m oi_mornitor.scripts.run_short_term_strategy_v1 "
            "--symbols BTCUSDT,ETHUSDT --experiment E"
        ),
    }


def job_to_dict(job: Stv1BacktestJob, *, include_items: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ok": True,
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "params": job.params,
        "progress": job.progress,
        "summary": job.summary,
        "bySetup": job.by_setup,
        "byTier": job.by_tier,
        "byRegime": job.by_regime,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "category": job.category,
        "categoryLabel": job.category_label,
        "itemCount": len(job.items),
        "fillRules": FILL_RULES_ZH,
        "priceProxyNote": PRICE_PROXY_NOTE,
        "disclaimer": RESEARCH_DISCLAIMER,
    }
    if include_items:
        out["items"] = job.items[:200]
        if len(job.items) > 200:
            out["itemsTruncated"] = True
    if job.result:
        out["result"] = {
            k: job.result.get(k)
            for k in (
                "universe", "experiment", "symbols", "itemCount", "skippedCount",
                "elapsed_sec", "out_dir", "klines_root", "dryRun", "feePct", "slippagePct",
            )
            if isinstance(job.result, dict) and k in job.result
        }
        if isinstance(job.result.get("experiment"), dict):
            out["result"]["experiment"] = job.result["experiment"]
    return out


def get_stv1_job(job_id: str) -> Stv1BacktestJob | None:
    jid = str(job_id or "").strip()
    if not jid:
        return None
    job = _jobs.get(jid)
    if job:
        return job
    path = _OUT_DIR / f"{jid}.json"
    if path.is_file():
        return _job_from_disk(path, jid)
    # dated folders
    latest = _OUT_DIR / "latest_summary.json"
    if latest.is_file():
        try:
            data = json.loads(latest.read_text(encoding="utf-8"))
            if isinstance(data, dict) and str(data.get("jobId") or "") == jid:
                return _job_from_payload(data, jid)
        except Exception:  # noqa: BLE001
            pass
    return None


def _job_from_payload(data: dict[str, Any], jid: str) -> Stv1BacktestJob:
    return Stv1BacktestJob(
        id=jid,
        status="done",
        params=data.get("params") if isinstance(data.get("params"), dict) else {},
        summary=data.get("summary") if isinstance(data.get("summary"), dict) else None,
        by_setup=data.get("bySetup") or data.get("by_setup") or {},
        by_tier=data.get("byTier") or data.get("by_tier") or {},
        by_regime=data.get("byRegime") or data.get("by_regime") or {},
        items=list(data.get("items") or []) if isinstance(data.get("items"), list) else [],
        result=data,
    )


def _job_from_disk(path: Path, jid: str) -> Stv1BacktestJob | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    return _job_from_payload(data, jid)


def get_latest_stv1_job() -> Stv1BacktestJob | None:
    mem = list(_jobs.values())
    if mem:
        mem.sort(key=lambda j: j.started_at or 0, reverse=True)
        return mem[0]
    latest = _OUT_DIR / "latest_summary.json"
    if not latest.is_file():
        return None
    try:
        data = json.loads(latest.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    return _job_from_payload(data, str(data.get("jobId") or "latest"))


def list_stv1_jobs(limit: int = 40) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index_path = _OUT_DIR / "index.json"
    if index_path.is_file():
        try:
            raw = json.loads(index_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                rows = [r for r in raw if isinstance(r, dict)]
        except Exception:  # noqa: BLE001
            rows = []
    for j in _jobs.values():
        if j.status in ("running", "pending"):
            rows = [{
                "id": j.id,
                "status": j.status,
                "startedAt": j.started_at,
                "finishedAt": j.finished_at,
                "universe": (j.params or {}).get("universe"),
                "experiment": (j.params or {}).get("experiment"),
                "total": len(j.items),
                "category": CATEGORY,
                "categoryLabel": CATEGORY_LABEL,
            }] + [r for r in rows if str(r.get("id")) != j.id]
    return rows[: max(1, min(int(limit or 40), _MAX_LIST))]


async def _run_job(job: Stv1BacktestJob) -> None:
    job.status = "running"
    job.started_at = time.time()
    job.progress = {"current": "扫描短线策略 V1…"}
    try:
        p = job.params or {}
        loop = asyncio.get_running_loop()

        def _call() -> dict[str, Any]:
            from oi_mornitor.strategy.short_term_v1.runner import run_short_term_v1

            return run_short_term_v1(
                symbols=p.get("symbols") or None,
                universe=str(p.get("universe") or "crypto_no_equity"),
                start_ms=int(p["startMs"]) if p.get("startMs") else None,
                end_ms=int(p["endMs"]) if p.get("endMs") else None,
                experiment=str(p.get("experiment") or "E"),
                fee_pct=float(p["feePct"]) if p.get("feePct") is not None else None,
                slippage_pct=float(p["slippagePct"]) if p.get("slippagePct") is not None else None,
                equity=float(p["equity"]) if p.get("equity") is not None else 10_000.0,
                dry_run=bool(p.get("dryRun")),
                limit_bars=int(p.get("limitBars") or 0),
            )

        result = await loop.run_in_executor(None, _call)
        result["jobId"] = job.id
        job.result = result
        job.summary = result.get("summary") if isinstance(result.get("summary"), dict) else None
        job.by_setup = result.get("bySetup") or {}
        job.by_tier = result.get("byTier") or {}
        job.by_regime = result.get("byRegime") or {}
        job.items = list(result.get("items") or [])
        job.status = "done"
        job.progress = {"current": "完成", "total": len(job.items)}
        _persist(job, result)
    except Exception as exc:  # noqa: BLE001
        logger.exception("短线策略 V1 回测失败")
        job.status = "failed"
        job.error = str(exc)
        job.progress = {"current": "失败"}
    finally:
        job.finished_at = time.time()


def _persist(job: Stv1BacktestJob, result: dict[str, Any]) -> None:
    _OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = dict(result)
    payload["jobId"] = job.id
    payload["params"] = job.params
    path = _OUT_DIR / f"{job.id}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    payload["jobPath"] = str(path)
    index_path = _OUT_DIR / "index.json"
    rows: list[dict[str, Any]] = []
    if index_path.is_file():
        try:
            raw = json.loads(index_path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                rows = [r for r in raw if isinstance(r, dict)]
        except Exception:  # noqa: BLE001
            rows = []
    s = job.summary or {}
    row = {
        "id": job.id,
        "status": job.status,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "universe": (job.params or {}).get("universe"),
        "experiment": (job.params or {}).get("experiment"),
        "total": len(job.items),
        "profitFactor": s.get("profitFactor"),
        "expectancy": s.get("expectancy"),
        "netPnlPct": s.get("netPnlPct", s.get("totalPnlPct")),
        "category": CATEGORY,
        "categoryLabel": CATEGORY_LABEL,
    }
    rows = [row] + [r for r in rows if str(r.get("id")) != job.id]
    index_path.write_text(json.dumps(rows[:_MAX_LIST], ensure_ascii=False, indent=2), encoding="utf-8")


async def start_stv1_backtest(params: dict[str, Any] | None = None) -> Stv1BacktestJob:
    body = params if isinstance(params, dict) else {}
    symbols_raw = body.get("symbols")
    symbols: list[str] | None = None
    if isinstance(symbols_raw, str) and symbols_raw.strip():
        symbols = [s.strip().upper() for s in symbols_raw.split(",") if s.strip()]
    elif isinstance(symbols_raw, list):
        symbols = [str(s).strip().upper() for s in symbols_raw if str(s).strip()]

    exp = flags_for(body.get("experiment") or body.get("experimentId") or "E")
    job = Stv1BacktestJob(
        id=uuid.uuid4().hex[:12],
        params={
            "universe": str(body.get("universe") or "crypto_no_equity"),
            "experiment": exp.id,
            "symbols": symbols,
            "startMs": body.get("startMs") or body.get("start_ms"),
            "endMs": body.get("endMs") or body.get("end_ms"),
            "feePct": body.get("feePct", body.get("fee")),
            "slippagePct": body.get("slippagePct", body.get("slippage")),
            "equity": body.get("equity"),
            "dryRun": bool(body.get("dryRun") or body.get("dry_run")),
            "limitBars": body.get("limitBars") or body.get("limit_bars"),
            "kinds": body.get("kinds"),
            "category": CATEGORY,
            "categoryLabel": CATEGORY_LABEL,
        },
    )
    async with _jobs_lock:
        _jobs[job.id] = job
        if len(_jobs) > _MAX_JOBS:
            oldest = sorted(_jobs.values(), key=lambda j: j.started_at or 0)
            for j in oldest:
                if j.status in ("done", "failed") and len(_jobs) > _MAX_JOBS:
                    _jobs.pop(j.id, None)
    asyncio.create_task(_run_job(job))
    return job
