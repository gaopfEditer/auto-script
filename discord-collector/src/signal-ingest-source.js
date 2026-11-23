/**
 * 跟单信号建卡互斥源：`kolvip`（默认）或 `discord`。
 * 环境变量：`SIGNAL_INGEST_SOURCE`（别名 `TRADER_SIGNAL_SOURCE`）。
 */

/** @typedef {'kolvip' | 'discord'} SignalIngestSource */

const ON = new Set(["1", "true", "yes", "on"]);

/**
 * @param {unknown} raw
 * @returns {SignalIngestSource}
 */
export function parseSignalIngestSource(raw) {
  const s = String(raw ?? "kolvip")
    .trim()
    .toLowerCase();
  if (s === "discord" || s === "dc" || s === "discord_only") return "discord";
  return "kolvip";
}

/** @param {NodeJS.ProcessEnv} [env] */
export function signalIngestSourceFromEnv(env = process.env) {
  const explicit =
    String(env.SIGNAL_INGEST_SOURCE ?? env.TRADER_SIGNAL_SOURCE ?? "").trim() || "kolvip";
  return parseSignalIngestSource(explicit);
}

/** @param {unknown} raw */
export function envTruthy(raw) {
  return ON.has(String(raw ?? "").trim().toLowerCase());
}

/** @param {SignalIngestSource} source */
export function isKolvipIngestSource(source) {
  return source === "kolvip";
}

/** @param {SignalIngestSource} source */
export function isDiscordIngestSource(source) {
  return source === "discord";
}