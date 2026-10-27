/**
 * Telegram 信号全链路日志（collect:ui 侧：归档 → 推 TG → CDP）。
 */
export const PIPELINE_TAG = "[signal-pipeline]";
export const SEND_CDP_TAG = "[send-cdp]";

/**
 * @param {string} stage
 * @param {Record<string, unknown>} [fields]
 */
export function formatPipelineLog(stage, fields = {}) {
  const parts = [PIPELINE_TAG, `stage=${stage}`];
  for (const key of [
    "cardId",
    "channelId",
    "channelName",
    "symbol",
    "direction",
    "sourceRef",
    "messageRef",
    "event",
    "reason",
    "detail",
    "jobId",
    "chatId",
  ]) {
    const val = fields[key];
    if (val == null || val === "") continue;
    parts.push(`${key}=${val}`);
  }
  return parts.join(" ");
}

/**
 * @param {string} stage
 * @param {Record<string, unknown>} [fields]
 */
export function formatSendCdpLog(stage, fields = {}) {
  return `${SEND_CDP_TAG} ${formatPipelineLog(stage, fields).slice(PIPELINE_TAG.length + 1)}`;
}
