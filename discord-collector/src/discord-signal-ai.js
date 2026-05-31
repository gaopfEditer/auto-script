/**
 * Ollama：将结构化信号格式化为各语言风格卡片正文。
 */
import { config } from "./config.js";
import { SIGNAL_STYLE_META } from "./discord-signal-config.js";
import { formatCardFallback } from "./discord-signal-parsers.js";

/**
 * @param {Record<string, unknown>} parsed
 * @param {string} styleId
 * @param {string} rawContent
 */
function buildCardPrompt(parsed, styleId, rawContent) {
  const meta = SIGNAL_STYLE_META[styleId] ?? { label: styleId, promptHint: styleId };
  return `你是加密货币交易信号卡片编辑。根据「原文」与「结构化字段」，输出 ${meta.promptHint} 的卡片正文。

要求：
- 只输出卡片正文，不要 JSON、不要 markdown 代码块
- 保留关键数字（入场、止盈、止损、杠杆、仓位）
- 分行清晰，适合手机阅读
- 不要编造原文没有的价位

【风格】${meta.label}（${styleId}）

【结构化】
${JSON.stringify(parsed, null, 2)}

【原文】
${String(rawContent ?? "").slice(0, 2000)}

卡片正文：`;
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {string[]} styleIds
 * @param {string} rawContent
 * @param {{ debug?: (s: string) => void }} [opts]
 * @returns {Promise<Record<string, string>>}
 */
export async function generateCardsByStyles(parsed, styleIds, rawContent, opts = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  const styles = styleIds.length ? styleIds : ["cn_brief"];

  if (!config.ollamaEnabled) {
    for (const sid of styles) {
      out[sid] = formatCardFallback(parsed, sid);
    }
    return out;
  }

  for (const sid of styles) {
    const prompt = buildCardPrompt(parsed, sid, rawContent);
    try {
      const text = await callOllama(prompt);
      out[sid] = text.trim() || formatCardFallback(parsed, sid);
    } catch (e) {
      opts.debug?.(`Ollama 卡片 ${sid} 失败: ${/** @type {Error} */ (e).message}`);
      out[sid] = formatCardFallback(parsed, sid);
    }
  }
  return out;
}

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
