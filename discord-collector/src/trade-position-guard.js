/**
 * 开仓前检查是否已有同 symbol（+ 可选同方向）持仓，避免重复开仓。
 */

/** @param {unknown} raw */
function unwrapWeexPositionRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.list)) return o.list;
    if ("symbol" in o) return [o];
  }
  return [];
}

/**
 * @param {ReturnType<typeof import("./weex-api.js").createWeexClient>} client
 * @param {{ symbol: string; holdSide?: string }} p
 */
export async function hasWeexSymbolExposure(client, p) {
  const symbol = String(p.symbol).toUpperCase();
  const wantSide = String(p.holdSide ?? "").toLowerCase();
  const sideAlts = new Set(
    wantSide === "long" || wantSide === "buy"
      ? ["long", "buy"]
      : wantSide === "short" || wantSide === "sell"
        ? ["short", "sell"]
        : []
  );

  const tryRows = (posResp) => {
    for (const row of unwrapWeexPositionRows(posResp)) {
      if (!row || typeof row !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (row);
      if (String(r.symbol ?? "").toUpperCase() !== symbol) continue;
      const total = Number(r.positionAmt ?? r.holdVol ?? r.size ?? r.quantity ?? r.total ?? 0);
      if (!(Math.abs(total) > 0)) continue;
      if (!sideAlts.size) return true;
      const hs = String(r.holdSide ?? r.positionSide ?? r.side ?? "").toLowerCase();
      if (!hs || sideAlts.has(hs) || (sideAlts.has("long") && hs === "buy") || (sideAlts.has("short") && hs === "sell"))
        return true;
    }
    return false;
  };

  try {
    if (tryRows(await client.getPositionList({ symbol }))) return true;
  } catch {
    /* try all */
  }

  try {
    return tryRows(await client.getPositionList({}));
  } catch {
    return false;
  }
}

export { hasBitgetSymbolExposure } from "./bitget-staged-order.js";