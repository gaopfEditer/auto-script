/**
 * 形态信号入场条件明细（与 structure_signals / candle_signals / pattern_detector 对齐）。
 * 胜率弹窗「入场规则」与 SIGNAL_LOGIC.md §5.5 同源摘要。
 */

export type PatternEntryRule = {
  /** 列表里的 typeLabel / 简称 */
  label: string;
  /** 方向 */
  side: "多" | "空" | "—";
  /** 一句话 */
  summary: string;
  /** 达成条件条目 */
  conditions: string[];
  /** 代码 kind / 实现位置 */
  impl?: string;
};

export const PATTERN_ENTRY_RULES: PatternEntryRule[] = [
  {
    label: "底部二次探底确认",
    side: "多",
    summary: "恐慌抛售插针后，二次回踩同一低点并用阳线确认支撑（Double Bottom）。",
    impl: "structure_signals._detect_bottom_reversal",
    conditions: [
      "① 恐慌柱（L1）：成交量 ≥ 2.0×MA20，且（下影 > 振幅×0.4 或 大阴实体 > 振幅×0.5）",
      "② 其后 3～25 根内出现二次低点 L2，满足 L1×0.98 ≤ L2 ≤ L1×1.03（贴近前低）",
      "③ 确认柱须为：收盘位置 ≥ 振幅 70% 的阳线，或阳包阴（吞没前阴）",
      "④ 入场价取确认柱收盘；防守参考 min(L1,L2)",
    ],
  },
  {
    label: "顶部结构确认",
    side: "空",
    summary: "头肩/M顶破 Vegas、流动性掠夺或圆弧动量衰竭（同标签多种子形态）。",
    impl: "structure_signals hs/m_top/sweep/curvature",
    conditions: [
      "头肩顶：左肩≈右肩（容差 3%），中间头更高；右肩后 15 根内实体跌破 Vegas 中轨（或破颈线且收在中轨下），量 ≥ 1.3×MA20",
      "M顶：两峰近似等高（容差 3%）、中间明显回落；之后实体跌破 Vegas 中轨，量 ≥ 1.3×MA20",
      "流动性掠夺：上影刺破前高后收阴且收在前高下，上影≥振幅 25%；需 OI 异动或量≥1.3×MA20",
      "圆弧顶：近 20 根相对斜率由上涨（>0.05%/根）转为走平/下行，且近高未创新高；收阴且收在 Vegas 中轨下",
    ],
  },
  {
    label: "射击之星",
    side: "空",
    summary: "上影长、实体小的看跌蜡烛；需在上轨区/Vegas 附近，且前有上涨趋势。",
    impl: "candle_signals + indicators.detect_shooting_star",
    conditions: [
      "① 形态：上影 ∈ [1.5×实体, max]；下影很短或下影×2 < 上影；近下轨时必须收阴",
      "② 位置：收盘 ≥ BB 中轨 + 0.85×带宽，或贴近 Vegas A/B 通道",
      "③ 趋势：信号前 20 根累计涨幅 ≥ 3%",
      "④ 入场价=信号柱收盘；上方防守≈前20高，下方参考=BB中轨",
    ],
  },
  {
    label: "连续走平射击之星",
    side: "空",
    summary: "短窗内再次出现射击之星（「射击之星（2）」），强化顶部钝化。",
    impl: "candle_signals consecutive shoot",
    conditions: [
      "① 满足单次射击之星全部条件",
      "② 在配置的重复窗口内再次检出射击之星外形",
      "③ 同样受位置过滤与上涨趋势背景约束",
    ],
  },
  {
    label: "倒锤子",
    side: "多",
    summary: "下影长的看涨蜡烛；仅柱级 OI 异动时推送，且前有下跌。",
    impl: "candle_signals inverted_hammer + oi_anomaly",
    conditions: [
      "① 形态：下影 ≥ 1.5×实体，上影 < 下影/3；须在布林中轨之下",
      "② 推送门控：当根须带柱级 OI 异动标记",
      "③ 趋势：信号前 20 根累计跌幅 ≥ 3%",
      "④ 入场价=信号柱收盘；下方防守≈前20低，上方参考=BB中轨",
    ],
  },
  {
    label: "形态多头爆发",
    side: "多",
    summary: "LH→HL 后带量突破夹角扳机线（经典拐点状态机）。",
    impl: "pattern_detector Stage2 TRIGGER",
    conditions: [
      "① 阶段1：两 pivot high 形成 LH < H_max（可加 BB 上插针或 MACD 走弱滤波）",
      "② 阶段2：LH 后出现 HL > L₁（更高低点）",
      "③ 扳机线 = L₁～HL 区间最高价",
      "④ 收盘突破扳机线，量 ≥ 1.5×SMA20，且 MACD 金叉放大",
      "⑤ 触发后同币 trigger_emitted，不再重复扫",
    ],
  },
];

/** 按 typeLabel 模糊匹配规则（列表文案可能带周期后缀） */
export function matchEntryRule(typeLabel: string): PatternEntryRule | undefined {
  const raw = String(typeLabel || "").trim();
  if (!raw) return undefined;
  const exact = PATTERN_ENTRY_RULES.find((r) => r.label === raw);
  if (exact) return exact;
  return PATTERN_ENTRY_RULES.find(
    (r) => raw.includes(r.label) || r.label.includes(raw.split(/[·•|｜]/)[0]!.trim()),
  );
}
