/**
 * 粘贴文稿 → Ollama 解析 → 多币种操作 JSON 预览（不入库、不走信号卡片系统）。
 */
import { analyzeTranscriptWithDeepSeek, isLocalModelUnavailable } from "../../youtube-fetch/src/deepseek-analyze.js";
import { analyzeTranscriptWithOllama } from "../../youtube-fetch/src/ollama-analyze.js";
import { config as ytFetchConfig } from "../../youtube-fetch/src/config.js";
import { buildDiscordCardFields, normalizeSymbol } from "./card-fields.js";

export const PASTE_PARSE_PROMPT = `你是加密货币/交易类文稿分析器。根据下面文稿，提取**文中提到的每一个币种**及其操作信息。

输出**合法 JSON 对象**（不要 markdown 代码块），结构如下：
{
  "summary": ["全文核心观点，每条一句，最多 5 条"],
  "titleHint": "一句话标题",
  "coinActions": [
    {
      "symbol": "BTC",
      "actionType": "new",
      "direction": "做多/做空/观望，无则空字符串",
      "entry": "入场价或区间，如 61800-62000",
      "stopLoss": "止损价，无则空字符串",
      "targets": ["止盈1", "止盈2"],
      "pnl": "涨跌幅或盈亏描述，如 +5%、小赚、小亏，无则空字符串",
      "description": "简短描述，便于在原文中定位该操作（20字内）"
    }
  ]
}

**actionType 判定规则（必填，只能四选一）：**
- **new**：首次给出该币种的操作计划，含入场区间/价位、止损、目标位等（新开仓/新信号）
- **continue**：该币种持仓中的更新——涨了多少、跌了多少、小赚、小亏、浮盈浮亏、持有观望、加仓减仓但未结束
- **toend**：接近目标位/止盈位、提醒准备止盈、即将到达某价位
- **end**：已止盈、已止损、平仓、该币种操作结束

**要求：**
1. 文中提到的每个币种都要在 coinActions 里出现，可有多条（同一币种不同时间点）
2. 按文稿出现顺序排列
3. 不要编造文稿没有的价位；没有的信息用空字符串或空数组
4. description 要写清楚「在说什么」，方便人工回原文查找

【标题】{{title}}
【正文】
{{transcript}}`;

/** @param {string} raw */
export function splitPasteText(raw) {
  const text = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!text) return { title: "", content: "" };
  const idx = text.indexOf("\n");
  if (idx < 0) return { title: text, content: "" };
  return {
    title: text.slice(0, idx).trim(),
    content: text.slice(idx + 1).trim(),
  };
}

/** @param {unknown} v */
function asStringList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

/** @param {unknown} raw */
export function normalizeActionType(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return "continue";
  if (s === "new" || s === "open" || s === "entry" || s === "开仓" || s === "新建") return "new";
  if (s === "continue" || s === "hold" || s === "update" || s === "持有" || s === "更新" || s === "ongoing")
    return "continue";
  if (s === "toend" || s === "near" || s === "near_target" || s === "临近" || s === "接近") return "toend";
  if (s === "end" || s === "close" || s === "exit" || s === "done" || s === "结束" || s === "平仓" || s === "止盈")
    return "end";
  return "continue";
}

/** @typedef {{
 *   symbol: string,
 *   actionType: 'new' | 'continue' | 'toend' | 'end',
 *   direction: string,
 *   entry: string,
 *   stopLoss: string,
 *   targets: string[],
 *   pnl: string,
 *   description: string,
 * }} CoinAction */

/** @param {unknown} parsed */
export function normalizeCoinActions(parsed) {
  const list = parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed).coinActions : null;
  if (!Array.isArray(list)) {
    const legacy = parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed) : null;
    const sym = String(legacy?.symbol ?? "").trim();
    if (!sym) return [];
    return [
      {
        symbol: sym.replace(/USDT$/i, ""),
        actionType: "new",
        direction: String(legacy?.direction ?? ""),
        entry: String(legacy?.entry ?? ""),
        stopLoss: String(legacy?.stopLoss ?? ""),
        targets: asStringList(legacy?.targets),
        pnl: "",
        description: String(legacy?.titleHint ?? "主信号"),
      },
    ];
  }

  /** @type {CoinAction[]} */
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const symbol = normalizeSymbol(row.symbol ?? row.asset ?? "")
      .replace(/USDT$/i, "")
      .replace(/^\$/, "");
    if (!symbol) continue;
    out.push({
      symbol,
      actionType: normalizeActionType(row.actionType ?? row.action ?? row.type),
      direction: String(row.direction ?? ""),
      entry: String(row.entry ?? row.entryRange ?? row.entryPrice ?? ""),
      stopLoss: String(row.stopLoss ?? row.sl ?? ""),
      targets: asStringList(row.targets ?? row.takeProfit),
      pnl: String(row.pnl ?? row.change ?? row.profit ?? ""),
      description: String(row.description ?? row.note ?? row.summary ?? "").trim(),
    });
  }
  return out;
}

/**
 * @param {string} title
 * @param {string} content
 * @param {Record<string, unknown> | null} parsed
 * @param {CoinAction[]} coinActions
 * @param {Record<string, unknown>} analysisMeta
 */
export function buildPastePreviewCard(title, content, parsed, coinActions, analysisMeta) {
  const summary = asStringList(parsed?.summary);
  const primaryNew = coinActions.find((c) => c.actionType === "new") ?? coinActions[0] ?? null;

  const cardFields = buildDiscordCardFields({
    title: String(parsed?.titleHint ?? "").trim() || title,
    symbol: primaryNew?.symbol ?? parsed?.symbol,
    direction: primaryNew?.direction ?? parsed?.direction,
    entry: primaryNew?.entry ?? parsed?.entry,
    targets: primaryNew?.targets?.length ? primaryNew.targets : asStringList(parsed?.targets),
    stopLoss: primaryNew?.stopLoss ?? parsed?.stopLoss,
    description: summary.length ? summary.map((s) => `• ${s}`).join("\n") : content.slice(0, 800),
    sourceType: "paste",
    note: `预览 · ${coinActions.length} 个币种操作 · 未入库`,
  });

  return {
    previewOnly: true,
    kind: "text_paste_preview",
    title,
    content,
    symbol: primaryNew?.symbol ?? "",
    direction: primaryNew?.direction ?? "",
    coinActions,
    coinActionCount: coinActions.length,
    cardFields,
    parsed: parsed ?? null,
    keyLevels: asStringList(parsed?.keyLevels),
    summary,
    analysis: analysisMeta,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * @param {string} title
 * @param {string} content
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
async function analyzePasteContent(title, content, log) {
  const base = {
    transcript: content,
    title,
    chatUrl: ytFetchConfig.ollamaChatUrl,
    model: ytFetchConfig.ollamaModel,
    promptTemplate: PASTE_PARSE_PROMPT,
    timeoutMs: ytFetchConfig.analyzeTimeoutMs,
    log,
  };

  try {
    return await analyzeTranscriptWithOllama(base);
  } catch (e) {
    const ollamaErr = /** @type {Error} */ (e);
    const canFallback = Boolean(ytFetchConfig.deepseekApiKey) && isLocalModelUnavailable(ollamaErr);
    if (!canFallback) throw ollamaErr;
    log.warn(`粘贴解析：Ollama 不可用，改用 DeepSeek: ${ollamaErr.message}`);
    return analyzeTranscriptWithDeepSeek({
      transcript: content,
      title,
      apiKey: ytFetchConfig.deepseekApiKey,
      model: ytFetchConfig.deepseekModel ?? "deepseek-chat",
      apiUrl: ytFetchConfig.deepseekApiUrl,
      promptTemplate: PASTE_PARSE_PROMPT,
      maxChars: ytFetchConfig.analyzeMaxTranscriptChars,
      timeoutMs: ytFetchConfig.analyzeTimeoutMs,
      log,
    });
  }
}

/**
 * @param {import('express').Express} app
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
export function registerYoutubePasteParseRoutes(app, log) {
  app.post("/api/youtube-fetch/parse-text", async (req, res) => {
    try {
      const body = req.body ?? {};
      const rawText = String(body.text ?? body.content ?? "").trim();
      let title = String(body.title ?? "").trim();
      let content = String(body.body ?? body.transcript ?? "").trim();

      if (rawText) {
        const split = splitPasteText(rawText);
        title = split.title;
        content = split.content;
      }

      if (!title) {
        res.status(400).json({ ok: false, error: "第一行标题不能为空" });
        return;
      }
      if (!content) {
        res.status(400).json({ ok: false, error: "标题下方需有正文内容" });
        return;
      }

      const analysis = await analyzePasteContent(title, content, log);
      const parsed =
        analysis.parsed && typeof analysis.parsed === "object"
          ? /** @type {Record<string, unknown>} */ (analysis.parsed)
          : null;

      const coinActions = normalizeCoinActions(parsed);
      const preview = buildPastePreviewCard(title, content, parsed, coinActions, {
        provider: analysis.provider,
        model: analysis.model,
        analyzedAt: analysis.analyzedAt,
        error: analysis.error ?? null,
        fallbackFrom: analysis.fallbackFrom ?? null,
      });

      res.json({
        ok: true,
        title,
        contentLength: content.length,
        coinActions,
        analysis,
        preview,
      });
    } catch (e) {
      log.warn(`parse-text: ${/** @type {Error} */ (e).message}`);
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}
