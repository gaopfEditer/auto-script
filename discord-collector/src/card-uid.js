/**
 * 卡片对外唯一标识：SC-{dbId}，便于外部评估回填与数据补充。
 */

/** @param {unknown} id */
export function formatCardUid(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `SC-${Math.trunc(n)}`;
}

/**
 * @param {string} text
 * @param {unknown} cardId
 */
export function ensureCardUidInText(text, cardId) {
  const uid = formatCardUid(cardId);
  const t = String(text ?? "").trimEnd();
  if (!uid) return t;
  if (new RegExp(`\\bID\\s+${uid}\\b`, "i").test(t)) return t;
  if (new RegExp(`(?:^|\\n)${uid}(?:\\n|$)`).test(t)) return t;
  return t ? `${t}\nID ${uid}` : `ID ${uid}`;
}

/**
 * @param {Record<string, string> | null | undefined} cardsByStyle
 * @param {unknown} cardId
 * @returns {Record<string, string>}
 */
export function stampCardsByStyle(cardsByStyle, cardId) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(cardsByStyle ?? {})) {
    out[k] = ensureCardUidInText(String(v ?? ""), cardId);
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
  const hasId = fields.some((f) => f && typeof f === "object" && String(/** @type {Record<string, unknown>} */ (f).name) === "标识");
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
