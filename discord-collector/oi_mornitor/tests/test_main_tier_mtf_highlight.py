from oi_mornitor.main_card_policy import (
    is_main_card_agreed_push_eligible,
    is_main_card_mirror_eligible,
)
from oi_mornitor.main_tier_mtf_highlight import (
    decorate_main_chat_tier_mtf_message,
    main_tier_mtf_highlight_meta,
)
from oi_mornitor.mcap_market_quote import reset_market_cap_cache_for_tests
from oi_mornitor.mcap_tier import reload_mcap_tier_config


def setup_function() -> None:
    reload_mcap_tier_config()
    reset_market_cap_cache_for_tests({}, freeze=True)


def test_btc_t1_mtf_gets_priority_banner(monkeypatch) -> None:
    monkeypatch.setattr(
        "oi_mornitor.config.MAIN_CARD_TELEGRAM_CHAT_ID",
        "-1003860925903",
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight.mtf_tier_count_for_alert",
        lambda _a, peers=None: 2,
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight._confluence_tier_exact_a",
        lambda _a: True,
    )
    alert = {"symbol": "BTCUSDT", "interval": "15m", "type_label": "射击之星"}
    text = decorate_main_chat_tier_mtf_message(alert, "body", "-1003860925903")
    assert "BTC 重中之重" in text
    assert "body" in text
    assert alert.get("mainTierMtfHighlight") is True


def test_non_t1_no_banner(monkeypatch) -> None:
    monkeypatch.setattr(
        "oi_mornitor.config.MAIN_CARD_TELEGRAM_CHAT_ID",
        "-1003860925903",
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight.mtf_tier_count_for_alert",
        lambda _a, peers=None: 2,
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight._confluence_tier_exact_a",
        lambda _a: True,
    )
    alert = {"symbol": "NEARUSDT", "interval": "15m"}
    assert main_tier_mtf_highlight_meta(alert) is None
    text = decorate_main_chat_tier_mtf_message(alert, "x", "-1003860925903")
    assert text == "x"


def test_t2_mtf_a_gets_banner(monkeypatch) -> None:
    monkeypatch.setattr(
        "oi_mornitor.config.MAIN_CARD_TELEGRAM_CHAT_ID",
        "-1003860925903",
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight.mtf_tier_count_for_alert",
        lambda _a, peers=None: 2,
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight._confluence_tier_exact_a",
        lambda _a: True,
    )
    alert = {"symbol": "NEARUSDT", "interval": "15m"}
    meta = main_tier_mtf_highlight_meta(alert)
    assert meta is not None
    assert meta["mcapTier"] == "t2"
    text = decorate_main_chat_tier_mtf_message(alert, "body", "-1003860925903")
    assert "第二梯队" in text
    assert "body" in text


def test_not_a_tier_no_banner(monkeypatch) -> None:
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight.mtf_tier_count_for_alert",
        lambda _a, peers=None: 2,
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight._confluence_tier_exact_a",
        lambda _a: False,
    )
    alert = {"symbol": "BTCUSDT", "interval": "15m"}
    assert main_tier_mtf_highlight_meta(alert) is None


def test_agreed_push_requires_15m(monkeypatch) -> None:
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight.mtf_tier_count_for_alert",
        lambda _a, peers=None: 2,
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight._confluence_tier_exact_a",
        lambda _a: True,
    )
    assert (
        is_main_card_agreed_push_eligible(
            {"symbol": "BTCUSDT", "interval": "1h", "type": "candle_pattern_card"}
        )
        is False
    )
    assert is_main_card_agreed_push_eligible(
        {"symbol": "BTCUSDT", "interval": "15m", "type": "candle_pattern_card"}
    )


def test_mirror_eligible_blocks_1h_when_agreed_on(monkeypatch) -> None:
    monkeypatch.setenv("OI_MAIN_CARD_AGREED_PUSH", "1")
    monkeypatch.setattr(
        "oi_mornitor.main_card_policy._is_main_candle_type_label",
        lambda _l: True,
    )
    monkeypatch.setattr(
        "oi_mornitor.main_card_policy.is_main_card_symbol",
        lambda _s: True,
    )
    monkeypatch.setattr(
        "oi_mornitor.main_card_policy.main_card_intervals_for_symbol",
        lambda _s: frozenset({"15m", "1h"}),
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight.mtf_tier_count_for_alert",
        lambda _a, peers=None: 2,
    )
    monkeypatch.setattr(
        "oi_mornitor.main_tier_mtf_highlight._confluence_tier_exact_a",
        lambda _a: True,
    )
    base = {
        "symbol": "BTCUSDT",
        "type": "candle_pattern_card",
        "type_label": "射击之星",
        "main_mirror_vol_ok": True,
    }
    assert is_main_card_mirror_eligible({**base, "interval": "1h"}) is False
    assert is_main_card_mirror_eligible({**base, "interval": "15m"}) is True