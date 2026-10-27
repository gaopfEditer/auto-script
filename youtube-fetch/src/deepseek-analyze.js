/**
 * DeepSeek Chat API 解析 YouTube 文字稿（Ollama 不可用时的回退）。
 */
import { buildAnalyzePrompt, DEFAULT_PROMPT, extractJsonObject } from "./ollama-analyze.js";

/**
 * @param {unknown} err
 */
export function isLocalModelUnavailable(err) {
  const e = /** @type {Error} */ (err);
  const msg = String(e?.message ?? err).toLowerCase();
  const cause = e?.cause;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String(/** @type {{ code?: string }} */ (cause).code).toLowerCase()
      : "";
  if (
    ["econnrefused", "enotfound", "econnreset", "etimedout", "und_err_connect_timeout"].includes(
      code
    )
  ) {
    return true;
  }
  if (e?.name === "AbortError") return true;
  if (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up")
  ) {
    return true;
  }
  if (/ollama\/chat http 50[234]/.test(msg)) return true;
  return false;
}

/**
 * @param {{
 *   transcript: string,
 *   title?: string,
 *   apiKey: string,
 *   model: string,
 *   apiUrl?: string,
 *   promptTemplate?: string,
 *   maxChars?: number,
 *   timeoutMs?: number,
 *   log?: ReturnType<typeof import('./logger.js').createLogger>,
 * }} opts
 */
export async function analyzeTranscriptWithDeepSeek(opts) {
  const {
    transcript,
    title,
    apiKey,
    model,
    apiUrl = "https://api.deepseek.com",
    promptTemplate,
    maxChars,
    timeoutMs = 120_000,
    log,
  } = opts;
  const prompt = buildAnalyzePrompt(promptTemplate ?? DEFAULT_PROMPT, {
    title,
    transcript,
    maxChars,
  });
  if (!prompt.trim()) throw new Error("分析 prompt 为空");
  if (!apiKey) throw new Error("未配置 DEEPSEEK_API_KEY");

  const base = apiUrl.replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  log?.info(`DeepSeek 分析 model=${model} prompt_len=${prompt.length}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    const rawText = await r.text();
    if (!r.ok) {
      throw new Error(`deepseek HTTP ${r.status}: ${rawText.slice(0, 300)}`);
    }
    let body = null;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = null;
    }
    const responseText =
      body &&
      typeof body === "object" &&
      Array.isArray(/** @type {{ choices?: unknown[] }} */ (body).choices)
        ? String(
            /** @type {{ message?: { content?: string } }} */ (
              /** @type {{ choices: unknown[] }} */ (body).choices[0]
            ).message?.content ?? ""
          ).trim()
        : rawText.trim();
    const parsed = extractJsonObject(responseText);
    return {
      provider: "deepseek",
      model,
      analyzedAt: new Date().toISOString(),
      raw: responseText,
      parsed,
    };
  } finally {
    clearTimeout(timer);
  }
}
