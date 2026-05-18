/**
 * KOOK_GROUPS_PUSH 群组：完整做单消息 POST 到本地 /api/publish/signal。
 * style_ids 与 STYLES_GROUPS_PUSH 按群组顺序一一对应，未匹配则用第一项。
 */
import { config } from "./config.js";
import { logPushBanner } from "./push-log-banner.js";

/** @param {string} raw */
function parseCsvList(raw) {
  return String(raw ?? "")
    .split(/[,，\s|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @returns {{ guildToStyle: Map<string, string>, defaultStyle: string, orderedGuilds: string[] }}
 */
export function buildGuildStyleMapping() {
  const orderedGuilds = parseCsvList(config.kookGroupsPush);
  const styles = parseCsvList(config.stylesGroupsPush);
  const defaultStyle = styles[0] ?? "";
  /** @type {Map<string, string>} */
  const guildToStyle = new Map();
  for (let i = 0; i < orderedGuilds.length; i += 1) {
    const gid = orderedGuilds[i];
    const style = styles[i] || defaultStyle;
    if (gid && style) guildToStyle.set(gid, style);
  }
  return { guildToStyle, defaultStyle, orderedGuilds };
}

/**
 * @param {string} guildId
 * @param {{ guildToStyle: Map<string, string>, defaultStyle: string }} mapping
 * @returns {string[]}
 */
export function resolveStyleIdsForGuild(guildId, mapping) {
  const gid = String(guildId ?? "").trim();
  const style = mapping.guildToStyle.get(gid) || mapping.defaultStyle;
  return style ? [style] : [];
}

/**
 * @param {{
 *   signal: string;
 *   guildId: string;
 *   styleIds: string[];
 *   strategyId?: string;
 *   composeMode?: string;
 *   publish?: boolean;
 * }} body
 */
/**
 * @param {{
 *   signal: string;
 *   guildId: string;
 *   styleIds: string[];
 *   strategyId?: string;
 *   composeMode?: string;
 *   publish?: boolean;
 * }} body
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export async function postPublishSignal(body, log) {
  const url = config.signalPublishUrl;
  if (!url) throw new Error("未配置 SIGNAL_PUBLISH_URL");

  const payload = {
    signal: body.signal,
    style_ids: body.styleIds,
    strategy_id: body.strategyId ?? config.signalPublishStrategyId,
    compose_mode: body.composeMode ?? config.signalPublishComposeMode,
    publish: body.publish ?? config.signalPublishPublish,
  };

  logPushBanner(log, "info", `SIGNAL_PUBLISH_URL → POST ${url}`, [
    `guild_id (KOOK_GROUPS_PUSH): ${body.guildId}`,
    `style_ids (STYLES_GROUPS_PUSH): ${body.styleIds.join(", ") || "(空)"}`,
    `strategy_id: ${payload.strategy_id}`,
    `compose_mode: ${payload.compose_mode}`,
    `publish: ${payload.publish}`,
    "--- signal 正文 ---",
    body.signal,
    "--- 请求 JSON（节选）---",
    JSON.stringify(
      { ...payload, signal: payload.signal.length > 500 ? `${payload.signal.slice(0, 500)}…` : payload.signal },
      null,
      2
    ),
  ]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.signalPublishTimeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      logPushBanner(log, "error", `SIGNAL_PUBLISH_URL 失败 HTTP ${r.status}`, [
        `guild_id: ${body.guildId}`,
        `style_ids: ${body.styleIds.join(", ")}`,
        text ? `response: ${text.slice(0, 500)}` : "",
      ]);
      throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    logPushBanner(log, "info", `SIGNAL_PUBLISH_URL 成功`, [
      `guild_id: ${body.guildId}`,
      `style_ids: ${body.styleIds.join(", ")}`,
      text ? `response: ${text.slice(0, 300)}` : "",
    ]);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {ReturnType<typeof import("./logger.js").createLogger>} log */
export function createSignalPublishHelper(log) {
  const mapping = buildGuildStyleMapping();
  const signalGuilds = new Set(mapping.orderedGuilds);
  const enabled = Boolean(config.signalPublishUrl) && signalGuilds.size > 0;

  if (enabled) {
    const pairs = mapping.orderedGuilds.map((g, i) => {
      const styles = parseCsvList(config.stylesGroupsPush);
      return `${g}→${styles[i] || mapping.defaultStyle}`;
    });
    log.info(
      `Kook 做单 → publish/signal | ${config.signalPublishUrl} | strategy=${config.signalPublishStrategyId} | ${pairs.join(" | ")}`
    );
  }

  /**
   * @param {{ guildId: string, content: string }} row
   */
  async function maybePublish(row) {
    if (!enabled) return { skipped: "signal_disabled" };
    const guildId = String(row.guildId ?? "").trim();
    if (!guildId || !signalGuilds.has(guildId)) return { skipped: "signal_guild" };

    const styleIds = resolveStyleIdsForGuild(guildId, mapping);
    if (!styleIds.length) return { skipped: "no_style" };

    const signal = String(row.content ?? "").trim();
    if (!signal) return { skipped: "empty" };

    await postPublishSignal(
      {
        signal,
        guildId,
        styleIds,
      },
      log
    );
    return { ok: true, styleIds };
  }

  return { maybePublish, enabled, signalGuilds: [...signalGuilds], mapping };
}
