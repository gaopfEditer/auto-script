"""成交价与执行路径分离后的费用账本：入场滑点只记一次。"""
from __future__ import annotations

from typing import Any


def apply_slippage(price: float, *, side: str, slippage_pct: float, action: str) -> float:
    """action=entry：多更高、空更低；action=exit：多更低、空更高。"""
    if price <= 0 or slippage_pct <= 0:
        return float(price)
    slip = float(price) * float(slippage_pct) / 100.0
    is_short = str(side or "").lower() in ("short", "bear")
    if action == "entry":
        return float(price) - slip if is_short else float(price) + slip
    return float(price) + slip if is_short else float(price) - slip


def price_move_pct(entry: float, exit_px: float, *, side: str) -> float:
    if entry <= 0:
        return 0.0
    raw = (exit_px - entry) / entry * 100.0
    if str(side or "").lower() in ("short", "bear"):
        return -raw
    return raw


def fee_usdt(qty: float, price: float, fee_pct: float) -> float:
    return abs(float(qty)) * float(price) * float(fee_pct) / 100.0


def signed_pnl_usdt(qty: float, entry: float, exit_px: float, *, side: str) -> float:
    if str(side or "").lower() in ("short", "bear"):
        return abs(float(qty)) * (entry - exit_px)
    return abs(float(qty)) * (exit_px - entry)


def new_ledger(
    *,
    side: str,
    entry_requested: float,
    entry_filled: float,
    qty: float,
    fee_pct: float,
    slippage_pct: float,
) -> dict[str, Any]:
    entry_slip_pct = price_move_pct(entry_requested, entry_filled, side=side) * -1.0
    return {
        "side": side,
        "entryRequested": entry_requested,
        "entryFilled": entry_filled,
        "qty": qty,
        "feePctPerSide": fee_pct,
        "slippagePctPerSide": slippage_pct,
        "entrySlipPrice": entry_filled - entry_requested,
        "entrySlipPctAlreadyInFill": round(entry_slip_pct, 8),
        "entryFeeUsdt": fee_usdt(qty, entry_filled, fee_pct),
        "legs": [],
        "exitFeeUsdt": 0.0,
        "exitSlipUsdt": 0.0,
        "grossUsdt": 0.0,
        "netUsdt": 0.0,
        "pnlPctGross": 0.0,
        "pnlPctNet": 0.0,
        "feeUsdtTotal": 0.0,
        "notes": (
            "入场价已含不利滑点，净额不再二次扣除入场滑点；"
            "出场按路径原始触发价再加一次不利滑点；双边各收一次手续费。"
            "资金费本阶段不建模、不虚构。"
        ),
    }


def add_leg(
    ledger: dict[str, Any],
    *,
    reason: str,
    raw_price: float,
    frac: float,
    ts: int | None = None,
) -> dict[str, Any]:
    """一笔部分或全部平仓。路径用 raw_price 判定，成交价再滑点。"""
    side = ledger["side"]
    slip = float(ledger["slippagePctPerSide"])
    fee_pct = float(ledger["feePctPerSide"])
    qty_total = float(ledger["qty"])
    entry = float(ledger["entryFilled"])
    exit_filled = apply_slippage(raw_price, side=side, slippage_pct=slip, action="exit")
    qty = abs(qty_total) * float(frac)
    gross = signed_pnl_usdt(qty, entry, raw_price, side=side)
    slipped = signed_pnl_usdt(qty, entry, exit_filled, side=side)
    exit_slip_usdt = slipped - gross
    # 入场手续费按平仓比例分摊，避免整笔在开仓时一次性计入导致部分止盈对账不清
    entry_fee = fee_usdt(qty, entry, fee_pct)
    exit_fee = fee_usdt(qty, exit_filled, fee_pct)
    net = slipped - entry_fee - exit_fee
    gross_pct = price_move_pct(entry, raw_price, side=side) * float(frac)
    net_pct = price_move_pct(entry, exit_filled, side=side) * float(frac)
    # 手续费用价格百分比近似：fee_pct * frac（入）+ fee_pct * frac * exit/entry（出）
    fee_pct_move = (entry_fee + exit_fee) / (abs(qty_total) * entry) * 100.0 if entry > 0 and qty_total else 0.0
    net_pct -= fee_pct_move
    leg = {
        "reason": reason,
        "ts": ts,
        "frac": float(frac),
        "rawPrice": float(raw_price),
        "exitFilled": float(exit_filled),
        "qty": qty,
        "grossUsdt": gross,
        "exitSlipUsdt": exit_slip_usdt,
        "entryFeeUsdt": entry_fee,
        "exitFeeUsdt": exit_fee,
        "netUsdt": net,
        "pnlPctGross": gross_pct,
        "pnlPctNet": net_pct,
    }
    ledger["legs"].append(leg)
    _roll_ledger(ledger)
    return leg


def _roll_ledger(ledger: dict[str, Any]) -> None:
    legs = ledger["legs"]
    ledger["grossUsdt"] = sum(x["grossUsdt"] for x in legs)
    ledger["exitSlipUsdt"] = sum(x["exitSlipUsdt"] for x in legs)
    ledger["exitFeeUsdt"] = sum(x["exitFeeUsdt"] for x in legs)
    entry_fee_allocated = sum(x["entryFeeUsdt"] for x in legs)
    ledger["entryFeeUsdtAllocated"] = entry_fee_allocated
    ledger["feeUsdtTotal"] = entry_fee_allocated + ledger["exitFeeUsdt"]
    ledger["netUsdt"] = sum(x["netUsdt"] for x in legs)
    ledger["pnlPctGross"] = sum(x["pnlPctGross"] for x in legs)
    ledger["pnlPctNet"] = sum(x["pnlPctNet"] for x in legs)


def reconcile_ledger(ledger: dict[str, Any], *, tol: float = 1e-8) -> list[str]:
    """逐笔对账：净额 = 毛额 + 出场滑点 - 双边手续费。入场滑点不得再从净额扣一次。"""
    issues: list[str] = []
    legs = ledger.get("legs") or []
    gross = sum(x["grossUsdt"] for x in legs)
    exit_slip = sum(x["exitSlipUsdt"] for x in legs)
    fees = sum(x["entryFeeUsdt"] + x["exitFeeUsdt"] for x in legs)
    net = sum(x["netUsdt"] for x in legs)
    expect = gross + exit_slip - fees
    if abs(net - expect) > tol:
        issues.append(f"net_mismatch net={net} expect={expect}")
    if abs(ledger.get("netUsdt", 0) - net) > tol:
        issues.append("ledger_net_not_rolled")
    # 入场滑点只应出现在 entryFilled vs entryRequested，不得作为额外一次性减项
    if "entrySlipDoubleCounted" in ledger:
        issues.append("flagged_double_count")
    closed_frac = sum(x["frac"] for x in legs)
    if closed_frac > 1.0 + 1e-9:
        issues.append(f"frac_over_one:{closed_frac}")
    return issues
