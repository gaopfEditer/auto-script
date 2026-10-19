"""KOL 二次预警信号 TTL / 入场 / SL·TP 生命周期。"""
from __future__ import annotations

import os

import pytest

from oi_mornitor.kol_signal_lifecycle import (
    advance_lifecycle_record,
    enrich_alert_lifecycle,
    expires_at_ms,
    find_bar_index_by_open_time,
    is_terminal_status,
    new_lifecycle_record,
    signal_ttl_hours,
)


def _bar(open_time: int, o: float, h: float, l: float, c: float) -> dict:
    return {
        "open_time": float(open_time),
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": 1000.0,
        "close_time": float(open_time + 899_999),
    }


def test_signal_ttl_hours_floor(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("KOL_SIGNAL_TTL_HOURS", "2")
    assert signal_ttl_hours() == 4.0
    monkeypatch.setenv("KOL_SIGNAL_TTL_HOURS", "6")
    assert signal_ttl_hours() == 6.0


def test_enrich_alert_has_expires_at():
    alert = {
        "symbol": "BTCUSDT",
        "tf": "15m",
        "pattern": "inverted_hammer",
        "bar_ts": 1_700_000_000_000,
        "side": "long",
        "dedupe_key": "k1",
    }
    out = enrich_alert_lifecycle(alert, fired_at_ms=1_700_000_000_000)
    assert out["ttl_hours"] >= 4
    assert out.get("expires_at")
    assert out["lifecycle"]["entry_mode"] == "next_bar_open"


def test_expired_no_entry_within_ttl():
    fired = 1_000_000_000_000
    exp = expires_at_ms(fired, ttl_hours=4)
    rec = {
        "dedupe_key": "k",
        "symbol": "BTCUSDT",
        "tf": "15m",
        "pattern": "inverted_hammer",
        "bar_ts": fired,
        "side": "long",
        "status": "active_waiting_entry",
        "alert_fired_at_ms": fired,
        "expires_at_ms": exp,
        "ttl_hours": 4,
    }
    updated, ev = advance_lifecycle_record(rec, [], now_ms=exp + 1)
    assert updated["status"] == "ignored_expired"
    assert ev and ev["lifecycle_status"] == "ignored_expired"


def test_enter_then_sl_ignored():
    t0 = 1_700_000_000_000
    t1 = t0 + 900_000
    t2 = t1 + 900_000
    bars = [
        _bar(t0, 100, 101, 99, 100.5),
        _bar(t1, 100, 101, 99.5, 100.2),
        _bar(t2, 100, 100.5, 50, 95),
    ]
    assert find_bar_index_by_open_time(bars, t0) == 0
    fired = t0 + 60_000
    exp = expires_at_ms(fired, ttl_hours=4)
    rec = new_lifecycle_record(
        {
            "symbol": "BTCUSDT",
            "tf": "15m",
            "pattern": "inverted_hammer",
            "bar_ts": t0,
            "side": "long",
            "dedupe_key": "BTCUSDT|15m|inverted_hammer|" + str(t0),
        },
        fired_at_ms=fired,
    )
    rec["expires_at_ms"] = exp
    rec, _ = advance_lifecycle_record(rec, bars, now_ms=t1 + 1)
    assert rec["status"] == "active_entered"
    assert rec.get("entry_price")
    assert rec.get("sl_price")
    sl = float(rec["sl_price"])
    rec, ev = advance_lifecycle_record(rec, bars, now_ms=t2 + 900_000)
    assert rec["status"] == "ignored_sl"
    assert ev and ev["lifecycle_status"] == "ignored_sl"
    assert sl < float(rec["entry_price"])


def test_enter_then_tp_ignored():
    t0 = 1_700_100_000_000
    t1 = t0 + 900_000
    t2 = t1 + 900_000
    bars = [
        _bar(t0, 200, 201, 199, 200.5),
        _bar(t1, 200, 201, 199.5, 200.2),
        _bar(t2, 200, 201, 150, 155),
    ]
    fired = t0 + 60_000
    rec = new_lifecycle_record(
        {
            "symbol": "ETHUSDT",
            "tf": "15m",
            "pattern": "shooting_star",
            "bar_ts": t0,
            "side": "short",
            "dedupe_key": f"ETHUSDT|15m|shooting_star|{t0}",
        },
        fired_at_ms=fired,
    )
    rec, _ = advance_lifecycle_record(rec, bars, now_ms=t1 + 1)
    assert rec["status"] == "active_entered"
    rec, ev = advance_lifecycle_record(rec, bars, now_ms=t2 + 900_000)
    assert rec["status"] == "ignored_tp"
    assert ev and ev["lifecycle_status"] == "ignored_tp"


def test_terminal_status():
    assert is_terminal_status("ignored_expired")
    assert not is_terminal_status("active_entered")
