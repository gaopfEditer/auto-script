/**
 * 轻量日志：时间戳 + 级别 + 可选 scope。
 * 环境变量 LOG_LEVEL: silent | error | warn | info | debug（默认 info）
 */

const LEVEL_NUM = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function parseLevel(raw) {
  const k = String(raw ?? "info").toLowerCase();
  return LEVEL_NUM[k] !== undefined ? LEVEL_NUM[k] : LEVEL_NUM.info;
}

let minLevel = parseLevel(process.env.LOG_LEVEL);

/** @param {string} [level] */
export function setLogLevel(level) {
  minLevel = parseLevel(level);
}

/** 北京时间 ISO 风格：2026-05-31T16:05:22.312+08:00 */
function nowBeijingIso() {
  const d = new Date(Date.now() + 8 * 3_600_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${y}-${mo}-${day}T${h}:${mi}:${s}.${ms}+08:00`;
}

function emit(level, scope, msg, args) {
  if (LEVEL_NUM[level] > minLevel) return;
  const scopeStr = scope ? `[${scope}] ` : "";
  const line = `${nowBeijingIso()} ${level.toUpperCase().padEnd(5)} ${scopeStr}${msg}`;
  if (level === "error") {
    console.error(line, ...args);
  } else if (level === "warn") {
    console.warn(line, ...args);
  } else {
    console.log(line, ...args);
  }
}

/**
 * @param {string} [scope]
 */
export function createLogger(scope = "") {
  return {
    debug: (msg, ...args) => emit("debug", scope, msg, args),
    info: (msg, ...args) => emit("info", scope, msg, args),
    warn: (msg, ...args) => emit("warn", scope, msg, args),
    error: (msg, ...args) => emit("error", scope, msg, args),
  };
}
