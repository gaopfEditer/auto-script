/** @param {Record<string, unknown> | null | undefined} card */
export function cardSourcePostUrl(card) {
  const direct = String(card?.sourcePostUrl ?? "").trim();
  if (/^https?:\/\//i.test(direct)) return direct;

  const parsed =
    card?.parsedJson && typeof card.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (card.parsedJson)
      : {};
  for (const key of ["url", "href", "postUrl", "shareUrl", "sourceUrl", "tweetUrl", "webLink"]) {
    const u = String(parsed[key] ?? "").trim();
    if (/^https?:\/\//i.test(u)) return u;
  }

  const note = String(card?.note ?? "");
  const m = note.match(/https?:\/\/[^\s<>"')]+/i);
  if (m) {
    const u = m[0].replace(/[.,;)\]]+$/, "");
    if (!/127\.0\.0\.1|localhost|:3851\//i.test(u)) return u;
  }

  const msgId = String(card?.messageId ?? "").trim();
  if (msgId.startsWith("binance-")) {
    const id = msgId.slice("binance-".length);
    if (/^\d+$/.test(id)) return `https://www.binance.com/zh-CN/square/post/${id}`;
  }

  const ref = String(card?.sourceRef ?? "").trim();
  if (/^\d{8,}$/.test(ref) && String(card?.sourceType ?? "").toLowerCase().includes("binance")) {
    return `https://www.binance.com/zh-CN/square/post/${ref}`;
  }

  return "";
}