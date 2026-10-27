/**
 * 卡片文章/文稿来源跳转。
 * @typedef {{
 *   kind: "article" | "youtube",
 *   label: string,
 *   displayName: string,
 *   title: string,
 *   to: { path: string, query: Record<string, string> },
 * }} CardSourceLink
 */

/** @param {string} name */
function shortenFileName(name) {
  const s = String(name ?? "").trim();
  if (s.length <= 28) return s;
  const ext = s.includes(".") ? s.slice(s.lastIndexOf(".")) : "";
  const base = ext ? s.slice(0, -ext.length) : s;
  return `${base.slice(0, 18)}…${base.slice(-4)}${ext}`;
}

/**
 * @param {Record<string, unknown> | null | undefined} card
 * @returns {CardSourceLink | null}
 */
export function resolveCardSourceLink(card) {
  if (!card || typeof card !== "object") return null;

  const sourceType = String(card.sourceType ?? "").trim().toLowerCase();
  const sourceRef = String(card.sourceRef ?? "").trim();
  const parsed =
    card.parsedJson && typeof card.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (card.parsedJson)
      : {};

  const refFromParsed = String(parsed.sourceRef ?? "").trim();
  const ref = sourceRef || refFromParsed;
  if (!ref) return null;

  const isPasteArticle =
    Boolean(parsed.paste) ||
    Boolean(parsed.coinWatch) ||
    (sourceType === "youtube" && /\.txt$/i.test(ref));

  if (isPasteArticle && /\.txt$/i.test(ref)) {
    const title = String(parsed.sourceTitle ?? "").trim() || ref;
    return {
      kind: "article",
      label: "文章",
      displayName: shortenFileName(ref),
      title,
      to: { path: "/fetch", query: { mode: "paste", file: ref, tab: "fulltext" } },
    };
  }

  if (sourceType === "youtube" && ref && !ref.startsWith("manual-") && !/\.txt$/i.test(ref)) {
    return {
      kind: "youtube",
      label: "文稿",
      displayName: ref.length > 16 ? `${ref.slice(0, 12)}…` : ref,
      title: String(parsed.title ?? ref),
      to: { path: "/archives", query: { v: ref } },
    };
  }

  return null;
}
