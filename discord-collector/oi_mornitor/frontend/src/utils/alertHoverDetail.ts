import type { PatternAlert } from "../types";
import { displaySymbol } from "./symbol";

/** 与 Telegram 卡片同口径的悬停详情（时间 + 产生原因） */

function fmtPrice(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n - Math.round(n)) < 1e-9 && Math.abs(n) >= 1) return String(Math.round(n));
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s || "0";
}

function fmtVolX(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}x`;
}

function fmtTimeLabel(a: PatternAlert): string {
  const raw = Number(
    a.kline_open_time || a.time || a.kline_close_time || a.scan_ts || a.entry_time || 0,
  );
  if (!Number.isFinite(raw) || raw <= 0) return "—";
  const ms = raw > 1e12 ? raw : raw * 1000;
  return new Date(ms).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sideLabel(a: PatternAlert): string {
  const side = String(a.side || "").toLowerCase();
  if (side === "bear" || side === "short") return "看跌";
  if (side === "bull" || side === "long") return "看涨";
  const hint = String(a.side_hint || "");
  if (hint.includes("空")) return "看跌";
  if (hint.includes("多")) return "看涨";
  return "";
}

function formatCandleHover(a: PatternAlert): string {
  const pair = displaySymbol(a.symbol);
  const typeLabel = String(a.type_label || a.signal_text || a.kind || "形态卡片");
  const side = sideLabel(a);
  const typeHead = side ? `${typeLabel} (${side})` : typeLabel;
  const price = fmtPrice(a.price ?? a.close ?? a.last_price);
  const high = fmtPrice(a.high);
  const low = fmtPrice(a.low);
  const lines = [
    `交易对: ${pair}`,
    `类型: ${typeHead}`,
    `周期: ${a.interval || "—"}`,
    `时间: ${fmtTimeLabel(a)}`,
    `价格: ${price}`,
    `最高: ${high}`,
    `最低: ${low}`,
  ];
  const sideRaw = String(a.side || "").toLowerCase();
  if (sideRaw === "bear" && (a.prior_high != null || a.bb_mid != null)) {
    lines.push("--------");
    lines.push("触发原因:");
    if (a.prior_high != null) lines.push(`· 上方防守 ${fmtPrice(a.prior_high)} (前20根高点)`);
    if (a.bb_mid != null) lines.push(`· 下方参考 ${fmtPrice(a.bb_mid)} (布林中轨)`);
    if (a.near_vegas) lines.push("· 贴近 Vegas 通道");
    if (a.oi_anomaly) lines.push("· 伴随 OI 异动");
  } else if (sideRaw === "bull" && (a.prior_low != null || a.bb_mid != null)) {
    lines.push("--------");
    lines.push("触发原因:");
    if (a.prior_low != null) lines.push(`· 下方防守 ${fmtPrice(a.prior_low)} (前20根低点)`);
    if (a.bb_mid != null) lines.push(`· 上方参考 ${fmtPrice(a.bb_mid)} (布林中轨)`);
    if (a.near_vegas) lines.push("· 贴近 Vegas 通道");
    if (a.oi_anomaly) lines.push("· 伴随 OI 异动");
  } else {
    lines.push("--------");
    lines.push(`触发原因: ${typeLabel}${a.oi_anomaly ? " · OI异动" : ""}`);
  }
  return lines.join("\n");
}

function formatStructureTopHover(a: PatternAlert): string {
  const pair = displaySymbol(a.symbol);
  const pattern = String(a.pattern_label || a.type_label || "顶部结构");
  return [
    `信号: 顶部结构确认 (看跌)`,
    `交易对: ${pair}`,
    `周期: ${a.interval || "—"}`,
    `时间: ${fmtTimeLabel(a)}`,
    `形态: ${pattern}`,
    `现价: ${fmtPrice(a.price ?? a.close)}`,
    `--------`,
    `触发原因:`,
    `· 头部最高: ${fmtPrice(a.head_high)} (右肩承压回落)`,
    `· 均线破位: 实体跌破 Vegas 中轨 @ ${fmtPrice(a.vegas_mid)}`,
    `· 量能确认: 破位K线放量 ${fmtVolX(a.vol_ratio)} MA20`,
    `--------`,
    `关键防守: ${fmtPrice(a.defense ?? a.right_shoulder)}`,
    `下方支撑: ${fmtPrice(a.support_ref ?? a.neckline)}`,
  ].join("\n");
}

function formatStructureBottomHover(a: PatternAlert): string {
  const pair = displaySymbol(a.symbol);
  const pattern = String(a.pattern_label || a.type_label || "底部确认");
  const title = String(a.type_label || "底部二次探底确认");
  let pctS = "—";
  if (a.close_pct != null && Number.isFinite(Number(a.close_pct))) {
    pctS = `${(Number(a.close_pct) * 100).toFixed(0)}%`;
  }
  return [
    `信号: ${title} (看涨)`,
    `交易对: ${pair}`,
    `周期: ${a.interval || "—"}`,
    `时间: ${fmtTimeLabel(a)}`,
    `形态: ${pattern}`,
    `现价: ${fmtPrice(a.price ?? a.close)}`,
    `--------`,
    `触发原因:`,
    `· 前期低点 L1: ${fmtPrice(a.l1)} (伴随 ${fmtVolX(a.climax_vol_ratio ?? a.vol_ratio)} 恐慌放量)`,
    `· 二次回踩 L2: ${fmtPrice(a.l2)} (未破前低/假跌破收回)`,
    `· 确认信号: 大实体阳线支撑收盘 (收在前 ${pctS} 高位)`,
    `--------`,
    `关键防守: ${fmtPrice(a.defense ?? a.l1)}`,
    `上方阻力: ${fmtPrice(a.resistance_ref)} (Vegas)`,
  ].join("\n");
}

function formatTriggerHover(a: PatternAlert): string {
  const pair = displaySymbol(a.symbol);
  return [
    `信号: 形态多头爆发 (看涨)`,
    `交易对: ${pair}`,
    `周期: ${a.interval || "15m"}`,
    `时间: ${fmtTimeLabel(a)}`,
    `--------`,
    `触发原因:`,
    `· LH/次高点确认后出现更高低点 HL`,
    `· 收盘突破扳机线并放量 + MACD 放大`,
    a.lh_price != null ? `· LH: ${fmtPrice(a.lh_price)}` : "",
    a.hl != null ? `· HL: ${fmtPrice(a.hl)}` : "",
    a.trigger_price != null ? `· 扳机线: ${fmtPrice(a.trigger_price)}` : "",
    a.message ? `· ${a.message}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatGenericHover(a: PatternAlert): string {
  const pair = displaySymbol(a.symbol);
  const typeLabel = String(
    a.type_label || a.pattern_label || a.signal_text || a.status_label || a.kind || "信号",
  );
  const side = sideLabel(a);
  const lines = [
    `信号: ${typeLabel}${side ? ` (${side})` : ""}`,
    `交易对: ${pair}`,
    `周期: ${a.interval || "—"}`,
    `时间: ${fmtTimeLabel(a)}`,
  ];
  if (a.price != null || a.close != null || a.last_price != null) {
    lines.push(`现价: ${fmtPrice(a.price ?? a.close ?? a.last_price)}`);
  }
  lines.push("--------");
  lines.push("触发原因:");
  if (a.logic) {
    const map: Record<string, string> = { S: "短线猎手 S", T: "长线维加斯 T", C: "卡片跟单 C" };
    lines.push(`· 策略: ${map[String(a.logic).toUpperCase()] || a.logic}`);
  }
  if (a.kind || a.signal_kind) lines.push(`· 形态: ${a.signal_kind || a.kind}`);
  if (a.side_hint) lines.push(`· 方向提示: ${a.side_hint}`);
  if (a.message) lines.push(`· ${a.message}`);
  if (a.signal_text && a.signal_text !== a.message) lines.push(`· ${a.signal_text}`);
  return lines.join("\n");
}

/** 对齐 Telegram 推送详情的悬停文案 */
export function formatAlertHoverDetail(a: PatternAlert): string {
  const type = String(a.type || "");
  const kind = String(a.kind || a.signal_kind || "");
  const side = String(a.side || "").toLowerCase();

  if (type === "candle_pattern_card" || kind === "shooting_star" || kind === "inverted_hammer") {
    return formatCandleHover(a);
  }
  if (type === "structure_pattern_card") {
    if (side === "bull" || kind === "spring_2b" || kind === "bottom_secondary_test") {
      return formatStructureBottomHover(a);
    }
    return formatStructureTopHover(a);
  }
  if (type === "trigger" || a.status === "TRIGGER" || a.status === "TRIGGER_SIGNAL") {
    return formatTriggerHover(a);
  }
  if (type === "candle_pattern_oi") {
    return [
      `信号: 形态+OI异动 · 推荐${a.side_hint || "短线"}`,
      `交易对: ${displaySymbol(a.symbol)}`,
      `周期: ${a.interval || "—"}`,
      `时间: ${fmtTimeLabel(a)}`,
      `现价: ${fmtPrice(a.last_price ?? a.price)}`,
      `--------`,
      `触发原因:`,
      `· ${a.signal_text || a.message || kind || "形态+OI"}`,
    ].join("\n");
  }
  return formatGenericHover(a);
}

export function alertSignalTimeLabel(a: PatternAlert): string {
  return fmtTimeLabel(a);
}
