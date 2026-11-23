/**
 * 按正文重解析巨鲸单行模板卡，修正 symbol / execution，供清算重跑。
 */
import { buildCardFieldsFromExecution, extractSymbolFromPayload, normalizeSymbol } from "./card-fields.js";
import { detectAssetClass } from "./card-verify-policy.js";
import { normalizeSignalText } from "./discord-signal-dedup.js";
import { executionFromParsed } from "./discord-signal-execution.js";
import { formatCardFallback, parseSignalText } from "./discord-signal-parsers.js";
import { getSignalChannelConfig } from "./discord-signal-config.js";
import { prependKolvipCoinToMessageText } from "./kolvip-message-text.js";
/** @param {unknown} raw */
function parseJsonLoose(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** @param {unknown} raw */
function coinFromDiscordMessageRaw(raw) {
  const j = parseJsonLoose(raw);
  if (!j || typeof j !== "object") return "";
  const kolvip = /** @type {Record<string, unknown>} */ (j).kolvip;
  if (kolvip && typeof kolvip === "object") {
    const c = String(/** @type {Record<string, unknown>} */ (kolvip).coin ?? "").trim();
    if (c) return c;
  }
  return "";
}

/**
 * @param {Record<string, unknown>} cardRow
 * @param {string} [contentOverride]
 */
export function reparseKolvipBriefCard(cardRow, contentOverride) {
  const channelId = String(cardRow.channel_id ?? cardRow.channelId ?? "").trim();
  const chCfg = getSignalChannelConfig(channelId);
  const parser = chCfg?.parser ?? "generic";
  let content = normalizeSignalText(
    contentOverride ?? String(cardRow.raw_content ?? cardRow.rawContent ?? "")
  );
  const coin = coinFromDiscordMessageRaw(cardRow.message_raw_json);
  if (coin) content = normalizeSignalText(prependKolvipCoinToMessageText(content, coin));

  const parsed = parseSignalText(content, parser);
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "parse_failed", content };

  const execution = executionFromParsed(/** @type {Record<string, unknown>} */ (parsed));
  const symbol = normalizeSymbol(extractSymbolFromPayload(parsed, execution));
  const assetClass = detectAssetClass(symbol, parsed, execution, content);
  const cardFields = buildCardFieldsFromExecution(execution, parsed, content);
  const styles = chCfg?.styles?.length ? chCfg.styles : ["cn_brief"];
  /** @type {Record<string, string>} */
  const cardsByStyle = {};
  for (const sid of styles) {
    cardsByStyle[sid] = formatCardFallback(/** @type {Record<string, unknown>} */ (parsed), sid);
  }

  return {
    ok: true,
    content,
    symbol,
    assetClass,
    parsedJson: parsed,
    executionJson: execution,
    cardFieldsJson: cardFields,
    cardsByStyle,
  };
}