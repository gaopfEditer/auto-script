/**
 * 将任意值规范为可写入 MySQL JSON 列的对象（或 null）。
 * 避免把非 JSON 字符串（如 "Invalid value."）直接塞进 JSON 列导致写入失败。
 */

/** @param {string} key @param {unknown} value */
function jsonReplacer(key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (typeof value === "function") return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer) return value.toString("utf8");
  return value;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepCloneJsonSafe(value) {
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}

/**
 * @param {unknown} rawJson
 * @returns {Record<string, unknown> | unknown[] | null}
 */
export function normalizeRawJsonForMysql(rawJson) {
  if (rawJson == null) return null;

  /** @type {unknown} */
  let parsed = rawJson;

  if (typeof rawJson === "string") {
    const t = rawJson.trim();
    if (!t) return null;
    try {
      parsed = JSON.parse(t);
    } catch {
      return { _rawText: t.slice(0, 32_000) };
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { _scalar: parsed };
  }

  try {
    const cloned = deepCloneJsonSafe(parsed);
    if (cloned === null || typeof cloned !== "object") {
      return { _scalar: cloned };
    }
    return /** @type {Record<string, unknown> | unknown[]} */ (cloned);
  } catch {
    return {
      _serializeError: true,
      preview: String(rawJson).slice(0, 2000),
    };
  }
}

/**
 * 写入 MySQL JSON 列：必须返回合法 JSON 文本（mysql2 批量 INSERT 传 object 会踩坑）。
 * @param {unknown} rawJson
 * @returns {string | null}
 */
export function serializeRawJsonColumnForMysql(rawJson) {
  const normalized = normalizeRawJsonForMysql(rawJson);
  if (normalized == null) return null;
  try {
    const text = JSON.stringify(normalized);
    JSON.parse(text);
    return text;
  } catch {
    try {
      return JSON.stringify({
        _serializeError: true,
        preview: String(rawJson).slice(0, 2000),
      });
    } catch {
      return null;
    }
  }
}
