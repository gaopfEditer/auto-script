/**
 * Ollama：将结构化信号格式化为各语言风格卡片正文；规则解析失败时用 AI 提取字段。
 */
import { config } from "./config.js";
import { SIGNAL_STYLE_META } from "./discord-signal-config.js";
import { formatCardFallback } from "./discord-signal-parsers.js";

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

/** @param {string} raw @returns {Record<string, unknown> | null} */
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
 * @param {string} parserKind
 * @param {string} channelName
 * @param {{ debug?: (s: string) => void }} [opts]
 */
export async function extractSignalWithAi(rawContent, parserKind, channelName, opts = {}) {
  if (!config.ollamaEnabled) return null;
  const prompt = `你是加密货币 Discord 发单消息解析器。频道「${channelName}」的发单风格为 ${parserKind}。

从下面原文提取交易信号，只输出一个 JSON 对象（不要 markdown）：
{
  "parser": "${parserKind}",
  "symbol": "币种如 BTC/BNB/OPG",
  "direction": "做多或做空",
  "entry": "入场价或区间",
  "takeProfits": ["止盈1", "止盈2"],
  "stopLoss": "止损价",
  "leverage": "杠杆可选",
  "position": "仓位可选",
  "note": "备注可选",
  "title": "简短标题"
}
不要编造原文没有的价位；无法识别则返回 {"skip": true}

【原文】
${String(rawContent ?? "").slice(0, 2500)}`;

  try {
    const resp = await callOllama(prompt);
    const obj = parseAiJson(resp);
    if (!obj || obj.skip) return null;
    obj.parser = obj.parser || parserKind;
    if (!obj.symbol && !obj.direction) return null;
    return obj;
  } catch (e) {
    opts.debug?.(`Ollama 提取失败: ${/** @type {Error} */ (e).message}`);
    return null;
  }
}

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
