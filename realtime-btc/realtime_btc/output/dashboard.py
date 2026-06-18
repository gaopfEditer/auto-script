"""终端 / Webhook 结构化看板输出."""

from __future__ import annotations

import json
import logging
from typing import Any

import urllib.request

from realtime_btc.config import Settings
from realtime_btc.models import DecisionResult, SignalSide, StaticLevelsResult, TrendFilterResult

log = logging.getLogger(__name__)


def _money(v: float) -> str:
    return f"${v:,.0f}"


def format_dashboard(
    symbol: str,
    price: float,
    trend: TrendFilterResult,
    levels: StaticLevelsResult,
    decision: DecisionResult,
) -> str:
    lines: list[str] = []
    sep = "=" * 50
    lines.append(sep)
    lines.append(f"【币安实时信号监控】 币种: {symbol}  当前价: {_money(price)}")
    lines.append(sep)
    lines.append(f"当前大级别趋势: {trend.label_zh}")
    lines.append("")
    lines.append("[核心空间坐标轴]")

    resist = max(levels.high_1, levels.poc, levels.vah)
    support = min(levels.low_1, levels.val)
    lines.append(f"- 上方强压力位：{_money(resist)} (昨日POC/高点 + 价值区)")
    lines.append(f"- 下方核心支撑：{_money(support)} (昨日低点 + VAL 清算带)")
    lines.append(f"- 1H Vegas 中线：{_money(levels.vegas_1h_line)}")
    lines.append("")

    if not decision.triggered or decision.target_level is None:
        lines.append("[当前触发警报]")
        lines.append("— 价格尚未进入关键位 0.5% 误差带，持续监控中 —")
        lines.append(sep)
        return "\n".join(lines)

    lv = decision.target_level
    kind = "支撑位" if decision.side == SignalSide.LONG else "压力位"
    lines.append("[当前触发警报]")
    lines.append(
        f"⚠️ 价格正在逼近核心{kind}: {_money(lv.price)} (当前距离: {decision.distance_pct:.2f}%)"
    )
    lines.append("")
    lines.append("[智能操作向导]")
    g = decision.guidance
    if g:
        lines.append(f"▶ 逻辑类型：{g.logic_type}")
    cb = decision.confidence
    lines.append(f"▶ 信心指数：{cb.total} / 100 【{cb.tier_zh()}】")
    lines.append(f"  - 趋势共振：+{cb.trend} (顺 4H Vegas)")
    conf_note = " + ".join(decision.notes[:2]) if decision.notes else lv.label
    lines.append(f"  - 位置重合：+{cb.confluence} ({conf_note})")
    flow_note = "5m/15m 收针" if decision.pin_detected else "无明显针形"
    if cb.flow >= 25:
        flow_note += " + OI 异常放量"
    lines.append(f"  - 资金表态：+{cb.flow} ({flow_note})")
    liq_note = next((n for n in decision.notes if "强平" in n), "暂无大规模强平")
    lines.append(f"  - 散户惨状：+{cb.liquidation} ({liq_note})")
    if g:
        lines.append("")
        lines.append("▶ 挂单指令指导：")
        lines.append(f"  - 激活入口：{g.entry_hint}")
        lines.append(f"  - 止损设置 (SL)：{_money(g.stop_loss)} (严防插针跌破)")
        lines.append(f"  - 止盈设置 (TP1)：{_money(g.take_profit_1)}  (TP2): {_money(g.take_profit_2)}")
    lines.append(sep)
    return "\n".join(lines)


def emit_dashboard(
    settings: Settings,
    text: str,
    payload: dict[str, Any] | None = None,
) -> None:
    print(text, flush=True)
    if settings.webhook_url:
        body = {"text": text}
        if payload:
            body["payload"] = payload
        try:
            req = urllib.request.Request(
                settings.webhook_url,
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            log.warning("Webhook 发送失败: %s", e)
