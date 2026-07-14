/** @typedef {Record<string, unknown>} BitgetPreview */

/** @param {string} symbol @param {{ orderSizeUsdt?: number; leverage?: number }} [opts] */
export async function fetchBitgetPreview(symbol, opts = {}) {
  const params = new URLSearchParams({ symbol: symbol.trim() });
  if (opts.orderSizeUsdt != null && opts.orderSizeUsdt > 0) {
    params.set("orderSizeUsdt", String(opts.orderSizeUsdt));
  }
  if (opts.leverage != null && opts.leverage > 0) {
    params.set("leverage", String(opts.leverage));
  }
  const res = await fetch(`/api/bitget/preview?${params.toString()}`);
  return /** @type {BitgetPreview & { ok?: boolean; error?: string }>} */ (await res.json());
}

/** @param {Record<string, unknown>} body */
export async function placeBitgetOrder(body) {
  const res = await fetch("/api/bitget/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return /** @type {Record<string, unknown>} */ (await res.json());
}

/** @param {{ limit?: number; symbol?: string; exchange?: boolean }} [opts] */
export async function fetchBitgetOrders(opts = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.symbol) params.set("symbol", opts.symbol);
  if (opts.exchange === false) params.set("exchange", "0");
  const qs = params.toString();
  const res = await fetch(`/api/bitget/orders${qs ? `?${qs}` : ""}`);
  return /** @type {{ ok: boolean; local: Record<string, unknown>[]; exchange: Record<string, unknown>[]; dryRun?: boolean }} */ (
    await res.json()
  );
}

export async function fetchBitgetStatus() {
  const res = await fetch("/api/bitget/status");
  return /** @type {Record<string, unknown>} */ (await res.json());
}
