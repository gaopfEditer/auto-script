/**
 * 粘贴文稿 → Ollama 解析 → 多币种操作 JSON 预览（不入库、不走信号卡片系统）。
 */
import { analyzeTranscriptWithDeepSeek, isLocalModelUnavailable } from "../../youtube-fetch/src/deepseek-analyze.js";
import { analyzeTranscriptWithOllama } from "../../youtube-fetch/src/ollama-analyze.js";
import { config as ytFetchConfig } from "../../youtube-fetch/src/config.js";
import { buildDiscordCardFields, normalizeSymbol } from "./card-fields.js";

export const PASTE_PARSE_PROMPT = `你是加密货币/交易类文稿分析器。根据下面文稿，按**时间顺序**整理交易信息与分析要点。

输出**合法 JSON 对象**（不要 markdown 代码块），结构如下：
{
  "summary": ["全文核心观点，每条一句，3～8 条；**必填**，即使文中没有明确价位也要写清讲了什么、整体态度"],
  "titleHint": "一句话标题",
  "segments": [
    {
      "timeLabel": "时间段标签，如 开场/前段/中段/后段，或 约00:08/约12:30",
      "timeRange": "可选，如 00:00-05:30",
      "overview": "本段 1～2 句主旨（必填）",
      "analysis": ["本段分析要点，每条一句，可含盘面/结构/心态，无则 []"],
      "coinActions": [
        {
          "symbol": "BTC",
          "actionType": "new",
          "direction": "做多/做空/观望，无则空字符串",
          "entry": "入场条件或价位，如 跌破88做空 / 97做多",
          "stopLoss": "止损价，无则空字符串",
          "targets": ["止盈1", "止盈2"],
          "exit": "出场/止盈说明，如 到90走 / 冲不上去就走",
          "pnl": "涨跌幅或盈亏，无则空字符串",
          "description": "20字内定位说明"
        }
      ]
    }
  ],
  "coinActions": [
    {
      "symbol": "BTC",
      "actionType": "new",
      "direction": "做多/做空/观望，无则空字符串",
      "entry": "入场价或区间，如 61800-62000",
      "stopLoss": "止损价，无则空字符串",
      "targets": ["止盈1", "止盈2"],
      "exit": "出场/止盈说明",
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
1. **summary 必填**，放全文概要，与是否有明确币种无关
2. **segments 按文稿时间顺序**串联；每段含 overview + analysis + 该段 coinActions（无币种也保留段，coinActions 可为 []）
3. coinActions（顶层）= 全文所有币种操作扁平列表，与 segments 内合并一致，按出现顺序
4. 不要编造文稿没有的价位；没有的信息用空字符串或空数组
5. entry/stopLoss/targets/exit 分开填；「跌破 X 才空」写入 entry，「止损 Y」写入 stopLoss，「到 Z 走/止盈」写入 targets 或 exit
6. description 要写清楚「在说什么」，方便人工回原文查找

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
 *   exit: string,
 *   description: string,
 * }} CoinAction */

/** @typedef {{
 *   timeLabel: string,
 *   timeRange: string,
 *   overview: string,
 *   analysis: string[],
 *   coins: CoinAction[],
 * }} PasteSegment */

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
        exit: "",
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
      exit: String(row.exit ?? row.exitNote ?? row.takeProfitNote ?? "").trim(),
      description: String(row.description ?? row.note ?? row.summary ?? "").trim(),
    });
  }
  return out;
}

/** @param {unknown} parsed @param {CoinAction[]} coinActions @param {string} content */
export function ensureSummary(parsed, coinActions, content) {
  const direct = asStringList(parsed?.summary);
  if (direct.length) return direct.slice(0, 8);

  /** @type {string[]} */
  const fromSeg = [];
  const segs = parsed?.segments;
  if (Array.isArray(segs)) {
    for (const item of segs) {
      if (!item || typeof item !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (item);
      const ov = String(row.overview ?? row.summary ?? "").trim();
      if (ov) fromSeg.push(ov);
      fromSeg.push(...asStringList(row.analysis));
    }
  }
  if (fromSeg.length) return [...new Set(fromSeg)].slice(0, 8);

  if (coinActions.length) {
    return coinActions
      .slice(0, 5)
      .map((c) => {
        const parts = [c.symbol, c.direction, c.entry, c.description].filter(Boolean);
        return parts.join(" · ") || c.symbol;
      });
  }

  const lines = String(content ?? "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 24);
  if (lines.length) return lines.slice(0, 3).map((l) => l.slice(0, 160));

  const hint = String(parsed?.titleHint ?? "").trim();
  if (hint) return [hint];
  return ["文稿已解析，详见下方时间段卡片。"];
}

/** @param {unknown} parsed @param {CoinAction[]} coinActions @param {string} content */
export function normalizeSegments(parsed, coinActions, content) {
  const raw = parsed?.segments;
  if (Array.isArray(raw) && raw.length) {
    /** @type {PasteSegment[]} */
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!item || typeof item !== "object") continue;
      const row = /** @type {Record<string, unknown>} */ (item);
      const coins = normalizeCoinActions({ coinActions: row.coinActions ?? row.coins });
      const overview = String(row.overview ?? row.summary ?? row.theme ?? "").trim();
      const analysis = asStringList(row.analysis ?? row.notes ?? row.points);
      const timeLabel =
        String(row.timeLabel ?? row.time ?? row.phase ?? row.label ?? "").trim() ||
        `片段 ${i + 1}`;
      const timeRange = String(row.timeRange ?? row.time_range ?? "").trim();
      if (!overview && !analysis.length && !coins.length) continue;
      out.push({ timeLabel, timeRange, overview, analysis, coins });
    }
    if (out.length) return out;
  }

  if (coinActions.length) {
    return coinActions.map((coin, i) => ({
      timeLabel: `片段 ${i + 1}`,
      timeRange: "",
      overview: coin.description || `${coin.symbol} · ${coin.actionType}`,
      analysis: [],
      coins: [coin],
    }));
  }

  const summary = ensureSummary(parsed, coinActions, content);
  return [
    {
      timeLabel: "全文",
      timeRange: "",
      overview: summary[0] ?? "",
      analysis: summary.slice(1),
      coins: [],
    },
  ];
}

/**
 * @param {string} title
 * @param {string} content
 * @param {Record<string, unknown> | null} parsed
 * @param {CoinAction[]} coinActions
 * @param {Record<string, unknown>} analysisMeta
 */
export function buildPastePreviewCard(title, content, parsed, coinActions, analysisMeta) {
  const segments = normalizeSegments(parsed, coinActions, content);
  const summary = ensureSummary(parsed, coinActions, content);
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
    segments,
    analysis: analysisMeta,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * @param {string} title
 * @param {string} content
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
export async function analyzePasteContent(title, content, log) {
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
 * @param {{ rawText?: string, title?: string, content?: string, log: ReturnType<typeof import('./logger.js').createLogger> }} opts
 */
export async function parsePasteTextToResult({ rawText = "", title = "", content = "", log }) {
  let t = String(title ?? "").trim();
  let c = String(content ?? "").trim();
  const raw = String(rawText ?? "").trim();

  if (raw) {
    const split = splitPasteText(raw);
    t = split.title;
    c = split.content;
  }

  if (!t) throw new Error("第一行标题不能为空");
  if (!c) throw new Error("标题下方需有正文内容");

  const analysis = await analyzePasteContent(t, c, log);
  const parsed =
    analysis.parsed && typeof analysis.parsed === "object"
      ? /** @type {Record<string, unknown>} */ (analysis.parsed)
      : null;

  const coinActions = normalizeCoinActions(parsed);
  const preview = buildPastePreviewCard(t, c, parsed, coinActions, {
    provider: analysis.provider,
    model: analysis.model,
    analyzedAt: analysis.analyzedAt,
    error: analysis.error ?? null,
    fallbackFrom: analysis.fallbackFrom ?? null,
  });

  return {
    title: t,
    content: c,
    contentLength: c.length,
    coinActions,
    analysis,
    preview,
  };
}

/**
 * @param {import('express').Express} app
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
export function registerYoutubePasteParseRoutes(app, log) {
  app.post("/api/youtube-fetch/parse-text", async (req, res) => {
    try {
      const body = req.body ?? {};
      const result = await parsePasteTextToResult({
        rawText: String(body.text ?? body.content ?? ""),
        title: String(body.title ?? ""),
        content: String(body.body ?? body.transcript ?? ""),
        log,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      if (msg.includes("标题") || msg.includes("正文")) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      log.warn(`parse-text: ${msg}`);
      res.status(500).json({ ok: false, error: msg });
    }
  });
}
