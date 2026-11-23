#!/usr/bin/env python3
"""One-off: kolvip sig top10 direction/stop analysis from local API + Binance klines."""
import json
import statistics
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
BASE = "http://127.0.0.1:3851"


def get(url: str):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def binance_symbol(coin: str) -> str | None:
    if coin == "XAU":
        return None
    return f"{coin}USDT"


def fetch_klines(symbol: str, start_ms: int, end_ms: int, interval: str = "5m"):
    url = (
        "https://api.binance.com/api/v3/klines?"
        f"symbol={symbol}&interval={interval}&startTime={start_ms}&endTime={end_ms}&limit=1000"
    )
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            return json.load(r)
    except Exception:
        return None


def analyze_sl_trade(s: dict, lookforward_ms: int = 6 * 3600 * 1000) -> dict:
    coin = s.get("coin")
    sym = binance_symbol(coin or "")
    if not sym:
        return {"skip": True, "reason": f"{coin} 无币安 USDT 永续对照，未做 K 线复检"}
    et = s.get("entry_time") or s.get("call_time")
    xt = s.get("exit_time")
    if not et or not xt:
        return {"skip": True, "reason": "缺少 entry/exit 时间"}
    kl = fetch_klines(sym, et, xt + lookforward_ms)
    time.sleep(0.08)
    if not kl:
        return {"skip": True, "reason": f"K 线拉取失败 {sym}", "coin": coin}
    side = s.get("side")
    highs = [float(k[2]) for k in kl]
    lows = [float(k[3]) for k in kl]
    closes = [float(k[4]) for k in kl]
    ts = [int(k[0]) for k in kl]
    entry_px = float(kl[0][1])
    hold_idx = [i for i, t in enumerate(ts) if t <= xt]
    post_idx = [i for i, t in enumerate(ts) if t > xt]
    if not hold_idx:
        return {"skip": True, "reason": "无持仓区间 K 线"}
    h_hi = max(highs[i] for i in hold_idx)
    h_lo = min(lows[i] for i in hold_idx)
    hold_close = closes[hold_idx[-1]]
    if side == 1:
        mfe_hold = (h_hi - entry_px) / entry_px
        mae_hold = (entry_px - h_lo) / entry_px
        dir_post = (
            (closes[post_idx[-1]] - hold_close) / hold_close if post_idx else 0.0
        )
    else:
        mfe_hold = (entry_px - h_lo) / entry_px
        mae_hold = (h_hi - entry_px) / entry_px
        dir_post = (
            (hold_close - closes[post_idx[-1]]) / hold_close if post_idx else 0.0
        )
    tight = mfe_hold >= 0.003
    wrong = mfe_hold < 0.0015
    post_continues = dir_post >= 0.002
    if tight and post_continues:
        cls = "方向可能对、止损偏紧（持仓内曾顺势，扫损后 6h 仍沿信号方向）"
    elif tight and not post_continues:
        cls = "持仓内曾有顺势波动但被止损；离场后未明显延续"
    elif wrong and not post_continues:
        cls = "方向偏误（持仓内几乎无顺势，离场后也不顺）"
    elif wrong and post_continues:
        cls = "止损后价格才沿信号走（扫损/止损位或入场问题）"
    else:
        cls = "介于中间，缺 kolvip 点位详情（/webu/sig/detail 权限）"
    return {
        "skip": False,
        "symbol": sym,
        "coin": coin,
        "side": side,
        "mfe_hold_pct": round(mfe_hold * 100, 3),
        "mae_hold_pct": round(mae_hold * 100, 3),
        "post_dir_6h_pct": round(dir_post * 100, 3),
        "class": cls,
        "hold_bars": len(hold_idx),
        "post_bars": len(post_idx),
    }


def max_streak(hist, kind: str) -> int:
    best = cur = 0
    for s in sorted(hist, key=lambda x: x.get("call_time") or 0):
        if s.get("status") == kind:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best


def main():
    rank = get(f"{BASE}/api/kolvip/sig/rank?range=30")
    meta = get(f"{BASE}/api/kolvip/sig/meta")
    min_count = rank.get("min_count", 5)
    top = [x for x in rank["list"] if x.get("ranked")][:10]

    all_hist: list[dict] = []
    top10_rows = []
    for row in top:
        name = row["name"]
        q = urllib.parse.quote(name)
        b = get(f"{BASE}/api/kolvip/sig/blogger?name={q}&range=30")
        hist = b.get("history") or []
        for s in hist:
            s["_blogger"] = name
        all_hist.extend(hist)
        top10_rows.append(
            {
                "name": name,
                "win_rate_pct": row["win_rate"],
                "count": row["count"],
                "wins": row["wins"],
                "losses": row["losses"],
                "be": row.get("be", 0),
                "open": row.get("open", 0),
                "pl_ratio": row["pl"],
                "total_r": row["r"],
                "max_lose_streak": row.get("max_lose"),
                "last_call_ms": row.get("last_call"),
            }
        )

    settled = [s for s in all_hist if s.get("done") and s.get("status") in ("win", "loss")]
    sl_losses = [s for s in settled if s.get("status") == "loss" and s.get("how") == "sl"]

    analyses = []
    for s in sl_losses:
        a = analyze_sl_trade(s)
        a["id"] = s["id"]
        a["blogger"] = s["_blogger"]
        a["coin"] = s.get("coin")
        a["r"] = s.get("r")
        analyses.append(a)

    cls_counter = Counter(a.get("class", "skipped") for a in analyses if not a.get("skip"))

    durations = []
    for s in settled:
        et, xt = s.get("entry_time"), s.get("exit_time")
        if et and xt and xt >= et:
            durations.append((xt - et) / 3_600_000)

    per_blogger = {}
    for row in top:
        name = row["name"]
        hist = [s for s in all_hist if s["_blogger"] == name]
        st = [s for s in hist if s.get("status") in ("win", "loss")]
        holds = [
            (s["exit_time"] - s["entry_time"]) / 3_600_000
            for s in st
            if s.get("entry_time") and s.get("exit_time")
        ]
        per_blogger[name] = {
            "coins_top": Counter(s.get("coin") for s in st).most_common(6),
            "long_pct": round(sum(1 for s in st if s.get("side", 0) > 0) / len(st) * 100, 1)
            if st
            else 0,
            "exit_how": Counter(s.get("how") for s in st).most_common(),
            "avg_hold_h": round(statistics.mean(holds), 2) if holds else None,
            "median_hold_h": round(statistics.median(holds), 2) if holds else None,
            "max_win_streak": max_streak(hist, "win"),
            "max_loss_streak": max_streak(hist, "loss"),
            "noentry_cancel": sum(
                1 for s in hist if s.get("status") in ("noentry", "cancel")
            ),
            "sl_losses": sum(
                1 for s in st if s.get("status") == "loss" and s.get("how") == "sl"
            ),
            "loss_how": Counter(
                s.get("how") for s in st if s.get("status") == "loss"
            ).most_common(),
        }

    out = {
        "generated_at": datetime.now(TZ).isoformat(),
        "data_sync_at": meta.get("lastSyncAt"),
        "min_count": min_count,
        "detail_snapshots_local": meta.get("detailSnapshots"),
        "detail_api_note": "kolvip /webu/sig/detail 需鲸享权限，本地 detail 目录为空；止损方向用 Binance 5m K 线近似复检",
        "top10": top10_rows,
        "settled_in_top10_histories": len(settled),
        "sl_loss_count": len(sl_losses),
        "sl_kline_class_summary": dict(cls_counter),
        "sl_loss_analyses": analyses,
        "aggregate": {
            "coins": Counter(s.get("coin") for s in settled).most_common(12),
            "side": Counter(
                "多" if s.get("side", 0) > 0 else "空" for s in settled
            ),
            "how_settled": Counter(s.get("how") for s in settled).most_common(),
            "status_including_noentry": Counter(s.get("status") for s in all_hist),
            "hold_h_median": round(statistics.median(durations), 2) if durations else None,
            "hold_h_mean": round(statistics.mean(durations), 2) if durations else None,
            "r_list_sum_from_histories": round(
                sum(s.get("r") or 0 for s in settled), 2
            ),
        },
        "per_blogger": per_blogger,
    }

    json_path = "/Users/maotouying/frontend/code/1.operations/auto-script/discord-collector/logs/kolvip-top10-analysis-2026-11-20.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    md_path = "/Users/maotouying/frontend/code/1.operations/auto-script/discord-collector/logs/kolvip-top10-report-2026-11-20.md"
    lines = [
        "# 博主胜率近 30 天 TOP10 复核",
        "",
        f"- 数据：`127.0.0.1:3851` 本地 API，同步时间 {meta.get('lastSyncAt')}",
        f"- 上榜门槛：**≥ {min_count} 笔有结果**（与面板一致）",
        f"- 口径：kolvip AI 喊单 + K 线结算（非自建卡 KolvipEvalPanel）",
        f"- 本地 `detailSnapshots={meta.get('detailSnapshots')}`；巨鲸 detail 接口本机 token **无鲸享权限**，无法用官方 MAE/MFE/点位；止损方向用 **Binance 5m** 对 crypto 单复检，**XAU 单未做 K 线对照**。",
        "",
        "## 前 10 一览（按榜单胜率序，均为 ranked）",
        "",
        "| # | 博主 | 胜率% | 笔数 | 赢/亏 | 盈亏比 | 累计R | 进行中 | 最大连亏 |",
        "|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for i, r in enumerate(top10_rows, 1):
        lines.append(
            f"| {i} | {r['name']} | {r['win_rate_pct']} | {r['count']} | "
            f"{r['wins']}/{r['losses']} | {r['pl_ratio']} | {r['total_r']} | "
            f"{r['open']} | {r['max_lose_streak']} |"
        )
    lines += [
        "",
        "## 方向 / 止损判断（可核对规则）",
        "",
        "**规则（crypto、how=sl 的亏损单）：**",
        "1. 用 `entry_time`→`exit_time` 区间 Binance 5m K 线，估算入场价=首根开盘价；",
        "2. **MFE_hold**：持仓内沿喊单方向最大有利波动；**MAE_hold**：不利波动；",
        "3. **post_dir_6h**：止损价（末根持仓 close 近似）后 6 小时内沿信号方向的涨跌；",
        "4. 分类阈值：MFE_hold≥0.3% 视为持仓内曾顺势；post_dir≥0.2% 视为扫损后仍沿信号方向。",
        "",
        f"- 已结算样本（10 人 history 合计）：**{len(settled)}** 笔；亏损 **{sum(1 for s in settled if s['status']=='loss')}**；其中 **sl 止损 {len(sl_losses)}** 笔。",
        f"- K 线复检：{sum(1 for a in analyses if not a.get('skip'))} 笔；跳过 {sum(1 for a in analyses if a.get('skip'))} 笔（主要为 XAU）。",
        "",
        "**sl 亏损分类汇总：**",
        "",
    ]
    for k, v in cls_counter.most_common():
        lines.append(f"- {k}：**{v}** 笔")
    lines += ["", "**代表结论：**", ""]
    # bloggers with most sl losses
    bl_sl = Counter(a["blogger"] for a in analyses if not a.get("skip"))
    for name, cnt in bl_sl.most_common(5):
        sub = [a for a in analyses if a.get("blogger") == name and not a.get("skip")]
        tight = sum(1 for a in sub if "偏紧" in a.get("class", ""))
        wrong = sum(1 for a in sub if "偏误" in a.get("class", ""))
        lines.append(
            f"- **{name}**：sl 亏损 K 线可检 {len(sub)} 笔；偏紧/扫损后延续 {tight}；方向偏误 {wrong}。"
        )
    lines += [
        "",
        "其余 how：`closed`/`timeout` 亏损不计入「止损过小」主结论；`win` 多由 tp1~tp6 或 `blogger` 手工了结。",
        "",
        "## 特征值归纳",
        "",
        f"- **品种**：{out['aggregate']['coins'][:8]}",
        f"- **多空（已结算）**：多 {out['aggregate']['side'].get('多',0)} / 空 {out['aggregate']['side'].get('空',0)}",
        f"- **持仓时长（已结算）**：中位 {out['aggregate']['hold_h_median']}h，均值 {out['aggregate']['hold_h_mean']}h",
        f"- **了结方式**：{out['aggregate']['how_settled']}",
        f"- **未成交/取消**（拉低可跟单感）：{dict(out['aggregate']['status_including_noentry'])}",
        "",
        "### 共性",
        "- TOP10 以 **XAU/BTC/ETH** 为主，黄金信号类（华尔街女王、FX-黄金、熬鹰、黄金帝国、MrGoldenWay）占榜过半，crypto 博主盈亏比与累计 R 分化大。",
        "- 高胜率伴随 **低盈亏比** 的不少（如三马哥 pl=0.51、大镖客 pl=0.5），靠胜率堆 R；零下二度、Trader-Nero 盈亏比相对高。",
        "- 榜单 `open` 进行中单：三马哥/MrGoldenWay/大镖客各有 1–2 单，**未并入胜率分母但影响观感**；kacang 样本最大（44 笔）胜率仅 61%。",
        "",
        "### 差异",
        "- **累计 R 极端**：熬鹰 R≈100.84、FX-黄金 R≈41.62 与 **大镖客 R≈-0.94** 同榜——高胜率≠正期望。",
        "- **连亏**：kacang、大镖客 max_lose=4；华尔街女王仅 1 连亏。",
        "",
        "## 限制",
        "- 不能把 TOP10 胜率当可交易期望；含 AI 解析与 K 线结算假设。",
        "- 无 detail 时 history 的 entry/sl/tp 价格为 0，无法用官方止损距离；Binance 复检不含滑点、不含 XAU 现货/CFD 价差。",
        "",
    ]
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(json_path)
    print(md_path)
    print("sl classes", dict(cls_counter))


if __name__ == "__main__":
    main()