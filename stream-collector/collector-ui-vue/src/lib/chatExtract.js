/**
 * 从网关/业务 JSON 中尽量抽出「对话」展示字段（KOOK 等常见 shape）。
 * @param {unknown} obj
 */
export function extractChatDisplay(obj) {
  if (obj === null || typeof obj !== "object") {
    return { author: "system", typeLabel: "raw", text: String(obj), extraJson: null };
  }
  const o = /** @type {Record<string, unknown>} */ (obj);
  const typeLabel = String(o.type ?? o.sn ?? "event");
  const p = o.payload;
  if (p && typeof p === "object") {
    const pl = /** @type {Record<string, unknown>} */ (p);
    const au = pl.author;
    let authorRaw = pl.username ?? pl.nickname ?? pl.name ?? "user";
    if (au && typeof au === "object") {
      const a = /** @type {Record<string, unknown>} */ (au);
      authorRaw = a.username ?? a.nickname ?? authorRaw;
    } else if (typeof au === "string") {
      authorRaw = au;
    }
    const author = typeof authorRaw === "string" ? authorRaw : String(authorRaw);
    const content =
      pl.content ?? pl.kmarkdown ?? pl.text ?? pl.message ?? pl.msg ?? "";
    if (String(content).length > 0) {
      return { author, typeLabel, text: String(content), extraJson: o };
    }
  }
  let text;
  try {
    text = JSON.stringify(o);
  } catch {
    text = "[object]";
  }
  return { author: typeLabel, typeLabel, text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text, extraJson: o };
}
