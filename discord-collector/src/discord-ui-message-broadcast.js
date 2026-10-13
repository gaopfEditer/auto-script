/**
 * Show / WS：合并短时间内的 discord_message_batch，降低前端列表抖动。
 */

/** @param {Record<string, unknown>} row */
function rowKey(row) {
  return String(row.messageId ?? row.message_id ?? "");
}

/** @param {Record<string, unknown>} ch */
function channelKey(ch) {
  return String(ch.channelId ?? ch.channel_id ?? "");
}

/**
 * @param {(channel: string, payload: Record<string, unknown>) => void} broadcast
 * @param {number} debounceMs
 */
export function createDebouncedDiscordMessageBroadcast(broadcast, debounceMs) {
  const waitMs = Math.max(200, debounceMs);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let firstAt = 0;
  /** @type {Map<string, Record<string, unknown>>} */
  const rowsById = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const channelsById = new Map();
  /** @type {Record<string, unknown>} */
  let envelope = { kind: "discord_message_batch", channel: "message" };
  let insertedSum = 0;

  function flush() {
    timer = null;
    firstAt = 0;
    if (!rowsById.size && !channelsById.size) return;
    const payload = {
      ...envelope,
      count: insertedSum,
      rows: [...rowsById.values()],
      channels: [...channelsById.values()],
    };
    rowsById.clear();
    channelsById.clear();
    insertedSum = 0;
    envelope = { kind: "discord_message_batch", channel: "message" };
    broadcast?.("message", payload);
  }

  function schedule() {
    const now = Date.now();
    if (!firstAt) firstAt = now;
    const maxWait = waitMs * 2;
    const delay =
      now - firstAt >= maxWait ? 0 : waitMs;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  /** @param {Record<string, unknown>} payload */
  function push(payload) {
    if (!broadcast) return;
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    insertedSum += Number(payload.count) || 0;
    envelope = {
      ...envelope,
      ...payload,
      rows: undefined,
      channels: undefined,
      count: undefined,
    };
    for (const r of rows) {
      const k = rowKey(r);
      if (k) rowsById.set(k, r);
    }
    for (const c of channels) {
      const k = channelKey(c);
      if (k) channelsById.set(k, c);
    }
    schedule();
  }

  function dispose() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    rowsById.clear();
    channelsById.clear();
    insertedSum = 0;
    firstAt = 0;
  }

  return { push, flush, dispose };
}
