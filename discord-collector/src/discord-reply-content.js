/**
 * Discord 回复/引用：从正文里去掉被引用消息内容，避免重复解析、重复发卡/TG。
 */
import { normalizeSignalText } from "./discord-signal-dedup.js";

/** @param {unknown} v */
function asRecord(v) {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : null;
}

/** @param {string} line */
function normalizeCompareLine(line) {
  return String(line ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** @param {string} text */
export function dedupeContentLines(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  /** @type {string[]} */
  const kept = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const line of raw.split(/\n/)) {
    const chunk = line.replace(/\s+$/, "");
    if (!chunk.trim()) continue;
    const key = normalizeCompareLine(chunk);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(chunk);
  }
  return kept.join("\n").trim();
}

/**
 * @param {string} text
 * @param {string} quoted
 */
export function stripEmbeddedQuotedContent(text, quoted) {
  const body = String(text ?? "").trim();
  const quote = String(quoted ?? "").trim();
  if (!body || !quote) return dedupeContentLines(body);
  if (body === quote) return "";

  if (body.startsWith(quote)) {
    const rest = body.slice(quote.length).replace(/^\s*\n+/, "").trim();
    return dedupeContentLines(rest);
  }

  const quoteLines = quote.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (quoteLines.length) {
    const bodyLines = body.split(/\n/);
    if (bodyLines.length >= quoteLines.length) {
      const head = bodyLines.slice(0, quoteLines.length).map((l) => l.trim());
      const sameHead = head.every(
        (ln, i) => normalizeCompareLine(ln) === normalizeCompareLine(quoteLines[i] ?? ""),
      );
      if (sameHead) {
        const rest = bodyLines.slice(quoteLines.length).join("\n").trim();
        return dedupeContentLines(rest);
      }
    }
  }

  const qNorm = normalizeCompareLine(quote);
  if (qNorm && normalizeCompareLine(body).includes(qNorm)) {
    const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = body.replace(new RegExp(escaped, "s"), "").trim();
    return dedupeContentLines(stripped);
  }

  const qKeys = new Set(quoteLines.map((l) => normalizeCompareLine(l)).filter(Boolean));
  const kept = body
    .split(/\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((ln) => ln.trim() && !qKeys.has(normalizeCompareLine(ln)));
  return dedupeContentLines(kept.join("\n"));
}

/**
 * 仅当前消息正文（不含 referenced_message 递归）。
 * @param {Record<string, unknown>} m
 */
export function extractMessageContentSelfOnly(m) {
  const parts = [];
  const raw = typeof m.content === "string" ? m.content.trim() : "";
  if (raw) parts.push(raw);

  const embeds = Array.isArray(m.embeds) ? m.embeds : [];
  for (const item of embeds) {
    const e = asRecord(item);
    if (!e) continue;
    for (const key of ["title", "description", "url"]) {
      const v = String(e[key] ?? "").trim();
      if (v) parts.push(v);
    }
    const fields = Array.isArray(e.fields) ? e.fields : [];
    for (const f of fields) {
      const fr = asRecord(f);
      if (!fr) continue;
      const name = String(fr.name ?? "").trim();
      const value = String(fr.value ?? "").trim();
      if (name && value) parts.push(`${name}: ${value}`);
      else if (value) parts.push(value);
      else if (name) parts.push(name);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const p of parts) {
    const line = p.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    deduped.push(line);
  }
  return deduped.join("\n").trim();
}

/**
 * @param {unknown} rawJson
 * @returns {string | null} 被回复消息的 id
 */
export function resolveReplyReferenceMessageId(rawJson) {
  const m = asRecord(rawJson);
  if (!m) return null;
  const ref = asRecord(m.message_reference);
  const id = ref?.message_id ?? ref?.messageId;
  if (id != null && String(id).trim()) return String(id).trim();
  const snap = asRecord(m.referenced_message);
  if (snap?.id != null && String(snap.id).trim()) return String(snap.id).trim();
  return null;
}

/**
 * 信号用正文：去掉 referenced_message 里的重复块。
 * @param {unknown} rawJson
 * @param {string} [fallbackContent]
 */
export function resolveSignalContentFromRaw(rawJson, fallbackContent = "") {
  const m = asRecord(rawJson);
  let content = m ? extractMessageContentSelfOnly(m) : String(fallbackContent ?? "").trim();
  if (!content && fallbackContent) {
    content = String(fallbackContent).trim();
  }
  const ref = m ? asRecord(m.referenced_message) : null;
  if (ref) {
    const quoted = extractMessageContentSelfOnly(ref);
    if (quoted) content = stripEmbeddedQuotedContent(content, quoted);
  }
  return dedupeContentLines(normalizeSignalText(content));
}

/**
 * @param {Record<string, unknown>} row
 */
export function resolveSignalContentFromRow(row) {
  const rawJson = row.rawJson ?? row.raw_json;
  const fallback = String(row.content ?? "");
  return resolveSignalContentFromRaw(rawJson, fallback);
}

/**
 * 回复消息是否主要在复读被引用的开仓正文（应合并/跳过，不应再发一张新卡）。
 * @param {string} content 已 strip 后的正文
 * @param {string} refContent 被引用消息正文（归一化）
 */
export function isReplyRepostOfReference(content, refContent) {
  const a = normalizeSignalText(content);
  const b = normalizeSignalText(refContent);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= b.length * 0.55 && (a.includes(b) || b.includes(a))) return true;

  const linesA = new Set(a.split(/\n/).map((l) => normalizeCompareLine(l)).filter(Boolean));
  const linesB = b.split(/\n/).map((l) => normalizeCompareLine(l)).filter(Boolean);
  if (!linesB.length) return false;
  let hit = 0;
  for (const ln of linesB) {
    if (linesA.has(ln)) hit += 1;
  }
  return hit >= Math.max(2, Math.ceil(linesB.length * 0.75));
}
