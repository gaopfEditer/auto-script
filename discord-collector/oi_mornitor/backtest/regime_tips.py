"""回测页「行情环境」提示 — 机制口径，非喊单。

供 /api/backtest/*/options 与前端 tip 图标共用。
字段：fits / fails / watch（各 1–3 句短文）。
"""
from __future__ import annotations

from typing import Any


REGIME_TIPS: dict[str, dict[str, Any]] = {
    "structure": {
        "id": "structure",
        "title": "结构/形态扫描",
        "fits": "震荡后的二次测试、流动性扫损回补、明确结构突破回踩；多周期方向一致时更稳。",
        "fails": "单边急趋势中的逆向插针、低流动性杂讯影线、无结构上下文的随机 K 线形态。",
        "watch": "综合分档与多周期共振过滤；入场后结构失效位是否被快速吞没。",
    },
    "nlv": {
        "id": "nlv",
        "title": "新高/新低末端+放量",
        "fits": "区间或均值回归市：50 根极值末端出现反向实体且放量，常对应短线反转试探。",
        "fails": "单边趋势中新高/新低持续延伸（末端反复失败）；消息驱动跳空后无结构承接。",
        "watch": "插针风险是否落在 0.2%–2%；冷却窗内同向重复信号；入场是否已穿越信号棒极值。",
    },
    "dca": {
        "id": "dca",
        "title": "短线 DCA（总览）",
        "fits": "模块组合服务短线观察与批量回测：NLV 翻转、TD9 多头开平、或共振计分。",
        "fails": "把告警模块直接当无止损网格；在强趋势里叠加逆向 DCA。",
        "watch": "先选 Mode；A/B 才产生成交；C 默认只计分。Pine 原脚本策略开关默认关。",
    },
    "dca_nlv_flip": {
        "id": "dca_nlv_flip",
        "title": "Mode A · NLV 翻转 DCA",
        "fits": "区间末端放量反转可双向试错的环境；用插针极值做小止损、可选 R 倍数止盈。",
        "fails": "趋势市里买卖信号来回翻转（鞭索）；波动过窄/过宽被风险过滤剔除后样本偏差。",
        "watch": "与独立 NLV 回测口径一致的 pin+exit_plan；翻转时旧仓是否按下一根开盘了结。",
    },
    "dca_td9_long": {
        "id": "dca_td9_long",
        "title": "Mode B · TD9 只做多",
        "fits": "温和震荡或缓跌后的 TD Setup 耗尽（-9），期望向均值回归的反弹段。",
        "fails": "强空头瀑布中 -9 只是中继；长趋势里 +9 迟迟不出现导致持仓拖长。",
        "watch": "出场以对手 TD9（+9）下一根开盘为准（对齐 Pine）；默认不加插针 SL，缺口风险自负。",
    },
    "dca_confluence": {
        "id": "dca_confluence",
        "title": "Mode C · 共振计分（告警）",
        "fits": "需要统计 TD9 / Vegas 近轨形态 / NLV 同棒共振频率，而不是立刻下单时。",
        "fails": "把高分当成胜率保证；单模块噪声在无 Vegas/NLV 确认时被加总。",
        "watch": "V 前缀仅 near_v（BB 宽×20% 贴近 144/169/576/676）；倒锤要求低于中轨且非射击之星。",
    },
    "td9": {
        "id": "td9",
        "title": "TD9 Setup",
        "fits": "比较收盘与 4 根前收盘的九计数耗尽，偏短线超买超卖标注。",
        "fails": "趋势中继段反复打出 ±9；横盘无方向时计数抖动。",
        "watch": "只作 Setup（非 Countdown）；回测入场用已收盘柱，成交下一根开盘。",
    },
    "short_term_v1": {
        "id": "short_term_v1",
        "title": "短线策略 V1",
        "fits": "4H 趋势或有边界的震荡；15M 形成扫单收回、放量突破回踩或吸收确认后，5M 再执行。",
        "fails": "高波动风险期追单、小币只看 K 线形态、扫单尚未收回就反向、结构止损过远导致仓位过小或盈亏比不够。",
        "watch": "研究起点，不是已验证优势。美股代币默认排除。二次探底默认暂停；射击之星默认启用且须过情境闸。回测用下一根开盘+滑点，现货 K 线仅作合约价格代理。",
    },
    "vegas_candle": {
        "id": "vegas_candle",
        "title": "维加斯近轨 + 射击之星/倒锤子",
        "fits": "价格回到 Vegas 簇（144/169/576/676）附近、带宽未失控时的耗尽影线。",
        "fails": "Vegas 陡峭单边、布林急剧扩张时的「看起来像」射击/锤子；远离通道的中继影线。",
        "watch": "5 棒内二次射击（ss2）；倒锤仅 below BB mid；V 标签=near_v。",
    },
}


def tip_for(key: str) -> dict[str, Any] | None:
    return REGIME_TIPS.get(str(key or "").strip().lower())


def tips_payload(*keys: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for k in keys:
        t = tip_for(k)
        if t:
            out.append(dict(t))
    return out


def all_tips() -> list[dict[str, Any]]:
    return [dict(v) for v in REGIME_TIPS.values()]
