#!/usr/bin/env python3
"""Watch oi_mornitor /api/hot and POST new OI alerts to a Grok Bot webhook routine."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_ENV = Path.home() / ".grokbot" / "oi-webhook" / "config.env"
STATE_PATH = Path.home() / ".grokbot" / "oi-webhook" / "forward_state.json"


def load_env(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def load_state() -> dict:
    if STATE_PATH.is_file():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"seen": {}}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_PATH)


def alert_key(item: dict) -> str:
    sym = str(item.get("symbol") or "")
    windows = item.get("triggered_windows") or []
    if isinstance(windows, list):
        w = ",".join(str(x) for x in windows)
    else:
        w = str(windows)
    ts = item.get("alert_ts") or item.get("scan_ts") or ""
    return f"{sym}|{w}|{ts}"


def slim(item: dict) -> dict:
    keys = (
        "symbol",
        "last_price",
        "current_oi_usd",
        "oi_tier",
        "pct_5m",
        "pct_15m",
        "delta_5m_usd",
        "delta_15m_usd",
        "pct_price_5m",
        "pct_price_15m",
        "triggered_windows",
        "is_hot",
        "is_alert",
        "is_historic_anomaly",
        "alert_reason",
        "alert_ts",
        "individual_strength_score",
        "global_intensity_rank",
        "type",
        "status",
    )
    return {k: item.get(k) for k in keys if k in item}


def fetch_hot(api: str) -> dict:
    with urllib.request.urlopen(api, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def post_webhook(url: str, key: str, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        r.read()


def main() -> int:
    env_path = Path(os.environ.get("OI_GROK_ENV", str(DEFAULT_ENV)))
    load_env(env_path)
    url = os.environ.get("OI_GROK_WEBHOOK_URL", "").strip()
    key = os.environ.get("OI_GROK_WEBHOOK_KEY", "").strip()
    api = os.environ.get("OI_HOT_API", "http://127.0.0.1:8765/api/hot").strip()
    poll = float(os.environ.get("OI_POLL_SEC", "3") or "3")
    if not url or not key:
        print("missing OI_GROK_WEBHOOK_URL / OI_GROK_WEBHOOK_KEY", file=sys.stderr)
        return 2

    state = load_state()
    seen: dict = state.setdefault("seen", {})
    print(f"[grok-oi-forward] watching {api} every {poll}s → webhook", flush=True)

    while True:
        try:
            data = fetch_hot(api)
            hot = data.get("hot_tickers") or []
            scan_ts = data.get("scan_ts")
            fresh = []
            for item in hot:
                if not isinstance(item, dict):
                    continue
                # Prefer real alerts; still forward is_hot if marked alert-like
                if not (item.get("is_alert") or item.get("is_hot")):
                    continue
                k = alert_key(item)
                if k in seen:
                    continue
                seen[k] = time.time()
                fresh.append(slim(item))

            # prune old seen keys (keep 24h)
            cutoff = time.time() - 86400
            for k, t in list(seen.items()):
                try:
                    if float(t) < cutoff:
                        del seen[k]
                except Exception:
                    del seen[k]

            if fresh:
                payload = {
                    "source": "oi_mornitor",
                    "type": "oi_hot_alert",
                    "scan_ts": scan_ts,
                    "count": len(fresh),
                    "hot_tickers": fresh[:20],
                }
                post_webhook(url, key, payload)
                save_state(state)
                print(
                    f"[grok-oi-forward] posted {len(fresh)}: "
                    + ", ".join(str(x.get("symbol")) for x in fresh[:8]),
                    flush=True,
                )
            else:
                save_state(state)
        except urllib.error.URLError as e:
            print(f"[grok-oi-forward] fetch/post error: {e}", flush=True)
        except Exception as e:
            print(f"[grok-oi-forward] error: {type(e).__name__}: {e}", flush=True)
        time.sleep(max(1.0, poll))


if __name__ == "__main__":
    raise SystemExit(main())
