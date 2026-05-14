/**
 * 按库中顺序模拟流式推送，供回测引擎消费。
 * @param {{
 *   rows: { id: number, received_at: string, parsed_json: string }[],
 *   baseDelayMs: number,
 *   speedMultiplier: number,
 *   onFrame: (obj: object, meta: { id: number, received_at: string }) => Promise<void>|void,
 *   onProgress?: (current: number, total: number) => void,
 * }} opts
 */
export async function runReplayScheduler(opts) {
  const delay = Math.max(0, opts.baseDelayMs / Math.max(0.0001, opts.speedMultiplier));
  const total = opts.rows.length;
  let idx = 0;
  for (const row of opts.rows) {
    idx += 1;
    opts.onProgress?.(idx, total);
    let obj;
    try {
      obj = JSON.parse(row.parsed_json);
    } catch {
      continue;
    }
    await opts.onFrame(obj, { id: row.id, received_at: row.received_at });
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}
