/**
 * Twitter 列表 CDP 轮询 + Telegram 推送。
 * 首次见到某列表只记 seen（不刷旧帖）；之后只推新帖。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createDiscordSignalTelegramPush } from "./discord-signal-telegram.js";
import {
  fetchTwitterListsViaCdp,
  parseTwitterListRefs,
  probeTwitterCdp,
  twitterTimeToIso,
} from "./twitter-cdp-fetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "data", "twitter-cdp.json");
const SEEN_FALLBACK_PATH = path.join(__dirname, "..", "data", "twitter-seen.json");
const TELEGRAM_TEXT_MAX = 3900;

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function createTwitterCdpService(store, log, broadcast) {
  const telegram = createDiscordSignalTelegramPush(log);

  /** @type {{
   *   enabled: boolean,
   *   telegram: boolean,
   *   host: string,
   *   port: number,
   *   intervalMs: number,
   *   maxPerList: number,
   *   lists: Array<{ id: string, url: string, label: string, kind: string }>,
   * }} */
  let runtime = {
    enabled: config.twitterCdpEnabled,
    telegram: config.twitterCdpTelegram,
    host: config.twitterCdpHost,
    port: config.twitterCdpPort,
    intervalMs: config.twitterCdpIntervalMs,
    maxPerList: config.twitterCdpMaxPerList,
    lists: parseTwitterListRefs(config.twitterCdpLists),
  };

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let running = false;
  /** @type {Record<string, unknown> | null} */
  let lastRun = null;
  /** @type {string[]} */
  const logs = [];

  /** @param {string} msg */
  function pushLog(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    logs.unshift(line);
    if (logs.length > 80) logs.length = 80;
    log.info(msg);
  }

  async function loadPersisted() {
    try {
      const raw = await fs.readFile(CONFIG_PATH, "utf8");
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object") return;
      if (typeof j.enabled === "boolean") runtime.enabled = j.enabled;
      if (typeof j.telegram === "boolean") runtime.telegram = j.telegram;
      if (j.host) runtime.host = String(j.host);
      if (Number.isFinite(Number(j.port))) runtime.port = Number(j.port);
      if (Number.isFinite(Number(j.intervalMs))) {
        runtime.intervalMs = Math.max(30_000, Number(j.intervalMs));
      }
      if (Number.isFinite(Number(j.maxPerList))) {
        runtime.maxPerList = Math.min(50, Math.max(5, Number(j.maxPerList)));
      }
      if (Array.isArray(j.lists)) {
        const refs = parseTwitterListRefs(
          j.lists.map((x) => (typeof x === "string" ? x : x?.url || x?.id || ""))
        );
        if (refs.length) runtime.lists = refs;
      }
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") {
        log.warn(`读取 twitter-cdp.json: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  async function savePersisted() {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify(
        {
          enabled: runtime.enabled,
          telegram: runtime.telegram,
          host: runtime.host,
          port: runtime.port,
          intervalMs: runtime.intervalMs,
          maxPerList: runtime.maxPerList,
          lists: runtime.lists,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  async function loadFallbackSeen() {
    try {
      const raw = await fs.readFile(SEEN_FALLBACK_PATH, "utf8");
      const j = JSON.parse(raw);
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  /** @param {Record<string, unknown>} data */
  async function saveFallbackSeen(data) {
    await fs.mkdir(path.dirname(SEEN_FALLBACK_PATH), { recursive: true });
    await fs.writeFile(SEEN_FALLBACK_PATH, JSON.stringify(data), "utf8");
  }

  /**
   * @param {string} listId
   * @param {string[]} ids
   */
  async function existingIds(listId, ids) {
    if (store.offline || !store.findExistingTwitterTweetIds) {
      const all = await loadFallbackSeen();
      const bucket = all[listId] && typeof all[listId] === "object" ? all[listId] : {};
      const set = new Set(Array.isArray(bucket.ids) ? bucket.ids.map(String) : []);
      return new Set(ids.filter((id) => set.has(id)));
    }
    return store.findExistingTwitterTweetIds(ids);
  }

  /**
   * @param {string} listId
   */
  async function listHasHistory(listId) {
    if (store.offline || !store.countTwitterListTweets) {
      const all = await loadFallbackSeen();
      const bucket = all[listId] && typeof all[listId] === "object" ? all[listId] : {};
      return (Array.isArray(bucket.ids) ? bucket.ids.length : 0) > 0;
    }
    return (await store.countTwitterListTweets(listId)) > 0;
  }

  /**
   * @param {Array<{
   *   tweetId: string,
   *   listId: string,
   *   authorHandle?: string,
   *   authorName?: string,
   *   text?: string,
   *   tweetUrl?: string,
   *   tweetAt?: string | null,
   *   telegramSentAt?: string | null,
   * }>} rows
   */
  async function persistTweets(rows) {
    if (!rows.length) return;
    if (!store.offline && store.insertTwitterTweets) {
      await store.insertTwitterTweets(rows);
    }
    const all = await loadFallbackSeen();
    for (const r of rows) {
      const bucket =
        all[r.listId] && typeof all[r.listId] === "object"
          ? /** @type {{ ids: string[] }} */ (all[r.listId])
          : { ids: [] };
      if (!Array.isArray(bucket.ids)) bucket.ids = [];
      if (!bucket.ids.includes(r.tweetId)) {
        bucket.ids.push(r.tweetId);
        if (bucket.ids.length > 400) bucket.ids = bucket.ids.slice(-400);
      }
      all[r.listId] = bucket;
    }
    await saveFallbackSeen(all);
  }

  /**
   * @param {{ listLabel: string, handle: string, displayName: string, text: string, url: string, createdAt: string | null }} tweet
   */
  function formatTelegram(tweet) {
    const who = tweet.displayName
      ? `${tweet.displayName} (@${tweet.handle})`
      : `@${tweet.handle}`;
    const when = tweet.createdAt
      ? new Date(tweet.createdAt).toLocaleString("zh-CN", { hour12: false })
      : "";
    const body = [
      `【X 列表】${tweet.listLabel}`,
      who + (when ? ` · ${when}` : ""),
      tweet.text || "(无文字)",
      tweet.url,
    ].join("\n");
    return body.length <= TELEGRAM_TEXT_MAX
      ? body
      : `${body.slice(0, TELEGRAM_TEXT_MAX - 12)}\n…(截断)`;
  }

  async function probe() {
    return probeTwitterCdp(runtime.host, runtime.port);
  }

  /**
   * @param {{ force?: boolean }} [opts]
   */
  async function runOnce(opts = {}) {
    if (running) return { ok: false, skipped: "busy", lastRun };
    if (!runtime.lists.length) {
      const msg = "未配置列表（填写 x.com/i/lists/{id}）";
      lastRun = { at: new Date().toISOString(), ok: false, error: msg };
      return { ok: false, error: msg };
    }
    running = true;
    const started = Date.now();
    /** @type {Array<Record<string, unknown>>} */
    const listSummaries = [];
    /** @type {Array<Record<string, unknown>>} */
    const pushed = [];
    try {
      pushLog(
        `开始抓取 CDP ${runtime.host}:${runtime.port} lists=${runtime.lists.length}`
      );
      const batches = await fetchTwitterListsViaCdp({
        host: runtime.host,
        port: runtime.port,
        lists: runtime.lists,
        maxPerList: runtime.maxPerList,
        log,
      });

      for (const batch of batches) {
        const listId = batch.list.id;
        if (batch.error) {
          listSummaries.push({
            listId,
            label: batch.list.label,
            error: batch.error,
            fetched: 0,
            newCount: 0,
            seeded: false,
          });
          pushLog(`列表 ${batch.list.label} 失败: ${batch.error}`);
          continue;
        }
        const tweets = batch.tweets ?? [];
        const ids = tweets.map((t) => t.tweetId);
        const known = await existingIds(listId, ids);
        const hadHistory = await listHasHistory(listId);
        const fresh = hadHistory ? tweets.filter((t) => !known.has(t.tweetId)) : [];
        const seedAll = !hadHistory;

        const rows = (seedAll ? tweets : fresh).map((t) => ({
          tweetId: t.tweetId,
          listId,
          authorHandle: t.handle,
          authorName: t.displayName,
          text: t.text,
          tweetUrl: t.url,
          tweetAt: twitterTimeToIso(t.createdAt),
          telegramSentAt: null,
        }));
        await persistTweets(rows);

        let sent = 0;
        if (!seedAll && runtime.telegram && telegram.enabled) {
          for (const t of fresh) {
            const text = formatTelegram({
              listLabel: batch.list.label,
              handle: t.handle,
              displayName: t.displayName,
              text: t.text,
              url: t.url,
              createdAt: twitterTimeToIso(t.createdAt),
            });
            try {
              const r = await telegram.send(text, { skipChannelLabel: true, kind: "twitter_list" });
              if (!r.skipped) {
                sent += 1;
                pushed.push({
                  tweetId: t.tweetId,
                  listId,
                  handle: t.handle,
                  text: t.text,
                  url: t.url,
                });
              }
            } catch (e) {
              pushLog(`Telegram 失败 ${t.tweetId}: ${/** @type {Error} */ (e).message}`);
            }
          }
          if (sent && store.markTwitterTelegramSent) {
            await store.markTwitterTelegramSent(fresh.map((t) => t.tweetId));
          }
        } else if (seedAll) {
          pushLog(`列表 ${batch.list.label} 首次记档 ${tweets.length} 条（不推旧帖）`);
        }

        listSummaries.push({
          listId,
          label: batch.list.label,
          fetched: tweets.length,
          newCount: seedAll ? 0 : fresh.length,
          seeded: seedAll,
          telegramSent: sent,
        });
        if (!seedAll) {
          pushLog(
            `列表 ${batch.list.label} 最新 ${tweets.length} 新 ${fresh.length} TG ${sent}`
          );
        }
      }

      lastRun = {
        at: new Date().toISOString(),
        ok: true,
        ms: Date.now() - started,
        lists: listSummaries,
        pushed: pushed.length,
      };
      broadcast?.("meta", { kind: "twitter_cdp_run", ...lastRun });
      return { ok: true, ...lastRun };
    } catch (e) {
      const error = /** @type {Error} */ (e).message;
      lastRun = { at: new Date().toISOString(), ok: false, error };
      pushLog(`抓取失败: ${error}`);
      return { ok: false, error, lastRun };
    } finally {
      running = false;
      void opts;
    }
  }

  function schedule() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!runtime.enabled) return;
    timer = setInterval(() => {
      void runOnce().catch((e) =>
        log.warn(`Twitter CDP tick: ${/** @type {Error} */ (e).message}`)
      );
    }, runtime.intervalMs);
  }

  function getConfig() {
    return {
      ...runtime,
      telegramReady: telegram.enabled,
      telegramChatId: telegram.chatId || null,
      configPath: CONFIG_PATH,
    };
  }

  /**
   * @param {Partial<typeof runtime> & { listText?: string }} patch
   */
  async function updateConfig(patch) {
    if (typeof patch.enabled === "boolean") runtime.enabled = patch.enabled;
    if (typeof patch.telegram === "boolean") runtime.telegram = patch.telegram;
    if (patch.host) runtime.host = String(patch.host).trim() || "127.0.0.1";
    if (patch.port != null) {
      const p = Number(patch.port);
      if (Number.isFinite(p) && p > 0) runtime.port = p;
    }
    if (patch.intervalMs != null) {
      runtime.intervalMs = Math.max(30_000, Number(patch.intervalMs) || 120_000);
    }
    if (patch.maxPerList != null) {
      runtime.maxPerList = Math.min(50, Math.max(5, Number(patch.maxPerList) || 20));
    }
    if (typeof patch.listText === "string") {
      runtime.lists = parseTwitterListRefs(
        patch.listText.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
      );
    } else if (Array.isArray(patch.lists)) {
      runtime.lists = parseTwitterListRefs(
        patch.lists.map((x) => (typeof x === "string" ? x : x?.url || x?.id || ""))
      );
    }
    await savePersisted();
    schedule();
    pushLog(
      `配置已保存 port=${runtime.port} lists=${runtime.lists.length} interval=${Math.round(runtime.intervalMs / 1000)}s enabled=${runtime.enabled}`
    );
    return getConfig();
  }

  async function status() {
    const cdp = await probe();
    let tweets = [];
    if (store.listTwitterTweets) {
      tweets = await store.listTwitterTweets({ limit: 40 });
    }
    return {
      ok: true,
      running,
      lastRun,
      logs: logs.slice(0, 30),
      config: getConfig(),
      cdp,
      tweets,
    };
  }

  async function resetSeen(listId) {
    if (store.clearTwitterSeen) await store.clearTwitterSeen(listId);
    const all = await loadFallbackSeen();
    if (listId) delete all[listId];
    else {
      for (const k of Object.keys(all)) delete all[k];
    }
    await saveFallbackSeen(all);
    pushLog(listId ? `已清空列表 ${listId} 的 seen` : "已清空全部 seen");
    return { ok: true };
  }

  async function start() {
    await loadPersisted();
    schedule();
    pushLog(
      `Twitter CDP 已启动 port=${runtime.port} enabled=${runtime.enabled} lists=${runtime.lists.length}`
    );
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    runOnce,
    probe,
    getConfig,
    updateConfig,
    status,
    resetSeen,
  };
}
