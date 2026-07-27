/**
 * 卡片对外唯一标识：SC-{dbId}。
 * 仅写入结构化字段（uid / Embed「标识」），不写入卡片正文。
 */

/** @param {unknown} id */
export function formatCardUid(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `SC-${Math.trunc(n)}`;
}

/**
 * 从正文去掉 ID SC-xxx / 单独一行的 SC-xxx（历史卡片清洗）。
 * @param {string} text
 */
export function stripCardUidFromText(text) {
  return String(text ?? "")
    .replace(/(?:^|\n)[ \t]*ID[ \t]+SC-\d+[ \t]*(?=\n|$)/gi, "\n")
    .replace(/(?:^|\n)[ \t]*SC-\d+[ \t]*(?=\n|$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} text
 * @param {unknown} [_cardId] 保留参数兼容旧调用，不再追加正文
 */
export function ensureCardUidInText(text, _cardId) {
  return stripCardUidFromText(text);
}

/**
 * @param {Record<string, string> | null | undefined} cardsByStyle
 * @param {unknown} [_cardId]
 * @returns {Record<string, string>}
 */
export function stampCardsByStyle(cardsByStyle, _cardId) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(cardsByStyle ?? {})) {
    out[k] = stripCardUidFromText(String(v ?? ""));
  }
  return out;
}

/**
 * @param {Record<string, unknown> | null | undefined} cardFields
 * @param {unknown} cardId
 */
export function stampCardFieldsUid(cardFields, cardId) {
  const uid = formatCardUid(cardId);
  if (!uid || !cardFields || typeof cardFields !== "object") return cardFields ?? null;
  const next = { ...cardFields };
  const fields = Array.isArray(next.fields) ? [...next.fields] : [];
  const hasId = fields.some(
    (f) => f && typeof f === "object" && String(/** @type {Record<string, unknown>} */ (f).name) === "标识"
  );
  if (!hasId) {
    fields.push({ name: "标识", value: uid, inline: true });
  }
  next.fields = fields;
  const footer =
    next.footer && typeof next.footer === "object"
      ? { .../** @type {Record<string, unknown>} */ (next.footer) }
      : {};
  const prevText = String(footer.text ?? "").trim();
  footer.text = prevText.includes(uid) ? prevText || uid : prevText ? `${prevText} · ${uid}` : uid;
  next.footer = footer;
  return next;
}
