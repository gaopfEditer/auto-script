"""消融实验 A–E：同一引擎上的开关，不是五套复制的回测内核。

各组使用相同区间、手续费、滑点、杠杆与成交规则。
A  现有形态 + 均线 + Vegas（默认暂停的二次探底仍排除；射击之星默认纳入）
B  A + BTC 市场状态过滤
C  B + OI / 资金费 / 清算确认（有序列才要求；缺失则标记并跳过该确认）
D  C + 扫流动性收回 / CVD / 吸收
E  D + 分档独立止损止盈与风险预算（完整 V1）
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


EXPERIMENT_IDS = ("A", "B", "C", "D", "E")

EXPERIMENT_LABELS = {
    "A": "现有形态 + 均线 + Vegas",
    "B": "A + BTC 市场状态过滤",
    "C": "B + OI / 资金费 / 清算确认",
    "D": "C + 扫流动性收回 / CVD / 吸收",
    "E": "D + 分档止损止盈与风险预算（完整 V1）",
}


@dataclass(frozen=True)
class ExperimentFlags:
    id: str
    label: str
    btc_regime_filter: bool
    oi_funding_liq_confirm: bool
    sweep_cvd_absorption: bool
    per_tier_params: bool
    include_existing_patterns: bool = True
    exclude_paused_kinds: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def flags_for(experiment: str | None) -> ExperimentFlags:
    key = str(experiment or "E").strip().upper()
    if key not in EXPERIMENT_IDS:
        key = "E"
    # 累进打开
    btc = key >= "B"
    oi = key >= "C"
    sweep = key >= "D"
    tier = key == "E"
    return ExperimentFlags(
        id=key,
        label=EXPERIMENT_LABELS[key],
        btc_regime_filter=btc,
        oi_funding_liq_confirm=oi,
        sweep_cvd_absorption=sweep,
        per_tier_params=tier,
        include_existing_patterns=True,
        exclude_paused_kinds=True,
    )


def experiment_options() -> list[dict[str, Any]]:
    return [flags_for(k).to_dict() | {"id": k, "label": EXPERIMENT_LABELS[k]} for k in EXPERIMENT_IDS]


def passes_btc_regime_filter(
    *,
    flags: ExperimentFlags,
    direction: str | None,
    btc_regime_4h: str | None,
    is_btc: bool = False,
) -> tuple[bool, str]:
    """B+：山寨方向不得与 BTC 4H 冲突。BTC 本身不过滤为自己。"""
    if not flags.btc_regime_filter:
        return True, "filter_off"
    if is_btc:
        return True, "self_btc"
    r = str(btc_regime_4h or "").strip().lower()
    if not r or r in ("unknown",):
        return True, "btc_regime_unavailable"
    side = str(direction or "").lower()
    if side in ("bull", "long"):
        if r in ("trend_down", "downtrend", "down"):
            return False, "btc_4h_down_no_alt_long"
        return True, "btc_regime_ok"
    if side in ("bear", "short"):
        if r in ("trend_up", "uptrend", "up"):
            return False, "btc_4h_up_no_alt_short"
        return True, "btc_regime_ok"
    return True, "no_direction"


def passes_oi_funding_liq_confirm(
    *,
    flags: ExperimentFlags,
    oi_status: str | None = None,
    funding_ok: bool | None = None,
    funding_available: bool = False,
    liq_ok: bool | None = None,
    liq_available: bool = False,
    oi_available: bool = False,
) -> tuple[bool, str, dict[str, Any]]:
    """C+：有数据时要求确认；缺失则标记，不假装已经确认。

    返回 (pass, reason, data_flags)。缺失数据不过度拦截（避免把「无数据」当成确认），
    但也不会把缺失写成已确认。若明确不利（adverse / crowded chase / 清算尚未衰竭）则拒绝。
    """
    flags_out: dict[str, Any] = {}
    if not flags.oi_funding_liq_confirm:
        return True, "filter_off", flags_out
    reasons: list[str] = []
    ok = True
    if not oi_available or not oi_status or oi_status in ("oi_unavailable", "unknown", ""):
        flags_out["oi_missing"] = True
        reasons.append("oi_unavailable")
    elif oi_status == "adverse":
        ok = False
        reasons.append("oi_adverse")
    else:
        reasons.append(f"oi_{oi_status}")

    if not funding_available or funding_ok is None:
        flags_out["funding_missing"] = True
        reasons.append("funding_unavailable")
    elif funding_ok is False:
        ok = False
        reasons.append("funding_crowded")
    else:
        reasons.append("funding_ok")

    if not liq_available or liq_ok is None:
        flags_out["liquidation_missing"] = True
        reasons.append("liquidation_unavailable")
    elif liq_ok is False:
        ok = False
        reasons.append("liquidation_not_exhausted")
    else:
        reasons.append("liquidation_ok")

    return ok, "+".join(reasons) if reasons else "ok", flags_out
