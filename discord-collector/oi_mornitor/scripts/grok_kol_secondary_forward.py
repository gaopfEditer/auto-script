#!/usr/bin/env python3
"""KOL 二次预警转发：轮询 discord_signal_cards → watchlist → 形态检测 → webhook / dry-run。

不触碰 OI webhook；OI 推送保持 ~/.grokbot/oi-webhook/DISABLED。
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

# Ensure discord-collector root on path when run as script
_SCRIPT = Path(__file__).resolve()
_OI = _SCRIPT.parents[1]
_DC = _OI.parent
if str(_DC) not in sys.path:
    sys.path.insert(0, str(_DC))

DEFAULT_ENV = Path.home() / ".grokbot" / "kol-secondary" / "config.env"


def load_env(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def load_discord_collector_env() -> None:
    env_path = _DC / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def main() -> int:
    env_path = Path(os.environ.get("KOL_GROK_ENV", str(DEFAULT_ENV)))
    load_discord_collector_env()
    load_env(env_path)
    # 若未设 HTTPS_PROXY，回落 COMMON_PROXY / BINANCE_PROXY（与本机 oi 进程一致）
    if not (os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")):
        for k in ("COMMON_PROXY", "BINANCE_PROXY"):
            v = (os.environ.get(k) or "").strip()
            if v:
                os.environ.setdefault("HTTPS_PROXY", v)
                os.environ.setdefault("HTTP_PROXY", v)
                break

    if os.environ.get("KOL_SECONDARY_ALERT_ENABLED", "1").strip() in ("0", "false", "no"):
        print("[kol-secondary] KOL_SECONDARY_ALERT_ENABLED=0, exit", flush=True)
        return 0

    from oi_mornitor.kol_secondary_alert import (
        alert_key,
        append_alert_log,
        data_dir,
        ingest_new_cards,
        load_seen,
        post_webhook,
        save_seen,
        scan_watchlist_alerts,
        seed_followed_kols,
    )

    url = os.environ.get("KOL_GROK_WEBHOOK_URL", "").strip()
    key = os.environ.get("KOL_GROK_WEBHOOK_KEY", "").strip()
    dry = not (url and key)
    if os.environ.get("KOL_DRY_RUN", "").strip() in ("1", "true", "yes"):
        dry = True
    poll = float(os.environ.get("KOL_POLL_SEC", "45") or "45")

    seed_followed_kols(force=False)
    state = load_seen()
    seen: dict = state.setdefault("seen", {})

    mode = "dry-run→alerts.jsonl" if dry else "webhook"
    print(
        f"[kol-secondary] start mode={mode} poll={poll}s data={data_dir()} env={env_path}",
        flush=True,
    )
    if dry:
        print(
            "[kol-secondary] webhook URL/key 未配置或 KOL_DRY_RUN=1；"
            "仍更新 watchlist，告警写入 data/kol_secondary/alerts.jsonl",
            flush=True,
        )

    while True:
        try:
            stats = ingest_new_cards()
            print(
                f"[kol-secondary] ingest cards={stats['cards_seen']} "
                f"upserts={stats['watch_upserts']} watch={stats['watch_size']} "
                f"cursor={stats['last_card_id']}",
                flush=True,
            )
            alerts = scan_watchlist_alerts()
            fresh = []
            for a in alerts:
                k = alert_key(a["symbol"], a["tf"], a["pattern"], a["bar_ts"])
                if k in seen:
                    continue
                seen[k] = time.time()
                a = dict(a)
                a["dedupe_key"] = k
                fresh.append(a)

            # prune 7d
            cutoff = time.time() - 7 * 86400
            for k, t in list(seen.items()):
                try:
                    if float(t) < cutoff:
                        del seen[k]
                except Exception:
                    del seen[k]

            for a in fresh:
                append_alert_log(a)
                if not dry:
                    try:
                        post_webhook(url, key, a)
                        print(
                            f"[kol-secondary] POST {a['symbol']} {a['pattern_zh']} "
                            f"vol={a['abnormal_volume']['which']} ema={a['ema144']['side']}",
                            flush=True,
                        )
                    except Exception as exc:
                        print(f"[kol-secondary] POST fail: {exc}", flush=True)
                        # still keep seen to avoid storm; log only
                else:
                    print(
                        f"[kol-secondary] DRY {a['symbol']} {a.get('pattern_zh')} "
                        f"vol={a['abnormal_volume'].get('which')} "
                        f"ema={a['ema144'].get('side')} "
                        f"kol={a.get('kol_name')} key={a.get('dedupe_key')}",
                        flush=True,
                    )

            save_seen(state)
            if not fresh:
                print("[kol-secondary] no new pattern alerts", flush=True)
        except Exception as e:
            print(f"[kol-secondary] error: {type(e).__name__}: {e}", flush=True)
        time.sleep(max(5.0, poll))


if __name__ == "__main__":
    raise SystemExit(main())
