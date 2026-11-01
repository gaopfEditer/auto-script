/** 与 discord-gateway snowflake 一致（仅前端展示补全） */

/** @param {string} snowflake */
export function discordSnowflakeToMs(snowflake) {
  try {
    const id = BigInt(String(snowflake));
    return Number((id >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
}

/** @param {Record<string, unknown>} card */
export function hydrateBackfillCardSignalAt(card) {
  if (!card || typeof card !== "object") return card;
  const existing = String(card.signalAt ?? card.at ?? "").trim();
  if (existing && Number.isFinite(Date.parse(existing))) return card;

  const payload =
    card.cardPayload && typeof card.cardPayload === "object"
      ? /** @type {Record<string, unknown>} */ (card.cardPayload)
      : {};

  const mid = String(card.messageId ?? payload.messageId ?? "").trim();
  const ms = mid && /^\d{5,}$/.test(mid) ? discordSnowflakeToMs(mid) : 0;
  if (ms <= 0) return card;
  const signalAt = new Date(ms).toISOString();
  return { ...card, signalAt, at: signalAt };
}

/** @param {Array<Record<string, unknown>>} list */
export function hydrateBackfillCardList(list) {
  return (list ?? []).map((c) => hydrateBackfillCardSignalAt(c));
}
