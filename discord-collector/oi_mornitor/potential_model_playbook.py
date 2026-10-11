"""潜力五模型 · 常见走势与注意事项（形态页悬浮说明）。"""
from __future__ import annotations

from typing import Any

MODEL_PLAYBOOK: dict[str, dict[str, Any]] = {
    "quiet_oi_breakout": {
        "typical_outlook": (
            "OI 长期在低位横盘后缓慢抬升，波动率收敛；常见路径是首根放量突破区间上沿，"
            "1～3 根 K 延续或回踩 MA20/区间上沿再攻。目标常先看区间高度的一倍附近，"
            "若量能持续可延伸；若仅脉冲无量，多在一周内回到箱体内。"
        ),
        "cautions": [
            "小市值易被控盘假突破，需对照现货深度与 BTC 大环境。",
            "观察池（未 strict hit）只代表部分条件，不等于完整「沉寂→建仓」确认。",
            "量价背离或 OI 日降时，突破成功率明显下降。",
        ],
        "stage_hints": {
            "watch": "OI 开始抬升但价仍在箱内，宜列入观察、等放量突破。",
            "primed": "波动收敛+量温和放大，突破在即但假突破风险仍高。",
            "triggered": "已突破区间，优先看回踩上沿能否守住再加。",
            "exiting": "脉冲后回撤过半或 OI 回落，叙事减弱，勿当新起点追。",
        },
    },
    "short_squeeze": {
        "typical_outlook": (
            "负费率叠加 OI 增、价格抗跌时，常见短线急拉或阶梯抬升；"
            "费率向 0 回归后波动加大，历史上常见回撤前段涨幅的 30%～50%。"
            "二波需 OI 再次堆积且费率仍偏负，否则多为反弹结束。"
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
