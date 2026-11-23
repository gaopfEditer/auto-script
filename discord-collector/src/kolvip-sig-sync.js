/**
 * 从巨鲸 /webu/sig/* 拉取博主胜率并写入 data/kolvip-sig/。
 */
import { buildKolvipApiClient } from "./kolvip-api-fetch.js";
import {
  kolvipApiSigBlogger,
  kolvipApiSigDetail,
  kolvipApiSigRank,
} from "./kolvip-api-client.js";
import { createLogger } from "./logger.js";
import {
  KOLVIP_SIG_RANGES,
  loadKolvipSigMeta,
  saveKolvipSigBlogger,
  saveKolvipSigDetail,
  saveKolvipSigMeta,
  saveKolvipSigRank,
} from "./kolvip-sig-store.js";

const log = createLogger("kolvip-sig-sync");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {unknown} rankPayload
 * @returns {string[]}
 */
function namesFromRank(rankPayload) {
  if (!rankPayload || typeof rankPayload !== "object") return [];
  const list = /** @type {{ list?: unknown[] }} */ (rankPayload).list;
  if (!Array.isArray(list)) return [];
  /** @type {string[]} */
  const names = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const n = String(/** @type {{ name?: string }} */ (row).name ?? "").trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  return names;
}

/**
 * @param {{ bloggerDelayMs?: number, detailLimit?: number, ranges?: string[] }} [opts]
 */
export async function syncKolvipSigLocal(opts = {}) {
  const ranges = opts.ranges?.length ? opts.ranges : [...KOLVIP_SIG_RANGES];
  const bloggerDelayMs = Math.max(0, Number(opts.bloggerDelayMs) || 400);
  const detailLimit = Math.max(0, Number(opts.detailLimit) || 0);

  const { client, tokenSource } = await buildKolvipApiClient(log);
  /** @type {Record<string, string>} */
  const rankSyncedAt = {};
  /** @type {Set<string>} */
  const allNames = new Set();

  for (const range of ranges) {
    const data = await kolvipApiSigRank(client, range);
    await saveKolvipSigRank(range, data);
    rankSyncedAt[range] = new Date().toISOString();
    for (const n of namesFromRank(data)) allNames.add(n);
    log.info(`博主胜率 rank/${range} 已缓存 ${namesFromRank(data).length} 位博主`);
  }

  let bloggersDone = 0;
  const names = [...allNames].sort((a, b) => a.localeCompare(b, "zh"));
  for (const name of names) {
    for (const range of ranges) {
      if (bloggerDelayMs > 0) await sleep(bloggerDelayMs);
      try {
        const data = await kolvipApiSigBlogger(client, name, range);
        await saveKolvipSigBlogger(name, range, data);
        bloggersDone += 1;
      } catch (e) {
        log.warn(`博主 ${name} range=${range} 同步失败: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  let detailsDone = 0;
  if (detailLimit > 0) {
    const ref = await kolvipApiSigRank(client, "30");
    const ranked = namesFromRank(ref).slice(0, 3);
    for (const name of ranked) {
      if (bloggerDelayMs > 0) await sleep(bloggerDelayMs);
      let blogger;
      try {
        blogger = await kolvipApiSigBlogger(client, name, "30");
      } catch {
        continue;
      }
      const hist = Array.isArray(blogger?.history) ? blogger.history : [];
      for (const s of hist.slice(0, detailLimit)) {
        const id = s?.id;
        if (id == null) continue;
        if (bloggerDelayMs > 0) await sleep(bloggerDelayMs);
        try {
          const d = await kolvipApiSigDetail(client, id);
          await saveKolvipSigDetail(id, d);
          detailsDone += 1;
        } catch (e) {
          log.warn(`单子 detail ${id} 失败: ${/** @type {Error} */ (e).message}`);
        }
      }
    }
  }

  const meta = await saveKolvipSigMeta({
    source: "kolvip.vip /webu/sig/*",
    tokenSource,
    lastSyncAt: new Date().toISOString(),
    ranges: rankSyncedAt,
    bloggerSnapshots: bloggersDone,
    detailSnapshots: detailsDone,
    bloggerCount: names.length,
    note: "读取走本地 data/kolvip-sig；与线上面板同 API 口径（AI 喊单 + K 线结算）",
  });

  try {
    const { ensureKolvipEvalRankFromSig } = await import("./kolvip-eval-rank.js");
    await ensureKolvipEvalRankFromSig();
  } catch {
    /* /eval 榜仍可用 fallback */
  }

  return {
    ok: true,
    ...meta,
    bloggerCount: names.length,
    bloggersDone,
    detailsDone,
  };
}

/**
 * @param {number} intervalMs
 */
export function startKolvipSigPeriodicSync(intervalMs) {
  const ms = Math.max(60_000, Number(intervalMs) || 0);
  if (!ms) return () => {};
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const sync = await syncKolvipSigLocal({ bloggerDelayMs: 300, detailLimit: 0 });
      if (sync?.ok !== false) {
        const { ensureKolvipEvalRankFromSig } = await import("./kolvip-eval-rank.js");
        await ensureKolvipEvalRankFromSig();
      }
    } catch (e) {
      log.warn(`定时同步失败: ${/** @type {Error} */ (e).message}`);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void tick(), ms);
  void tick();
  return () => clearInterval(t);
}

export async function kolvipSigLocalStatus() {
  const meta = await loadKolvipSigMeta();
  return { ok: true, local: true, dataDir: "data/kolvip-sig", ...meta };
}