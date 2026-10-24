"""潜力五模型 · 常见走势与注意事项（形态页悬浮说明）。"""
from __future__ import annotations

from typing import Any

MODEL_PLAYBOOK: dict[str, dict[str, Any]] = {
    "quiet_oi_breakout": {
        "typical_outlook": (
            "主路径：长期缩量沉寂、波动收敛 → 单根或数根明显放量 → 随后多根量能维持、价格延续。"
            "OI 抬升仅作辅证；单根脉冲无量延续时，多在短期内回到沉寂区。"
        ),
        "cautions": [
            "小市值易被控盘假突破，需对照现货深度与 BTC 大环境。",
            "未达 triggered+延续 的观察项不会进入默认导出列表。",
            "放量后量能快速萎缩时，按衰竭处理，勿追最后一脚。",
        ],
        "stage_hints": {
            "watch": "量/波动沉寂，尚未出现有效放量突增。",
            "primed": "近端已放量，等待多根延续确认。",
            "triggered": "沉寂→放量→延续齐备，叙事成立（仍非实盘信号）。",
            "exiting": "延续失败或回撤放大，疑单根脉冲结束。",
        },
    },
    "short_squeeze": {
        "typical_outlook": (
            "可选辅模型（默认关闭）：OI 增 + 价格抗跌突破为主叙事；"
            "资金费率仅展示在诊断字段，默认不参与打分。"
            "启用：OI_POTENTIAL_INCLUDE_SHORT_SQUEEZE=1。"
        ),
        "cautions": [
            "轧空可多次假启动，T3 滑点与止损要预留。",
            "stage=exiting 或费率已明显回升时，不宜追最后一脚。",
            "现货大量转入交易所常预示派发，与轧空叙事冲突。",
        ],
        "stage_hints": {
            "watch": "费率偏负+OI 缓增，价格未动，等待触发 K。",
            "primed": "抗跌明显，随时可能拉升，仓位宜轻。",
            "triggered": "拉升进行中，设 trailing 或分批止盈。",
            "exiting": "费率/OI 修复，轧空尾声，防 A 字回落。",
        },
    },
    "relative_strength": {
        "typical_outlook": (
            "BTC 下跌或横盘时本币相对抗跌，BTC 企稳后本币常率先突破前高；"
            "若随后 BTC 同步转强，常见一段 lag 补涨。失败路径则是 BTC 再跌时本币补跌更深。"
        ),
        "cautions": [
            "VS_BTC 为负却标 relative_strength 多为观察分，需看是否真突破+放量。",
            "仅 15m/1h 触发而 4h 结构弱，容易一日游。",
            "BTC 涨时本币滞涨是首要失效信号，应降权或离场。",
        ],
        "stage_hints": {
            "watch": "相对抗跌但未突破，等 trigger 周期确认。",
            "primed": "EMA/汇率多头初成，突破前高为确认点。",
            "triggered": "突破有效，可看前高上方延伸。",
            "exiting": "相对强弱转负，叙事结束，勿逆势扛单。",
        },
    },
    "wyckoff_spring": {
        "typical_outlook": (
            "箱体震荡中 Spring 假破收回，缩量测试后再攻；"
            "经典目标约箱体上沿 + 箱宽（量度升幅）。"
            "若 spring 后无法收回箱体或出现 BC 天量，常见路径改为深度回调而非延续。"
        ),
        "cautions": [
            "hard_fail（如 BC 后 spring）禁止当做多依据。",
            "4h 慢模型，不适合当纯日内 scalp 依据。",
            "二次测试失败往往比 spring 本身更可靠地指示方向反转。",
        ],
        "stage_hints": {
            "watch": "识别箱体与潜在 spring，未收回前不进场。",
            "primed": "Spring 收回，等待测试或突破上沿。",
            "triggered": "突破箱体，量度目标可参考。",
            "exiting": "假破无法收回或 AR 回撤过大，结构破坏。",
        },
    },
    "liquidity_sweep": {
        "typical_outlook": (
            "扫 EL/EH 流动性后插针收回（SFP），短时常见反向单边，"
            "第一目标常指向区间中轴，延伸时或对侧流动性池。"
            "扫完对侧或出现中轴反向吞没时，反转叙事通常结束。"
        ),
        "cautions": [
            "强单边趋势中逆势 SFP 失败率高，需看大周期方向。",
            "15m 噪音多，观察分不等于完整 EH/EL+收回结构。",
            "小市值插针后流动性真空，止损勿过窄。",
        ],
        "stage_hints": {
            "watch": "识别等高低与潜在扫单区，未收回不交易。",
            "primed": "插针出现，等收盘收回确认。",
            "triggered": "收回确认，可沿反向看至中轴/对侧。",
            "exiting": "触及对侧流动性或趋势延续，失效。",
        },
    },
}


def enrich_catalog_entry(entry: dict[str, Any]) -> dict[str, Any]:
    pb = MODEL_PLAYBOOK.get(str(entry.get("id") or ""), {})
    out = dict(entry)
    if pb.get("typical_outlook"):
        out["typical_outlook"] = pb["typical_outlook"]
    if pb.get("cautions"):
        out["cautions"] = list(pb["cautions"])
    if pb.get("stage_hints"):
        out["stage_hints"] = dict(pb["stage_hints"])
    return out
