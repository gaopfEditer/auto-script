/**
 * TD Sequential Setup（DeMark）— 与后端 oi_mornitor/td_sequential.py 对齐。
 * 仅 Setup 计数（|值|≤9）；±9 为超买/超卖完成。
 * 图表标记只应画在已收盘 K 上（调用方传入 closedThroughIndex）。
 */

export function tdSetupSeries(closes: Array<number>): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(0);
  if (n < 5) return out;
  let buy = 0;
  let sell = 0;
  for (let i = 4; i < n; i++) {
    const c = closes[i];
    const c4 = closes[i - 4];
    if (!Number.isFinite(c) || !Number.isFinite(c4)) {
      buy = 0;
      sell = 0;
      out[i] = 0;
      continue;
    }
    if (c > c4) {
      sell = Math.min(sell + 1, 9);
      buy = 0;
      out[i] = sell;
    } else if (c < c4) {
      buy = Math.min(buy + 1, 9);
      sell = 0;
      out[i] = -buy;
    } else {
      buy = 0;
      sell = 0;
      out[i] = 0;
    }
  }
  return out;
}

export function isTd9Overbought(td: number): boolean {
  return td === 9;
}

export function isTd9Oversold(td: number): boolean {
  return td === -9;
}

export function tdLabelZh(td: number): string {
  if (td === 9) return "超买";
  if (td === -9) return "超卖";
  if (td > 0) return `TD+${td}`;
  if (td < 0) return `TD${td}`;
  return "";
}

/** 图层 / marker.kind */
export const TD9_MARKER_KINDS = new Set(["td9_overbought", "td9_oversold"]);

export const TD9_OVERBOUGHT_COLOR = "#ff6f00";
export const TD9_OVERSOLD_COLOR = "#c6ff00";
