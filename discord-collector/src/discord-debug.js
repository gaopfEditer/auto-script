/**
 * Debug 模式：默认开，全量 WS/API；关闭后日志与 UI 推送精简摘要。
 */

function envBool(name, defaultOn = true) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return defaultOn;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/** @type {boolean} */
let debugMode = envBool("DISCORD_DEBUG_MODE", true);

export function isDebugMode() {
  return debugMode;
}

/** @param {boolean} on */
export function setDebugMode(on) {
  debugMode = Boolean(on);
}

export function getDebugConfig() {
  return { debugMode };
}

/** @param {unknown} obj @param {number} [max] */
export function stringifyForLog(obj, max = 12000) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(obj).slice(0, max);
  }
}
