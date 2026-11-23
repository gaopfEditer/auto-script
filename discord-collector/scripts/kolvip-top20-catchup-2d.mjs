#!/usr/bin/env node
/**
 * 胜率榜前 20 频道 · 近 N 天 kolvip HTTP catchup + 建卡。
 * 用法: node scripts/kolvip-top20-catchup-2d.mjs [--base=http://127.0.0.1:3851] [--days=30]
 */
import { config } from "../src/config.js";
import { getKolvipEvalRankedChannelIds } from "../src/kolvip-eval-channels.js";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--(\w+)=(.+)$/);
    return m ? [[m[1], m[2]]] : [];
  }),
);
const BASE = String(args.base ?? process.env.COLLECTOR_URL ?? "http://127.0.0.1:3851").replace(
  /\/$/,
  "",
);
const defaultDays = config.kolvipCardIngestDays ?? 30;
const DAYS = Math.min(90, Math.max(1, Number(args.days ?? defaultDays) || defaultDays));
const cutoffMs = Date.now() - DAYS * 86_400_000;

async function catchupChannel(channelId) {
  let beforeId = 0;
  let pages = 0;
  let totalFetched = 0;
  let totalCards = 0;
  const maxPages = Math.min(120, Math.max(10, Math.ceil(DAYS * 3)));

  while (pages < maxPages) {
    /** @type {Record<string, unknown>} */
    const body = { channelId, limit: 80, force: true };
    if (beforeId > 0) body.beforeId = beforeId;
    const res = await fetch(`${BASE}/api/kolvip/channels/catchup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      return { channelId, ok: false, error: j.error || res.statusText, pages, totalFetched, totalCards };
    }
    if (j.skipped) {
      return { channelId, ok: true, skipped: true, reason: j.reason, pages, totalFetched, totalCards };
    }
    const fetched = Number(j.fetched) || 0;
    totalFetched += fetched;
    totalCards += Number(j.cardsCreated) || 0;
    pages += 1;
    const oldest = Number(j.oldestAtMs) || 0;
  const next = Number(j.nextBeforeId) || 0;
    if (!fetched) break;
    if (oldest && oldest < cutoffMs) break;
    if (!next || next === beforeId) break;
    beforeId = next;
    await new Promise((r) => setTimeout(r, 350));
  }
  return { channelId, ok: true, pages, totalFetched, totalCards };
}

const ranked = getKolvipEvalRankedChannelIds();
console.log(`kolvip top${ranked.length} · ${DAYS}d · ${BASE}`);
/** @type {Record<string, unknown>[]} */
const results = [];
for (let i = 0; i < ranked.length; i++) {
  const id = ranked[i];
  const name = config.discordShowSidebar?.namesByChannelId?.[id] ?? id;
  process.stdout.write(`[${i + 1}/${ranked.length}] ${name} … `);
  try {
    const out = await catchupChannel(id);
    results.push(out);
    console.log(
      out.skipped
        ? `skip ${out.reason}`
        : `pages=${out.pages} fetched=${out.totalFetched} cards+${out.totalCards}`,
    );
  } catch (e) {
    console.log(`ERR ${e instanceof Error ? e.message : e}`);
    results.push({ channelId: id, ok: false, error: String(e) });
  }
}
const ok = results.filter((r) => r.ok !== false).length;
console.log(`done ok=${ok}/${ranked.length}`);
process.exit(ok === ranked.length ? 0 : 1);