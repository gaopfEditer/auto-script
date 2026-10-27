/**
 * Twitter 短贴 → 结构化信号（Ollama）。格式不标准时做宽松解析。
 */
import { config } from "./config.js";

/** @param {string} prompt */
async function callOllama(prompt) {
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
    const body = /** @type {{ response?: string, error?: string }} */ (await r.json().catch(() => ({})));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return String(body.response ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} raw */
function parseAiJson(raw) {
  const text = String(raw ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    return obj && typeof obj === "object" ? /** @type {Record<string, unknown>} */ (obj) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} rawContent
 * @param {{ handle?: string, displayName?: string, tweetUrl?: string }} [ctx]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function extractTwitterSignalWithAi(rawContent, ctx = {}) {
  if (!config.ollamaEnabled) return null;
  const who = ctx.displayName || ctx.handle || "unknown";
  const prompt = `你是加密货币 Twitter/X 短贴解析器。发帖人「${who}」文案往往口语化、不标准。

从下面推文提取交易相关信息，只输出一个 JSON（不要 markdown）：
{
  "kind": "signal|opinion|news|other",
  "symbol": "币种如 BTC/ETH，没有则空字符串",
  "direction": "做多|做空|中性|空字符串",
  "entry": "入场价或区间，没有则空",
  "takeProfits": ["止盈价，可空数组"],
  "stopLoss": "止损，没有则空",
  "summary": "一句话中文摘要（必填）",
  "confidence": 0.0到1.0,
  "note": "补充说明可选"
}
不要编造原文没有的价位；若只是情绪/转发且无交易要素，kind 用 opinion 或 other。

【推文】
${String(rawContent ?? "").slice(0, 2000)}
${ctx.tweetUrl ? `\n链接: ${ctx.tweetUrl}` : ""}`;

  try {
    const resp = await callOllama(prompt);
    const obj = parseAiJson(resp);
    if (!obj) return null;
    return {
      kind: String(obj.kind ?? "other"),
      symbol: String(obj.symbol ?? "").trim(),
      direction: String(obj.direction ?? "").trim(),
      entry: String(obj.entry ?? "").trim(),
      takeProfits: Array.isArray(obj.takeProfits)
        ? obj.takeProfits.map((x) => String(x)).filter(Boolean)
        : [],
      stopLoss: String(obj.stopLoss ?? "").trim(),
      summary: String(obj.summary ?? "").trim(),
      confidence: Number(obj.confidence),
      note: String(obj.note ?? "").trim(),
      analyzedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
