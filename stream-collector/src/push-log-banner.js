/** @type {string} */
export const PUSH_LOG_BANNER = "=========================================";

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {"info" | "warn" | "error"} level
 * @param {string} headline
 * @param {string[]} bodyLines
 */
export function logPushBanner(log, level, headline, bodyLines) {
  const lines = [PUSH_LOG_BANNER, headline, ...bodyLines, PUSH_LOG_BANNER];
  const text = lines.join("\n");
  if (level === "warn") log.warn(text);
  else if (level === "error") log.error(text);
  else log.info(text);
}
