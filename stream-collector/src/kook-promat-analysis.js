/**
 * CHANNEL_MSG → 本地 Ollama：输出标准字段（用户名、币种、现价/市价、入场、出场）。
 */
import { PROMAT_ANALYSIS } from "./promat-analysis-config.js";
import { logPushBanner } from "./push-log-banner.js";

/** 话术样例（与 promat.txt 一致，供 prompt few-shot） */
const EXAMPLE_SAMPLES = [
  {
    label: "比特币方向做多（舒琴格式）",
    text: `比特币
方向：做多
入场：7.62-7.65附近
信心度：中
倍数：10倍
仓位：10%
芷楹：点位1：接近7.8附近（求稳） 点位2：7.94附近 
芷損：小幅跌破7.54一点。
理由：比特币7.6附近支撑不错，可以在这里做的反弹。`,
    out: {
      is_signal: true,
      username: "舒琴",
      symbol: "BTC",
      market_price: "",
      entry_price: "7.62-7.65",
      exit_price: "7.8/7.94",
    },
  },
  {
    text: `#OPG  市價進空
槓桿建議：穩健20x 
倉位建議：總資金的5%
第一芷楹：0.2746
第二芷楹：0.26
第三芷楹：0.245
止損：0.325

穩健操作建議：第一芷楹觸發後 將止損價移至進場價。`,
    out: {
      is_signal: true,
      username: "",
      symbol: "OPG",
      market_price: "市价",
      entry_price: "0.2746",
      exit_price: "0.26/0.245",
    },
  },
  {
    label: "祝贺无交易结构",
    text: `#OPG   恭喜！ 抵达！`,
    out: {
      is_signal: false,
      username: "",
      symbol: "OPG",
      market_price: "",
      entry_price: "",
      exit_price: "",
    },
  },
  {
    label: "ETH 市价空 + 多档芷楹",
    text: `没有上车的继续死拿严格执行，分批执行，强平控制在3000U左右或者以上，今天发现有1个扰乱军心的已经直接处理了。#BTC #ETH
ETH 做空（27连胜） 仓位思路强平控制3000及以上
2112市价直接空 100倍 2%保证金
再挂2258（逃命点位只给一次机会逃）100倍 3%保证金
第一芷楹2018（或者靠嘴喊短线2078芷楹靠谱） 芷楹70% 移动保本损
第二芷楹1788
第三芷楹1388
芷損2330。#ETH`,
    out: {
      is_signal: true,
      username: "",
      symbol: "ETH",
      market_price: "2112",
      entry_price: "2112/2258",
      exit_price: "2018/1788/1388",
    },
  },
  {
    label: "区间空 + 区间多",
    text: `ETH
2148-2158附近空
止笋2175
芷楹2133-2105

ETH
2103-2090附近多
止笋2075
芷楹2118-2150`,
    out: {
      is_signal: true,
      username: "",
      symbol: "ETH",
      market_price: "",
      entry_price: "2148-2158/2103-2090",
      exit_price: "2133-2105/2118-2150",
    },
  },
  {
    label: "以太坊现价做多",
    text: `以太坊现价2103附近做多

芷損：2045

芷楹：2220
轻仓介入……`,
    out: {
      is_signal: true,
      username: "",
      symbol: "ETH",
      market_price: "2103",
      entry_price: "2103附近",
      exit_price: "2220",
    },
  },
];

const SYSTEM_RULES = `你是 Kook 加密货币群「做单话术」结构化解析器。根据一条频道原文，抽取标准字段。

术语：芷楹/芷損/止笋/止盈 ≈ 目标价或止损；市價/现价/附近 ≈ 市价表述。

**输出要求**
- 只输出**一行**合法 JSON，不要 markdown、不要解释。
- 字段（字符串，无信息用 ""）：
  - is_signal (boolean): 是否含可执行的开平仓价位信息（仅有恭喜/闲聊/纯情绪为 false）
  - username (string): 正文里出现的带单昵称/老师名；没有则 ""
  - symbol (string): 币种，如 ETH、BTC、OPG（带 # 也去掉 #）
  - market_price (string): 现价/市价进场表述，如 "2112"、"2103"、"市价"；无则 ""
  - entry_price (string): 入场/开仓/挂单/第一档进场；多档用 / 连接
  - exit_price (string): 止盈/芷楹/目标出场；多档用 / 或 - 区间；无则 ""

若 Kook 已提供发信人昵称，可填入 username；正文有更明确的带单名则优先正文。`;

/**
 * @param {string} messageText
 * @param {{ authorDisplay?: string }} [ctx]
 */
export function buildPromatAnalysisPrompt(messageText, ctx = {}) {
  const author = String(ctx.authorDisplay ?? "").trim();
  const blocks = EXAMPLE_SAMPLES.map(
    (ex) =>
      `【样例·${ex.label}】\n原文：\n${ex.text}\n期望 JSON：${JSON.stringify(ex.out)}`
  );
  return `${SYSTEM_RULES}

${blocks.join("\n\n")}

【待解析消息】
${author ? `（Kook 发信人：${author}）\n` : ""}${String(messageText ?? "").trim()}

只输出一个 JSON：`;
}

/**
 * @param {string} raw
 * @returns {{
 *   is_signal: boolean;
 *   username: string;
 *   symbol: string;
 *   market_price: string;
 *   entry_price: string;
 *   exit_price: string;
 * } | null}
 */
export function parsePromatAnalysisJson(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;

  let slice = t;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) slice = fence[1].trim();
  const brace = slice.match(/\{[\s\S]*\}/);
  if (brace) slice = brace[0];

  try {
    const o = JSON.parse(slice);
    const is_signal = o.is_signal === true || o.is_signal === "true" || o.is_signal === 1;
    return {
      is_signal,
      username: String(o.username ?? "").trim(),
      symbol: String(o.symbol ?? o.coin ?? o.币种 ?? "").trim().replace(/^#/, ""),
      market_price: String(o.market_price ?? o.marketPrice ?? o.现价 ?? o.市价 ?? "").trim(),
      entry_price: String(o.entry_price ?? o.entryPrice ?? o.入场价格 ?? o.入场 ?? "").trim(),
      exit_price: String(o.exit_price ?? o.exitPrice ?? o.出场价格 ?? o.出场 ?? o.止盈 ?? "").trim(),
    };
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {ReturnType<typeof import("./kook-promat-publish.js").createPromatPublishHelper> | null} [promatPublish]
 */
export function createKookPromatAnalysis(log, promatPublish = null) {
  const { ollama } = PROMAT_ANALYSIS;
  const generateUrl = `${ollama.baseUrl.replace(/\/$/, "")}/api/generate`;

  /**
   * @param {string} messageText
   * @param {{ authorDisplay?: string; messageId?: string; guildId?: string; channelId?: string }} [meta]
   */
  async function analyzeMessage(messageText, meta = {}) {
    if (!ollama.enabled) return null;
    const text = String(messageText ?? "").trim();
    if (!text) return null;

    const prompt = buildPromatAnalysisPrompt(text, {
      authorDisplay: meta.authorDisplay,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ollama.timeoutSec * 1000);

    try {
      const r = await fetch(generateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollama.model,
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
      const parsed = parsePromatAnalysisJson(body.response ?? "");
      if (!parsed) {
        logPushBanner(log, "warn", "Promat 解析失败 · JSON", [
          meta.messageId ? `message_id: ${meta.messageId}` : "",
          `raw: ${String(body.response ?? "").slice(0, 200)}`,
        ].filter(Boolean));
        return null;
      }
      return parsed;
    } catch (e) {
      const err = /** @type {Error} */ (e);
      logPushBanner(log, "warn", "Promat 解析失败 · Ollama", [
        meta.messageId ? `message_id: ${meta.messageId}` : "",
        err.message,
      ].filter(Boolean));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {{
   *   messageId?: string;
   *   guildId?: string;
   *   channelId?: string;
   *   content?: string;
   *   authorUsername?: string | null;
   *   authorNickname?: string | null;
   *   source?: string;
   * }} row
   */
  async function analyzeFromRow(row) {
    const src = String(row.source ?? "").trim();
    if (src !== "ws_channel_msg") return null;

    const authorDisplay =
      String(row.authorNickname ?? "").trim() ||
      String(row.authorUsername ?? "").trim() ||
      "";

    const parsed = await analyzeMessage(row.content ?? "", {
      authorDisplay,
      messageId: row.messageId,
      guildId: row.guildId,
      channelId: row.channelId,
    });
    if (!parsed) return null;

    const displayUser =
      parsed.username || authorDisplay || "(未识别)";
    logPushBanner(log, "info", "Promat 解析 · CHANNEL_MSG", [
      row.guildId ? `guild_id: ${row.guildId}` : "",
      row.channelId ? `channel_id: ${row.channelId}` : "",
      row.messageId ? `message_id: ${row.messageId}` : "",
      `is_signal: ${parsed.is_signal}`,
      `用户名: ${displayUser}`,
      `币种: ${parsed.symbol || "(空)"}`,
      `现价/市价: ${parsed.market_price || "(空)"}`,
      `入场价格: ${parsed.entry_price || "(空)"}`,
      `出场价格: ${parsed.exit_price || "(空)"}`,
      "--- 原文摘要 ---",
      String(row.content ?? "").slice(0, 400),
    ].filter(Boolean));

    if (promatPublish) {
      try {
        const pub = await promatPublish.maybePublish({
          guildId: row.guildId,
          channelId: row.channelId,
          messageId: row.messageId,
          content: row.content,
          authorDisplay,
          parsed,
        });
        if (pub.skipped && pub.skipped !== "not_signal") {
          log.debug(`promat publish: ${pub.skipped}`);
        }
      } catch (e) {
        logPushBanner(log, "error", "Promat 发车异常", [
          row.messageId ? `message_id: ${row.messageId}` : "",
          /** @type {Error} */ (e).message,
        ].filter(Boolean));
      }
    } else if (parsed.is_signal) {
      logPushBanner(log, "warn", "Promat 发车未配置 publish helper", [
        row.messageId ? `message_id: ${row.messageId}` : "",
      ].filter(Boolean));
    }

    return parsed;
  }

  return { analyzeMessage, analyzeFromRow };
}
