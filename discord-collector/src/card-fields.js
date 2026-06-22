/**
 * Discord Embed 风格卡片字段结构（与 Discord API embed 字段对齐）。
 * @see https://discord.com/developers/docs/resources/channel#embed-object
 */

/** @typedef {{ name: string, value: string, inline?: boolean }} DiscordEmbedField */
/** @typedef {{
 *   title?: string,
 *   description?: string,
 *   color?: number,
 *   fields: DiscordEmbedField[],
 *   footer?: { text?: string },
 *   timestamp?: string,
 * }} DiscordCardFields */

const COLOR_LONG = 0x57f287;
const COLOR_SHORT = 0xed4245;
const COLOR_NEUTRAL = 0x5865f2;

/** @param {unknown} v */
export function normalizeSymbol(v) {
  const raw = String(v ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return "";
  if (raw.endsWith("USDT")) return raw;
  if (raw.length <= 10) return `${raw}USDT`;
  return raw;
}

/** @param {unknown} parsed @param {unknown} execution */
export function extractSymbolFromPayload(parsed, execution) {
  const ex = execution && typeof execution === "object" ? /** @type {Record<string, unknown>} */ (execution) : {};
  const p = parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed) : {};
  return normalizeSymbol(ex.symbol ?? p.symbol ?? p.asset ?? "");
}

/**
 * @param {{
 *   symbol?: string,
 *   direction?: string,
 *   entry?: string,
 *   targets?: string[],
 *   stopLoss?: string,
 *   title?: string,
 *   description?: string,
 *   sourceType?: string,
 *   sourceRef?: string,
 *   note?: string,
 * }} input
 */
export function buildDiscordCardFields(input) {
  const symbol = normalizeSymbol(input.symbol);
  const direction = String(input.direction ?? "").trim();
  const entry = String(input.entry ?? "").trim();
  const targets = Array.isArray(input.targets) ? input.targets.filter(Boolean) : [];
  const stopLoss = String(input.stopLoss ?? "").trim();
  const isShort = /空|short|sell/i.test(direction);

  /** @type {DiscordEmbedField[]} */
  const fields = [];
  if (symbol) fields.push({ name: "币种", value: symbol.replace("USDT", ""), inline: true });
  if (direction) fields.push({ name: "方向", value: direction, inline: true });
  if (entry) fields.push({ name: "入场", value: entry, inline: true });
  if (targets.length) fields.push({ name: "止盈", value: targets.join(" / "), inline: false });
  if (stopLoss) fields.push({ name: "止损", value: stopLoss, inline: true });
  if (input.sourceType) {
    fields.push({
      name: "来源",
      value: `${input.sourceType}${input.sourceRef ? ` · ${input.sourceRef}` : ""}`,
      inline: true,
    });
  }
  if (input.note) fields.push({ name: "备注", value: String(input.note).slice(0, 500), inline: false });

  const title =
    String(input.title ?? "").trim() ||
    (symbol ? `${symbol.replace("USDT", "")} ${direction || "信号"}` : "交易信号");

  return {
    title,
    description: String(input.description ?? "").trim() || undefined,
    color: direction ? (isShort ? COLOR_SHORT : COLOR_LONG) : COLOR_NEUTRAL,
    fields,
    footer: { text: input.sourceType ? `source:${input.sourceType}` : "discord-collector" },
    timestamp: new Date().toISOString(),
  };
}

/**
 * @param {unknown} execution @param {unknown} parsed @param {string} rawContent
 * @param {{ sourceType?: string, sourceRef?: string, note?: string }} [meta]
 */
export function buildCardFieldsFromExecution(execution, parsed, rawContent, meta = {}) {
  const ex = execution && typeof execution === "object" ? /** @type {Record<string, unknown>} */ (execution) : {};
  const planned =
    ex.planned && typeof ex.planned === "object"
      ? /** @type {Record<string, unknown>} */ (ex.planned)
      : {};
  const p = parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed) : {};

  const targets = planned.takeProfitPrices ?? p.targets ?? p.takeProfits ?? p.takeProfit;
  /** @type {string[]} */
  let targetList = [];
  if (Array.isArray(targets)) targetList = targets.map((x) => String(x));
  else if (targets) targetList = String(targets).split(/[,，;\s]+/).filter(Boolean);

  return buildDiscordCardFields({
    symbol: ex.symbol ?? p.symbol ?? p.asset,
    direction: ex.direction ?? p.direction,
    entry: planned.entryPrice ?? p.entry ?? p.entries,
    targets: targetList,
    stopLoss: planned.stopLossPrice ?? p.stopLoss,
    description: rawContent?.slice(0, 2000) || undefined,
    sourceType: meta.sourceType,
    sourceRef: meta.sourceRef,
    note: meta.note,
  });
}
