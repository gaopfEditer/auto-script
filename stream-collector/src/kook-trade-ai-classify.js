/**
 * 调用 Ollama /api/generate 判断 Kook 消息是否为「完整做单」。
 */
import {
  normalizeTradeSignalText,
  mightBeTradeSignalRough,
} from "../collector-ui-vue/src/lib/kookTradeSignalDetect.js";

export { mightBeTradeSignalRough };
import { config } from "./config.js";

/** 实时 WS / 前端推送来源（非历史 REST 批量） */
export const KOOK_TRADE_SOCKET_SOURCES = new Set([
  "ws_desktop",
  "frontend",
  "frontend_notify",
]);

const EXAMPLE_COMPLETE_1 = `ETH 做空（25连胜） 仓位思路强平控制3000及以上
2178市价直接空 100倍 2%保证金
再挂2263（逃命点位只给一次机会逃）100倍 3%保证金
第一芷楹2018（或者靠嘴喊芷楹） 芷楹70% 移动保本损
第二芷楹1788
第三芷楹1388
芷損2300。#ETH`;

const EXAMPLE_COMPLETE_2 = `比特币方向：短空
入场：8.03万附近 信心度：中 倍数：10倍 仓位：5%
芷損：8.15万
第一芷楹7.95万 第二芷楹7.88万
#BTC`;

const EXAMPLE_ADJUST = `合约单子：Sol芷楹修改在93.5，芷楹一半止盈；btc止损上移至80300`;

const EXAMPLE_CHAT = `今天行情不错，晚上再聊`;

const SYSTEM_RULES = `你是加密货币合约「做单信号」分类器。判断 Kook 群消息是否应推送给跟单者。

**需要推送（isSign=true）的两类：**

1. **完整做单** kind=full：须同时有**入场**（市价/挂单/保证金/倍数/仓位/直接空多等）与**出场风控**（芷損/止损/止盈/芷楹/保本/逃命等）。

2. **持仓调整** kind=adjust：无新开仓入场，但明确修改**止盈/止损/芷楹/保本/移动止损/减仓**等。跟单者需知晓以免跟不上，也必须推送。

**不推送（isSign=false, kind=ignore）：**
- 纯行情闲聊、直播预告、复盘晒单、广告、表情包；
- 只有模糊方向、无任何具体价位或改动；
- 与交易无关的群内对话。

只输出**一行**合法 JSON，不要 markdown、不要解释。字段：
- isSign (boolean): 是否推送
- kind (string): "full" | "adjust" | "ignore"
- content (string): **将直接作为 Telegram 正文**，须**一条极简中文**（adjust ≤35字，full ≤50字），写清标的+关键改动，勿复述全文
- star (number): full 用 4-5，adjust 用 2-3，ignore 用 0

示例：{"isSign":true,"kind":"full","content":"ETH做空 2178空 芷損2300 芷楹2018/1788/1388","star":5}
示例：{"isSign":true,"kind":"adjust","content":"SOL芷楹调至93.5，止盈减半","star":3}`;

/**
 * @param {string} messageText
 */
export function buildTradeClassifyPrompt(messageText) {
  const msg = normalizeTradeSignalText(messageText);
  return `${SYSTEM_RULES}

【正例1 完整做单 → isSign true】
${EXAMPLE_COMPLETE_1}

【正例2 完整做单 → isSign true】
${EXAMPLE_COMPLETE_2}

【正例3 持仓调整（仅改止盈止损/芷楹）→ isSign true, kind adjust】
${EXAMPLE_ADJUST}

【反例 闲聊 → isSign false】
${EXAMPLE_CHAT}

【待判断消息】
${msg}

只输出一个 JSON：`;
}

/**
 * @param {string} raw
 * @returns {{ isSign: boolean, kind: "full" | "adjust" | "ignore", content: string, star: number } | null}
 */
export function parseTradeClassifyJson(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;

  let slice = t;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) slice = fence[1].trim();
  const brace = slice.match(/\{[\s\S]*\}/);
  if (brace) slice = brace[0];

  try {
    const o = JSON.parse(slice);
    const isSign = o.isSign === true || o.isSign === "true" || o.isSign === 1;
    const content = String(o.content ?? "").trim();
    const star = Number(o.star);
    const kindRaw = String(o.kind ?? "").trim().toLowerCase();
    /** @type {"full" | "adjust" | "ignore"} */
    let kind = "ignore";
    if (kindRaw === "full" || kindRaw === "adjust") kind = kindRaw;
    else if (isSign) kind = star > 0 && star <= 3 ? "adjust" : "full";
    return {
      isSign,
      kind,
      content: content || (isSign ? (kind === "adjust" ? "持仓调整" : "完整做单") : "非做单"),
      star: Number.isFinite(star) ? star : isSign ? (kind === "adjust" ? 3 : 4) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} messageText
 * @param {{ debug?: (s: string) => void }} [opts]
 * @returns {Promise<{ isSign: boolean, kind: "full" | "adjust" | "ignore", content: string, star: number, via: "ai" | "fallback" } | null>}
 */
export async function classifyCompleteTradeByAi(messageText, opts = {}) {
  if (!config.ollamaTradeClassifyEnabled) return null;

  const prompt = buildTradeClassifyPrompt(messageText);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ollamaGenerateTimeoutMs);

  try {
    const r = await fetch(config.ollamaGenerateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        prompt,
        stream: false,
      }),
      signal: controller.signal,
    });
    const body = /** @type {{ response?: string, error?: string }} */ (
      await r.json().catch(() => ({}))
    );
    if (!r.ok) {
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    const parsed = parseTradeClassifyJson(body.response ?? "");
    if (!parsed) {
      opts.debug?.(`Ollama JSON 解析失败: ${String(body.response ?? "").slice(0, 120)}`);
      return null;
    }
    return { ...parsed, via: "ai" };
  } finally {
    clearTimeout(timer);
  }
}
