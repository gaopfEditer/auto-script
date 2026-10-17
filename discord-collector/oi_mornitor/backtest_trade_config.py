"""回测交易成本与入场口径（与 Live 对齐，经 env_parse 安全默认）。"""
from __future__ import annotations

from oi_mornitor.env_parse import env_bool, env_float, env_str

# Bitget 合约 taker 约 0.06%/边；默认双边计入
OI_BT_FEE_PCT = env_float("OI_BT_FEE_PCT", 0.06, min_val=0.0, max_val=5.0)
OI_BT_SLIPPAGE_PCT = env_float("OI_BT_SLIPPAGE_PCT", 0.03, min_val=0.0, max_val=5.0)
# next_bar_open：信号柱收盘后下一根开盘价（贴近 TG 推送后市价）；bar_close：确认柱收盘
OI_BT_ENTRY_MODE = env_str("OI_BT_ENTRY_MODE", "next_bar_open").lower()
if OI_BT_ENTRY_MODE not in ("next_bar_open", "bar_close"):
    OI_BT_ENTRY_MODE = "next_bar_open"

# 结算步进：5m K 线逐步 + 同柱 SL 优先（避免 15m 聚合掩盖顺序）
OI_BT_SETTLE_FINE_BARS = env_bool("OI_BT_SETTLE_FINE_BARS", True)
# TP1 成交后剩余仓位止损抬至成本（对齐 Bitget staged TP1 breakeven）
OI_BT_BREAKEVEN_AFTER_TP1 = env_bool("OI_BT_BREAKEVEN_AFTER_TP1", True)
# 回测是否应用与胜率入库相同的统一门控（MTF≥2、停推类型等）
OI_BT_APPLY_EMIT_GATE = env_bool("OI_BT_APPLY_EMIT_GATE", True)
