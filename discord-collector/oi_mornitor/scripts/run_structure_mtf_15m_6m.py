#!/usr/bin/env python3
"""原版结构形态 + 15m 入场 + 多周期共振的半年回测（不含下午短线 V1/V2）。

先增量补齐本地 K 线缺口，再跑 structure_backtest，最后按两种共振口径出统计：
- 可交易：更高周期 peer 在 15m 信号当时或之前已出现（且在 4 小时窗内）
- 展示：官方 ±4 小时窗（含事后出现的 1h/4h，仅作对照，不可当作实盘）
"""
from __future__ import annotations

import asyncio
import csv
import json
import os
import sys
import time
import traceback
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]  # discord-collector
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TZ = ZoneInfo("Asia/Shanghai")
START = datetime(2026, 5, 13, 0, 0, tzinfo=TZ)
END = datetime(2026, 11, 12, 22, 0, tzinfo=TZ)
START_MS = int(START.timestamp() * 1000)
END_MS = int(END.timestamp() * 1000)

KINDS = [
    "bottom_secondary_test",
    "shooting_star",
    "consecutive_flat_shooting_star",
    "hs_vegas_break",
    "m_top_vegas_break",
    "liquidity_sweep",
]
SCAN_INTERVALS = ["15m", "1h", "4h"]
PREFETCH_INTERVALS = ["5m", "15m", "1h", "4h"]
OUT = ROOT / "oi_mornitor" / "data" / "structure_mtf_15m_6m"
FETCH_CONCURRENCY = 2


def _ts() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str) -> None:
    line = f"[{_ts()} HKT] {msg}"
    print(line, flush=True)


def write_progress(payload: dict[str, Any]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "progress.json"
    payload = {"updatedAt": _ts(), **payload}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def setup_proxy() -> str | None:
    from oi_mornitor.config import proxy_url

    px = proxy_url()
    if px:
        os.environ["HTTPS_PROXY"] = px
        os.environ["HTTP_PROXY"] = px
        os.environ["https_proxy"] = px
        os.environ["http_proxy"] = px
    return px


def last_open_ms(store: Any, symbol: str, interval: str) -> int | None:
    import pyarrow.parquet as pq

    path = store._parquet_path(symbol, interval)
    if not path.is_file():
        return None
    table = pq.read_table(path, columns=["open_time"])
    col = table.column("open_time")
    if col.length() == 0:
        return None
    # take max without full pylist if possible
    try:
        return int(col.combine_chunks().to_pylist()[-1] if False else max(col.to_pylist()))
    except Exception:
        vals = col.to_pylist()
        return int(max(vals)) if vals else None


async def probe_bybit(session: Any) -> None:
    url = "https://api.bybit.com/v5/market/time"
    async with session.get(url, timeout=20) as resp:
        text = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"Bybit time HTTP {resp.status}: {text[:200]}")
        log(f"Bybit 探针成功 HTTP {resp.status}")


async def prefetch_gap(store: Any, symbols: list[str]) -> dict[str, Any]:
    from oi_mornitor.backtest_common import kline_window_ms
    from oi_mornitor.backtest_kline_store import _interval_ms
    from oi_mornitor.http_session import make_http_session
    from oi_mornitor.config import proxy_url

    px = proxy_url()
    session = make_http_session(trust_env=False, default_proxy=px)
    sem = asyncio.Semaphore(FETCH_CONCURRENCY)
    stats = {
        "pairsTotal": len(symbols) * len(PREFETCH_INTERVALS),
        "pairsDone": 0,
        "fetchedPairs": 0,
        "skippedPairs": 0,
        "failed": [],
    }
    try:
        await probe_bybit(session)

        async def one(sym: str, iv: str) -> None:
            nonlocal stats
            need_from, need_to = kline_window_ms(iv, START_MS, END_MS)
            if iv == "5m":
                need_to = END_MS + 6 * 3600 * 1000
            last = last_open_ms(store, sym, iv)
            if last is not None and last >= need_to - _interval_ms(iv):
                stats["skippedPairs"] += 1
                stats["pairsDone"] += 1
                return
            gap_start = (last + _interval_ms(iv)) if last is not None else need_from
            if gap_start >= need_to:
                stats["skippedPairs"] += 1
                stats["pairsDone"] += 1
                return
            async with sem:
                try:
                    n = await store.ensure_range(
                        session,
                        sym,
                        iv,
                        int(gap_start),
                        int(need_to),
                        as_of_ms=END_MS,
                        source="bybit",
                    )
                    stats["fetchedPairs"] += 1
                    log(f"补齐 {sym} {iv} gap={gap_start}..{need_to} bars_in_window={n}")
                except Exception as exc:  # noqa: BLE001
                    stats["failed"].append({"symbol": sym, "interval": iv, "error": str(exc)})
                    log(f"补齐失败 {sym} {iv}: {exc}")
                finally:
                    stats["pairsDone"] += 1
                    if stats["pairsDone"] % 10 == 0 or stats["pairsDone"] == stats["pairsTotal"]:
                        write_progress({"phase": "prefetch", **stats})
                        log(
                            f"补K进度 {stats['pairsDone']}/{stats['pairsTotal']} "
                            f"拉取 {stats['fetchedPairs']} 跳过 {stats['skippedPairs']} "
                            f"失败 {len(stats['failed'])}"
                        )

        tasks = [one(sym, iv) for sym in symbols for iv in PREFETCH_INTERVALS]
        await asyncio.gather(*tasks)
    finally:
        await session.close()
    return stats


def _norm_side(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    if s in ("long", "bull", "多"):
        return "long"
    if s in ("short", "bear", "空"):
        return "short"
    return ""


def compute_mtf(
    records: list[dict[str, Any]],
    *,
    causal: bool,
    window_ms: int,
) -> dict[str, dict[str, Any]]:
    from oi_mornitor.pattern_mtf_resonance import (
        MTF_RESONANCE_INTERVALS,
        _FAMILY_LABELS,
        _INTERVAL_ORDER,
        mtf_resonance_family,
    )

    eligible: list[dict[str, Any]] = []
    for r in records:
        key = str(r.get("_mtfKey") or r.get("key") or "").strip()
        if not key:
            continue
        iv = str(r.get("interval") or "").strip()
        if iv not in MTF_RESONANCE_INTERVALS:
            continue
        side = _norm_side(r.get("side"))
        if side not in ("long", "short"):
            continue
        fam = mtf_resonance_family(str(r.get("typeLabel") or ""), side)
        if not fam:
            continue
        sat = int(r.get("signalAt") or 0)
        if sat <= 0:
            continue
        eligible.append({**r, "_fam": fam, "_side": side, "_sym": str(r.get("symbol") or "").upper(), "_sat": sat, "_key": key})

    buckets: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for row in eligible:
        buckets.setdefault((row["_sym"], row["_fam"], row["_side"]), []).append(row)

    out: dict[str, dict[str, Any]] = {}
    for bucket in buckets.values():
        bucket.sort(key=lambda x: x["_sat"])
        n = len(bucket)
        for i in range(n):
            center = bucket[i]
            lo = center["_sat"] - window_ms
            hi = center["_sat"] if causal else center["_sat"] + window_ms
            intervals: set[str] = set()
            peer_ivs: list[str] = []
            for j in range(n):
                peer = bucket[j]
                if peer["_sat"] < lo or peer["_sat"] > hi:
                    continue
                iv = str(peer.get("interval") or "").strip()
                if iv in MTF_RESONANCE_INTERVALS:
                    intervals.add(iv)
                    if peer["_key"] != center["_key"]:
                        peer_ivs.append(iv)
            if len(intervals) < 2:
                continue
            iv_sorted = sorted(intervals, key=lambda x: _INTERVAL_ORDER.get(x, 99))
            fam = str(center["_fam"])
            out[str(center["_key"])] = {
                "tiers": len(iv_sorted),
                "intervals": iv_sorted,
                "family": fam,
                "familyLabel": _FAMILY_LABELS.get(fam, fam),
                "causal": causal,
            }
    return out


def _net(it: dict[str, Any]) -> float | None:
    for k in ("netMovePct", "movePct"):
        v = it.get(k)
        if v is None:
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    return None


def _outcome(it: dict[str, Any]) -> str:
    return str(it.get("outcome") or "").strip().lower()


def summarize_bucket(items: list[dict[str, Any]], *, label: str) -> dict[str, Any]:
    from oi_mornitor.trade_leverage import leverage_for_symbol

    wins = losses = flats = errors = 0
    nets: list[float] = []
    levered: list[float] = []
    by_kind: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_month: dict[str, list[dict[str, Any]]] = defaultdict(list)
    symbols: set[str] = set()
    for it in items:
        oc = _outcome(it)
        if oc in ("error", "failed") or it.get("error"):
            errors += 1
            continue
        if oc in ("flat", "even"):
            flats += 1
            continue
        net = _net(it)
        if net is None:
            errors += 1
            continue
        if oc == "win" or (oc not in ("loss",) and net > 0):
            wins += 1
        elif oc == "loss" or net < 0:
            losses += 1
        else:
            flats += 1
            continue
        nets.append(net)
        sym = str(it.get("symbol") or "").upper()
        symbols.add(sym)
        lev = float(leverage_for_symbol(sym))
        levered.append(net * lev)
        by_kind[str(it.get("typeLabel") or it.get("kind") or "?")].append(it)
        sat = int(it.get("signalAt") or 0)
        month = datetime.fromtimestamp(sat / 1000, TZ).strftime("%Y-%m") if sat else "unknown"
        by_month[month].append(it)

    decided = wins + losses
    wr = (wins / decided) if decided else None
    gp = sum(x for x in nets if x > 0)
    gl = sum(x for x in nets if x < 0)
    pf = (gp / abs(gl)) if gl < 0 else (None if gp == 0 else float("inf"))
    exp = (sum(nets) / len(nets)) if nets else None

    def sub(rows: list[dict[str, Any]]) -> dict[str, Any]:
        s = summarize_bucket(rows, label="_sub")
        return {
            "n": s["n"],
            "wins": s["wins"],
            "losses": s["losses"],
            "flats": s["flats"],
            "errors": s["errors"],
            "winRate": s["winRate"],
            "netSumPct": s["netSumPct"],
            "expectancyPct": s["expectancyPct"],
            "profitFactor": s["profitFactor"],
            "leveredSumPct": s["leveredSumPct"],
        }

    # avoid recursion explosion: when label=_sub, skip by_kind/by_month
    kind_rows = []
    month_rows = []
    if label != "_sub":
        kind_rows = [{"typeLabel": k, **sub(v)} for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1].__len__() if False else -len(kv[1]))]
        month_rows = [{"month": k, **sub(v)} for k, v in sorted(by_month.items())]

    return {
        "label": label,
        "n": wins + losses + flats + errors,
        "decided": decided,
        "wins": wins,
        "losses": losses,
        "flats": flats,
        "errors": errors,
        "winRate": wr,
        "netSumPct": sum(nets) if nets else 0.0,
        "expectancyPct": exp,
        "profitFactor": pf,
        "grossProfitPct": gp,
        "grossLossPct": gl,
        "leveredSumPct": sum(levered) if levered else 0.0,
        "symbols": len(symbols),
        "byKind": kind_rows,
        "byMonth": month_rows,
    }


def prepare_keys(items: list[dict[str, Any]]) -> None:
    for i, it in enumerate(items):
        it["_mtfKey"] = (
            str(it.get("key") or "").strip()
            or f"{it.get('symbol')}|{it.get('interval')}|{it.get('kind')}|{it.get('signalAt')}|{i}"
        )


def analyze(items: list[dict[str, Any]], job_id: str) -> dict[str, Any]:
    from oi_mornitor.pattern_mtf_resonance import MTF_RESONANCE_WINDOW_MS

    prepare_keys(items)
    display_map = compute_mtf(items, causal=False, window_ms=MTF_RESONANCE_WINDOW_MS)
    causal_map = compute_mtf(items, causal=True, window_ms=MTF_RESONANCE_WINDOW_MS)

    all_15 = [it for it in items if str(it.get("interval") or "") == "15m"]
    display_15 = [it for it in all_15 if it["_mtfKey"] in display_map]
    causal_15 = [it for it in all_15 if it["_mtfKey"] in causal_map]
    future_only_15 = [it for it in display_15 if it["_mtfKey"] not in causal_map]

    report = {
        "jobId": job_id,
        "window": {
            "start": START.isoformat(),
            "end": END.isoformat(),
            "timezone": "Asia/Shanghai",
        },
        "kinds": KINDS,
        "feeModel": "OI_BT_FEE_PCT 0.06%/边 + OI_BT_SLIPPAGE_PCT 0.03%/边，已计入 netMovePct",
        "notes": [
            "主结果是 15m 入场 + 因果多周期共振（更高周期在进场时或之前已出现）。",
            "官方 ±4 小时共振含事后 1h/4h，只作展示对照，不能当作可交易成绩。",
            "连续走平射击之星按原版共振规则不参与形态族，因此不会进入共振子集。",
            "倒锤子、量价确认、量价推进、高潮反转、努力无果不在本结构回测引擎里，本次未覆盖。",
            "二次探底在本研研回测中显式纳入（实盘默认仍暂停，不改实盘开关）。",
            "标的来自 2026-08-15 本地 Top200 快照，存在一定存活偏差。",
            "杠杆合计仅作与形态信号列表对照，不是复利权益。",
        ],
        "all15m": summarize_bucket(all_15, label="15m 全部（无共振过滤）"),
        "causal15m": summarize_bucket(causal_15, label="15m 因果共振（可交易主结果）"),
        "display15m": summarize_bucket(display_15, label="15m 官方±4h 共振（展示对照）"),
        "futureOnly15m": summarize_bucket(future_only_15, label="15m 仅事后共振（不可交易）"),
        "counts": {
            "allItems": len(items),
            "all15m": len(all_15),
            "causal15m": len(causal_15),
            "display15m": len(display_15),
            "futureOnly15m": len(future_only_15),
        },
    }

    csv_path = OUT / "trades_15m.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "symbol",
                "kind",
                "typeLabel",
                "side",
                "signalAtIso",
                "entry",
                "outcome",
                "netMovePct",
                "movePct",
                "exitReason",
                "displayMtf",
                "causalMtf",
                "mtfIntervals",
            ],
        )
        w.writeheader()
        for it in all_15:
            sat = int(it.get("signalAt") or 0)
            key = it["_mtfKey"]
            disp = key in display_map
            cau = key in causal_map
            src = causal_map.get(key) or display_map.get(key) or {}
            w.writerow(
                {
                    "symbol": it.get("symbol"),
                    "kind": it.get("kind"),
                    "typeLabel": it.get("typeLabel"),
                    "side": _norm_side(it.get("side")),
                    "signalAtIso": datetime.fromtimestamp(sat / 1000, TZ).isoformat() if sat else "",
                    "entry": it.get("entry"),
                    "outcome": it.get("outcome"),
                    "netMovePct": it.get("netMovePct"),
                    "movePct": it.get("movePct"),
                    "exitReason": it.get("exitReason"),
                    "displayMtf": disp,
                    "causalMtf": cau,
                    "mtfIntervals": " ".join(src.get("intervals") or []),
                }
            )
    report["tradesCsv"] = str(csv_path)
    return report


def _fmt_pct(x: Any) -> str:
    if x is None:
        return "—"
    if x == float("inf"):
        return "∞"
    return f"{float(x):.2f}"


def _fmt_wr(x: Any) -> str:
    if x is None:
        return "—"
    return f"{float(x)*100:.1f}%"


def render_md(report: dict[str, Any]) -> str:
    lines = [
        "# 原版形态 15m 多周期共振半年回测",
        "",
        f"- 窗口：{report['window']['start']} → {report['window']['end']}（Asia/Shanghai）",
        f"- 形态：{', '.join(report['kinds'])}",
        f"- 费用：{report['feeModel']}",
        "",
        "说明：",
    ]
    for n in report["notes"]:
        lines.append(f"- {n}")
    lines += ["", "| 口径 | 笔数 | 胜 | 负 | 平 | 失败 | 胜率 | 净价变动合计% | 期望%/笔 | 利润因子 | 杠杆合计%（展示） |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for key in ("causal15m", "display15m", "futureOnly15m", "all15m"):
        s = report[key]
        lines.append(
            f"| {s['label']} | {s['decided']} | {s['wins']} | {s['losses']} | {s['flats']} | {s['errors']} | "
            f"{_fmt_wr(s['winRate'])} | {_fmt_pct(s['netSumPct'])} | {_fmt_pct(s['expectancyPct'])} | "
            f"{_fmt_pct(s['profitFactor'])} | {_fmt_pct(s['leveredSumPct'])} |"
        )
    causal = report["causal15m"]
    if causal.get("byKind"):
        lines += ["", "## 可交易共振：按形态", "", "| 形态 | 笔数 | 胜率 | 净价变动合计% | 期望%/笔 | 利润因子 |", "| --- | ---: | ---: | ---: | ---: | ---: |"]
        for row in causal["byKind"]:
            lines.append(
                f"| {row['typeLabel']} | {row['decided']} | {_fmt_wr(row['winRate'])} | "
                f"{_fmt_pct(row['netSumPct'])} | {_fmt_pct(row['expectancyPct'])} | {_fmt_pct(row['profitFactor'])} |"
            )
    if causal.get("byMonth"):
        lines += ["", "## 可交易共振：按月", "", "| 月份 | 笔数 | 胜率 | 净价变动合计% | 期望%/笔 | 利润因子 |", "| --- | ---: | ---: | ---: | ---: | ---: |"]
        for row in causal["byMonth"]:
            lines.append(
                f"| {row['month']} | {row['decided']} | {_fmt_wr(row['winRate'])} | "
                f"{_fmt_pct(row['netSumPct'])} | {_fmt_pct(row['expectancyPct'])} | {_fmt_pct(row['profitFactor'])} |"
            )
    lines.append("")
    return "\n".join(lines)


async def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    px = setup_proxy()
    log(f"开始原版 15m 共振半年回测  window={START.isoformat()} → {END.isoformat()}  proxy={px}")
    write_progress({"phase": "init", "proxy": px})

    from oi_mornitor.backtest_common import resolve_local_backtest_symbols
    from oi_mornitor.backtest_kline_store import BacktestKlineStore
    from oi_mornitor.structure_backtest import BacktestJob, _run_job
    import uuid

    symbols, meta = resolve_local_backtest_symbols(
        scope="all", max_symbols=250, get_pool_rows=lambda: []
    )
    log(f"标的 {len(symbols)}  meta={meta}")
    (OUT / "universe.json").write_text(
        json.dumps({"symbols": symbols, "meta": meta}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    store = BacktestKlineStore()
    write_progress({"phase": "prefetch", "symbols": len(symbols)})
    prefetch_stats = await prefetch_gap(store, symbols)
    (OUT / "prefetch.json").write_text(
        json.dumps(prefetch_stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(f"补K完成 {prefetch_stats}")

    job_id = uuid.uuid4().hex[:12]
    job = BacktestJob(
        id=job_id,
        params={
            "startMs": START_MS,
            "endMs": END_MS,
            "intervals": SCAN_INTERVALS,
            "kinds": KINDS,
            "symbolScope": "all",
            "maxSymbols": 250,
            "skipFetch": True,
            "liveFunnel": False,
            "confluenceMinTier": "all",
            "mtfResonanceOnly": False,
            "researchNote": "orig-structure-15m-mtf-6m causal vs display",
        },
    )
    write_progress({"phase": "scan", "jobId": job_id, "prefetch": prefetch_stats})
    log(f"开始扫描 job={job_id}")
    t0 = time.time()
    await _run_job(job, lambda: [])
    elapsed = time.time() - t0
    log(f"扫描结束 status={job.status} error={job.error} items={len(job.items)} elapsed={elapsed:.1f}s")

    if job.status != "done":
        write_progress({"phase": "failed", "jobId": job_id, "error": job.error, "elapsed": elapsed})
        (OUT / "job_error.json").write_text(
            json.dumps({"id": job_id, "status": job.status, "error": job.error}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return 1

    report = analyze(job.items, job_id)
    report["elapsedSec"] = elapsed
    report["jobStatus"] = job.status
    report["prefetch"] = prefetch_stats
    (OUT / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md = render_md(report)
    (OUT / "summary.md").write_text(md, encoding="utf-8")
    write_progress({"phase": "done", "jobId": job_id, "elapsed": elapsed, "counts": report["counts"]})
    log("报告已写入 " + str(OUT / "summary.md"))
    print(md, flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception:
        traceback.print_exc()
        write_progress({"phase": "crash", "error": traceback.format_exc()})
        raise SystemExit(2)
