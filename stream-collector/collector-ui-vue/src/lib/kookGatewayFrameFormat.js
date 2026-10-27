/**
 * 将 Kook 网关 WS 帧（含 content/extra 多层 JSON 字符串）展开为可读结构。
 */

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function deepParseJsonStrings(value, depth = 6) {
  if (depth <= 0) return value;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return value;
    if (
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))
    ) {
      try {
        return deepParseJsonStrings(JSON.parse(t), depth - 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((x) => deepParseJsonStrings(x, depth - 1));
  }
  if (value != null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      out[k] = deepParseJsonStrings(v, depth - 1);
    }
    return out;
  }
  return value;
}

/**
 * @param {unknown} frameRoot
 * @returns {Record<string, unknown> | null}
 */
export function parseKookGatewayFrameDeep(frameRoot) {
  if (frameRoot == null || typeof frameRoot !== "object" || Array.isArray(frameRoot)) {
    return null;
  }
  const parsed = deepParseJsonStrings(frameRoot);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @param {Record<string, unknown>} frame
 * @returns {string[]}
 */
export function formatKookGatewayFrameForLog(frame) {
  const root = parseKookGatewayFrameDeep(frame) ?? frame;
  const lines = [];
  lines.push(`s: ${String(root.s ?? "")}`);
  lines.push(`sn: ${String(root.sn ?? "")}`);

  const d = root.d;
  if (d == null || typeof d !== "object" || Array.isArray(d)) {
    lines.push("d: (无)");
    return lines;
  }
  const di = /** @type {Record<string, unknown>} */ (d);
  lines.push(`d.type: ${String(di.type ?? "")}`);
  if (di.channelType != null) lines.push(`d.channelType: ${String(di.channelType)}`);
  if (di.msgId != null) lines.push(`d.msgId: ${String(di.msgId)}`);
  if (di.fromUserId != null) lines.push(`d.fromUserId: ${String(di.fromUserId)}`);
  if (di.msgTimestamp != null) lines.push(`d.msgTimestamp: ${String(di.msgTimestamp)}`);

  const inner =
    di.content != null && typeof di.content === "object" && !Array.isArray(di.content)
      ? /** @type {Record<string, unknown>} */ (di.content)
      : null;

  if (inner) {
    const text =
      String(inner.content ?? "").trim() ||
      String(
        inner.kmarkdown &&
          typeof inner.kmarkdown === "object" &&
          /** @type {Record<string, unknown>} */ (inner.kmarkdown).raw_content
      ).trim();
    if (text) lines.push(`正文: ${text.replace(/\n/g, " ")}`);

    const extra =
      inner.extra != null && typeof inner.extra === "object" && !Array.isArray(inner.extra)
        ? /** @type {Record<string, unknown>} */ (inner.extra)
        : null;
    if (extra) {
      if (extra.guild_id != null) lines.push(`guild_id: ${String(extra.guild_id)}`);
      if (extra.channel_id != null) lines.push(`channel_id: ${String(extra.channel_id)}`);
      if (extra.channel_name != null) lines.push(`channel_name: ${String(extra.channel_name)}`);
      const author =
        extra.author != null && typeof extra.author === "object"
          ? /** @type {Record<string, unknown>} */ (extra.author)
          : null;
      if (author) {
        const nick = String(author.nickname ?? author.username ?? "").trim();
        if (nick) lines.push(`author: ${nick} (${String(author.id ?? "")})`);
      }
    }
  }

  lines.push("--- 展开对象 (JSON) ---");
  try {
    const pretty = JSON.stringify(root, null, 2);
    const max = 12000;
    lines.push(pretty.length > max ? `${pretty.slice(0, max)}\n…(已截断)` : pretty);
  } catch {
    lines.push(String(root));
  }
  return lines;
}
