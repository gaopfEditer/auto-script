from oi_mornitor.mcap_market_quote import reset_market_cap_cache_for_tests
from oi_mornitor.mcap_tier import (
    attach_mcap_tier,
    reload_mcap_tier_config,
    resolve_mcap_tier,
    tier_from_market_cap_usd,
    mcap_thresholds_usd,
)


def setup_function() -> None:
    reload_mcap_tier_config()
    reset_market_cap_cache_for_tests({}, freeze=True)


def test_thresholds_from_config() -> None:
    t1, t2 = mcap_thresholds_usd()
    assert t1 == 50_000_000_000
    assert t2 == 8_000_000_000


def test_tier_from_market_cap_boundaries() -> None:
    assert tier_from_market_cap_usd(50_000_000_001) == "t1"
    assert tier_from_market_cap_usd(50_000_000_000) == "t2"  # 大于 500 亿才进第一档
    assert tier_from_market_cap_usd(8_000_000_001) == "t2"
    assert tier_from_market_cap_usd(8_000_000_000) == "t3"
    assert tier_from_market_cap_usd(None) == "t3"
    assert tier_from_market_cap_usd(200_000_000_000, excluded=True) == "t3"


def test_resolve_uses_live_caps_and_excludes_stables() -> None:
    reset_market_cap_cache_for_tests(
        {
            "BTC": 1_439_000_000_000,
            "ETH": 245_000_000_000,
            "BNB": 85_900_000_000,
            "USDT": 175_000_000_000,
            "USDC": 69_000_000_000,
            "XRP": 65_000_000_000,
            "SOL": 48_000_000_000,
            "TRX": 30_000_000_000,
            "HYPE": 17_000_000_000,
            "ZEC": 16_000_000_000,
            "XMR": 10_500_000_000,
            "DOGE": 10_300_000_000,
            "LEO": 8_500_000_000,
            "WBT": 8_200_000_000,
            "LINK": 7_600_000_000,
            "ADA": 6_400_000_000,
        },
        freeze=True,
    )
    assert resolve_mcap_tier("BTCUSDT") == "t1"
    assert resolve_mcap_tier("ETHUSDT") == "t1"
    assert resolve_mcap_tier("BNBUSDT") == "t1"
    assert resolve_mcap_tier("USDTUSDT") == "t3"
    assert resolve_mcap_tier("USDCUSDT") == "t3"
    assert resolve_mcap_tier("XRPUSDT") == "t1"
    assert resolve_mcap_tier("SOLUSDT") == "t2"
    assert resolve_mcap_tier("TRXUSDT") == "t2"
    assert resolve_mcap_tier("HYPEUSDT") == "t2"
    assert resolve_mcap_tier("ZECUSDT") == "t2"
    assert resolve_mcap_tier("XMRUSDT") == "t2"
    assert resolve_mcap_tier("DOGEUSDT") == "t2"
    assert resolve_mcap_tier("LEOUSDT") == "t2"
    assert resolve_mcap_tier("WBTUSDT") == "t2"
    assert resolve_mcap_tier("LINKUSDT") == "t3"
    assert resolve_mcap_tier("ADAUSDT") == "t3"
    assert resolve_mcap_tier("FIGR_HELOCUSDT") == "t3"
    assert resolve_mcap_tier("PEPEUSDT") == "t3"


def test_attach_mcap_tier_sets_fields() -> None:
    reset_market_cap_cache_for_tests({"BTC": 1.4e12, "SOL": 4.8e10}, freeze=True)
    rows = [{"symbol": "BTCUSDT"}, {"tradeSymbol": "SOLUSDT"}, {"symbol": "FOOUSDT"}]
    attach_mcap_tier(rows)
    assert rows[0]["mcapTier"] == "t1"
    assert rows[0]["marketCapUsd"] == 1.4e12
    assert rows[1]["mcapTier"] == "t2"
    assert rows[2]["mcapTier"] == "t3"
    assert "marketCapUsd" not in rows[2]


def test_empty_cache_falls_back_to_configured_symbols() -> None:
    reset_market_cap_cache_for_tests({}, freeze=True)
    assert resolve_mcap_tier("BNBUSDT") == "t1"
    assert resolve_mcap_tier("DOGEUSDT") == "t2"
    assert resolve_mcap_tier("LEOUSDT") == "t2"
    assert resolve_mcap_tier("WBTUSDT") == "t2"
    assert resolve_mcap_tier("ADAUSDT") == "t3"
