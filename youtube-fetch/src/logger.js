const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** @param {string} level */
export function setLogLevel(level) {
  globalThis.__ytFetchLogLevel = LEVELS[level] ?? LEVELS.info;
}

function shouldLog(level) {
  const cur = globalThis.__ytFetchLogLevel ?? LEVELS.info;
  return (LEVELS[level] ?? LEVELS.info) >= cur;
}

/**
 * @param {string} tag
 */
export function createLogger(tag) {
  const prefix = `[youtube-fetch:${tag}]`;
  return {
    debug: (/** @type {string} */ msg) => shouldLog("debug") && console.debug(prefix, msg),
    info: (/** @type {string} */ msg) => shouldLog("info") && console.info(prefix, msg),
    warn: (/** @type {string} */ msg) => shouldLog("warn") && console.warn(prefix, msg),
    error: (/** @type {string} */ msg) => shouldLog("error") && console.error(prefix, msg),
  };
}
