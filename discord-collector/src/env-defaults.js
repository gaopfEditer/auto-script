/**
 * 读取 process.env：空字符串与非法数值回退默认，避免 Number("")→0 等误行为。
 */

/** @param {string} key */
export function envRaw(key) {
  const v = process.env[key];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * @param {string} key
 * @param {boolean} defaultOn
 */
export function envBool(key, defaultOn) {
  const v = envRaw(key);
  if (v === null) return defaultOn;
  const low = v.toLowerCase();
  if (["0", "false", "no", "off"].includes(low)) return false;
  if (["1", "true", "yes", "on"].includes(low)) return true;
  return defaultOn;
}

/**
 * @param {string} key
 * @param {number} defaultVal
 * @param {{ min?: number, max?: number }} [bounds]
 */
export function envInt(key, defaultVal, bounds = {}) {
  const v = envRaw(key);
  let n = defaultVal;
  if (v !== null) {
    const parsed = Number(v);
    n = Number.isFinite(parsed) ? parsed : defaultVal;
  }
  if (bounds.min !== undefined) n = Math.max(bounds.min, n);
  if (bounds.max !== undefined) n = Math.min(bounds.max, n);
  return n;
}

/**
 * @param {string} key
 * @param {string} defaultVal
 * @param {string[]} [allowedLower]
 */
export function envStr(key, defaultVal, allowedLower = null) {
  const v = envRaw(key);
  if (v === null) return defaultVal;
  const low = v.toLowerCase();
  if (allowedLower && !allowedLower.includes(low)) return defaultVal;
  return v;
}
