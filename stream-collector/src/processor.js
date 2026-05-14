/**
 * 将 Buffer 尝试解析为 JSON，并按预定义 schema（顶层键）校验。
 * @param {Buffer} buffer
 * @param {string[]} requiredTopLevelKeys
 */
export function processBuffer(buffer, requiredTopLevelKeys) {
  const receivedAt = new Date().toISOString();
  let text;
  try {
    text = buffer.toString("utf8");
  } catch (e) {
    return {
      receivedAt,
      ok: false,
      parseError: `utf8_decode: ${e?.message ?? e}`,
      parsedJson: null,
    };
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return {
      receivedAt,
      ok: false,
      parseError: `json_parse: ${e?.message ?? e}`,
      parsedJson: null,
    };
  }

  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      receivedAt,
      ok: false,
      parseError: "schema: root must be a non-array object",
      parsedJson: null,
    };
  }

  for (const key of requiredTopLevelKeys) {
    if (!(key in obj)) {
      return {
        receivedAt,
        ok: false,
        parseError: `schema: missing key "${key}"`,
        parsedJson: null,
      };
    }
  }

  return {
    receivedAt,
    ok: true,
    parseError: null,
    parsedJson: JSON.stringify(obj),
  };
}
