"""MAIN 群 Telegram：第一/二梯队 + 综合 A + 多周期共振顶栏（BTC 重中之重）。"""
from __future__ import annotations

from typing import Any

from oi_mornitor.config import MAIN_CARD_TELEGRAM_CHAT_ID
from oi_mornitor.mcap_tier import mcap_tier_label, resolve_mcap_tier
from oi_mornitor.pattern_push_gate import mtf_tier_count_for_alert
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol


def _main_chat_id(chat_id: str) -> bool:
    main = str(MAIN_CARD_TELEGRAM_CHAT_ID or "").strip()
    got = str(chat_id or "").strip()
    return bool(main and got and main == got)


def _confluence_tier_exact_a(alert: dict[str, Any]) -> bool:
    from oi_mornitor.pattern_emit_gate import attach_confluence_on_alert

    conf = alert.get("confluence")
    if not isinstance(conf, dict):
        conf = attach_confluence_on_alert(alert)
    return str(conf.get("tier") or "C").strip().upper() == "A"


def main_tier_mtf_highlight_meta(alert: dict[str, Any]) -> dict[str, Any] | None:
    """第一/二梯队 · 综合 A · 多周期共振（≥2 周期）时返回标记元数据。"""
    if not isinstance(alert, dict):
        return None
    if not _confluence_tier_exact_a(alert):
        return None
    sym_raw = str(alert.get("symbol") or alert.get("tradeSymbol") or "")
    trade = normalize_usdt_symbol(sym_raw) or sym_raw.strip().upper()
    if not trade:
        return None
    tier = resolve_mcap_tier(trade)
    if tier not in ("t1", "t2"):
        return None
    tiers = mtf_tier_count_for_alert(alert)
    if tiers < 2:
        return None
    base = human_base_asset(trade) or trade.replace("USDT", "")
    is_btc = tier == "t1" and trade == "BTCUSDT"
    return {
        "mcapTier": tier,
        "mcapTierLabel": mcap_tier_label(tier),
        "mtfTiers": tiers,
        "tradeSymbol": trade,
        "base": base,
        "btcPriority": is_btc,
    }


def decorate_main_chat_tier_mtf_message(
    alert: dict[str, Any],
    text: str,
    chat_id: str,
) -> str:
    """仅 MAIN_CARD 群：为 t1/t2 综合 A 多周期共振加顶栏（BTC 加强）。"""
    body = str(text or "")
    if not _main_chat_id(chat_id):
        return body
    meta = main_tier_mtf_highlight_meta(alert)
    if not meta:
        return body
    if meta.get("btcPriority"):
        banner = (
            "━━━━━━━━━━━━━━━━\n"
            "‼️ BTC 重中之重 · 第一梯队 · 多周期共振 · 综合 A\n"
            f"（共振 {meta['mtfTiers']} 周期 · {meta['mcapTierLabel']}）\n"
            "━━━━━━━━━━━━━━━━"
        )
    elif meta.get("mcapTier") == "t2":
        banner = (
            "⭐ 第二梯队 · 多周期共振 · 综合 A\n"
            f"{meta['base']} · 共振 {meta['mtfTiers']} 周期 · {meta['mcapTierLabel']}\n"
            "────────────────"
        )
    else:
        banner = (
            "⭐ 第一梯队 · 多周期共振 · 综合 A\n"
            f"{meta['base']} · 共振 {meta['mtfTiers']} 周期 · {meta['mcapTierLabel']}\n"
            "────────────────"
        )
    if isinstance(alert, dict):
        alert["mainTierMtfHighlight"] = True
        alert["mainTierMtfBtcPriority"] = bool(meta.get("btcPriority"))
    return f"{banner}\n\n{body}"