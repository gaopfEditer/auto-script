"""KOL 二次预警：名单门禁、形态标签、dedupe。"""
from __future__ import annotations

from oi_mornitor.kol_secondary_alert import (
    PATTERN_ZH,
    alert_key,
    follow_patterns,
    upsert_watchlist_from_card,
)


def test_pattern_zh_inverted_hammer():
    assert PATTERN_ZH["inverted_hammer"] == "倒锤子"
    assert "倒垂子" not in PATTERN_ZH.values()


def test_follow_patterns_excludes_hammer():
    allow = follow_patterns()
    assert "hammer" not in allow
    assert "inverted_hammer" in allow
    assert "engulfing" in allow
    assert "shooting_star" in allow


def test_upsert_watchlist_followed_channel_only():
    wl: dict = {"symbols": {}}
    followed = {"chan-followed"}
    card = {
        "symbol": "SOLUSDT",
        "channel_id": "chan-followed",
        "mentioned_at": "2026-01-01T00:00:00Z",
        "id": 1,
    }
    assert upsert_watchlist_from_card(wl, card, followed_ids=followed) is True
    assert "SOLUSDT" in wl["symbols"]


def test_upsert_watchlist_rejects_non_kol_non_leader():
    wl: dict = {"symbols": {}}
    followed = {"chan-followed"}
    card = {
        "symbol": "DOGEUSDT",
        "channel_id": "chan-random",
        "mentioned_at": "2026-01-01T00:00:00Z",
        "id": 2,
    }
    assert upsert_watchlist_from_card(wl, card, followed_ids=followed) is False
    assert wl["symbols"] == {}


def test_upsert_watchlist_leader_passthrough_any_channel():
    wl: dict = {"symbols": {}}
    followed: set[str] = set()
    card = {
        "symbol": "BTCUSDT",
        "channel_id": "any-kol-channel",
        "mentioned_at": "2026-01-01T00:00:00Z",
        "id": 3,
    }
    assert upsert_watchlist_from_card(wl, card, followed_ids=followed) is True
    assert wl["symbols"]["BTCUSDT"].get("leader") is True


def test_alert_key_format():
    assert alert_key("BTCUSDT", "15m", "inverted_hammer", 1700000000000) == (
        "BTCUSDT|15m|inverted_hammer|1700000000000"
    )
