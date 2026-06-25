/**
 * 调用本地 8000 /ollama/chat 解析 YouTube 文字稿。
 *
 * curl 示例：
 *   curl -sS -X POST 'http://127.0.0.1:8000/ollama/chat' \
 *     -H 'Content-Type: application/json' \
 *     -d '{"prompt":"...","model":"gemma4:26b"}'
 */

const DEFAULT_PROMPT = `你是加密货币/交易类 YouTube 视频文稿分析器。根据下面文字稿输出**合法 JSON 对象**（不要 markdown 代码块），字段：
{
  "summary": ["核心观点，每条一句，最多 5 条"],
  "symbol": "币种如 BTC/ETH，无则空字符串",
  "direction": "做多/做空/观望，无则空字符串",
  "entry": "入场价或区间，无则空字符串",
  "stopLoss": "止损，无则空字符串",
  "targets": ["止盈1", "止盈2"],
  "keyLevels": ["关键价位或支撑阻力"],
  "titleHint": "一句话标题"
}
不要编造文稿没有的价位。

【视频标题】{{title}}
【文字稿】
{{transcript}}`;

/** @param {string} raw */
export function extractJsonObject(raw) {
  const text = String(raw ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} body
 */
function pickResponseText(body) {
  if (body == null) return "";
  if (typeof body === "string") return body.trim();
  if (typeof body !== "object") return String(body);
  const o = /** @type {Record<string, unknown>} */ (body);
  for (const key of ["response", "text", "content", "message", "output"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return JSON.stringify(body);
}

/**
 * @param {string} template
 * @param {{ title?: string, transcript: string, maxChars?: number }} ctx
 */
export function buildAnalyzePrompt(template, ctx) {
  const max = ctx.maxChars ?? 14_000;
  const transcript = String(ctx.transcript ?? "").trim().slice(0, max);
  const title = String(ctx.title ?? "").trim() || "（未知）";
  return String(template || DEFAULT_PROMPT)
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{transcript\}\}/g, transcript);
}

/**
 * @param {{
 *   transcript: string,
 *   title?: string,
 *   chatUrl: string,
 *   model: string,
 *   promptTemplate?: string,
 *   timeoutMs?: number,
 *   log?: ReturnType<typeof import('./logger.js').createLogger>,
 * }} opts
 */
export async function analyzeTranscriptWithOllama(opts) {
  const { transcript, title, chatUrl, model, promptTemplate, timeoutMs = 120_000, log } = opts;
  const prompt = buildAnalyzePrompt(promptTemplate ?? DEFAULT_PROMPT, { title, transcript });
  if (!prompt.trim()) throw new Error("分析 prompt 为空");
  if (!chatUrl) throw new Error("未配置 OLLAMA_CHAT_URL");

  log?.info(`Ollama 分析 model=${model} prompt_len=${prompt.length}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model }),
      signal: controller.signal,
    });
    const rawText = await r.text();
    if (!r.ok) {
      throw new Error(`ollama/chat HTTP ${r.status}: ${rawText.slice(0, 300)}`);
    }
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = null;
    }
    const responseText = pickResponseText(parsedBody ?? rawText);
    const parsed = extractJsonObject(responseText);
    return {
      provider: "ollama",
      model,
      analyzedAt: new Date().toISOString(),
      raw: responseText,
      parsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

export { DEFAULT_PROMPT };
