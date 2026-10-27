/**
 * Telegram #prom 检查 / 回测：按频道与时间拉卡片，组 signals 调 validate。
 */
import { requireLocalRequest } from "./local-request.js";
import { requireOpenApiKey } from "./card-archive-api.js";
import { createLogger } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("telegram-prom");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TELEGRAM_DIR = path.resolve(__dirname, "..", "..", "telegram");

function readMonitoredGroups() {
  const file = path.join(TELEGRAM_DIR, "monitored_groups.txt");
  /** @type {{ main: string[], monitored: string[], raw: string }} */
  const out = { main: [], monitored: [], raw: "" };
  try {
    if (!fs.existsSync(file)) return out;
    const text = fs.readFileSync(file, "utf8");
    out.raw = text;
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const m = s.match(/^(main_monitored|monitored)\s*=\s*(.+)$/i);
      if (!m) continue;
      const ids = m[2]
        .split(/[,;\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (/main/i.test(m[1])) out.main.push(...ids);
      else out.monitored.push(...ids);
    }
  } catch (e) {
    log.warn(`读 monitored_groups.txt 失败: ${/** @type {Error} */ (e).message}`);
  }
  return out;
}

/**
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 */
function cardToValidateSignal(card) {
  const ex =
    card.execution && typeof card.execution === "object"
      ? /** @type {Record<string, unknown>} */ (card.execution)
      : {};
  const planned =
    ex.planned && typeof ex.planned === "object"
      ? /** @type {Record<string, unknown>} */ (ex.planned)
      : {};
  const dirRaw = String(ex.direction ?? "").toLowerCase();
  const direction =
    /short|空/.test(dirRaw) ? "short" : /long|多/.test(dirRaw) ? "long" : "long";
  const entry = String(planned.entryPrice ?? card.symbol ?? "").trim();
  const entryMode =
    !entry || /市价|现价|market/i.test(entry) ? "market" : "limit";
  return {
    id: String(card.id ?? card.uid ?? ""),
    symbol: String(card.symbol ?? "").replace(/USDT$/i, ""),
    direction,
    signalAt: String(card.signalAt ?? card.createdAt ?? new Date().toISOString()),
    entry: entryMode === "limit" ? entry : undefined,
    entryMode,
    channelId: String(card.channelId ?? ""),
    channelName: String(card.channelName ?? ""),
  };
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./card-archive-list-cache.js").createCardArchiveListCache>} listCache
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 * @param {{ requireOpenApiKey?: import("express").RequestHandler }} [deps]
 */
export function registerTelegramPromRoutes(app, store, listCache, broadcast, deps = {}) {
  const openAuth = deps.requireOpenApiKey ?? requireOpenApiKey;

  function groupsHandler(_req, res) {
    const g = readMonitoredGroups();
    res.json({
      ok: true,
      main_monitored: [...new Set(g.main)],
      monitored: [...new Set(g.monitored)],
      note: "来自 telegram/monitored_groups.txt；建卡 channelId 通常为 tg 群 id 或 channel_profiles 映射",
    });
  }

  async function inspectHandler(req, res) {
    try {
      const q = { ...req.query, ...(req.body && typeof req.body === "object" ? req.body : {}) };
      const channelId = String(q.channelId ?? q.channel_id ?? "").trim();
      const fromRaw = q.from ?? q.from_ms;
      const toRaw = q.to ?? q.to_ms;
      const days = Number(q.days);
      let toMs = toRaw ? new Date(String(toRaw)).getTime() : Date.now();
      if (!Number.isFinite(toMs)) toMs = Date.now();
      let fromMs = fromRaw ? new Date(String(fromRaw)).getTime() : NaN;
      if (!Number.isFinite(fromMs) && Number.isFinite(days) && days > 0) {
        fromMs = toMs - days * 86400000;
      }
      if (!Number.isFinite(fromMs)) fromMs = toMs - 7 * 86400000;
      const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));

      const result = await listCache.list(
        {
          channelId: channelId || undefined,
          sourceTypes: ["telegram"],
          fromMs,
          toMs,
          limit,
          status: String(q.status ?? "active").trim() || undefined,
        },
        { force: true }
      );
      const cards = Array.isArray(result?.cards) ? result.cards : [];
      const promCards = cards.filter((c) => {
        const note = String(c.note ?? "");
        const body = String(c.rawContent ?? c.body ?? "");
        return note.includes("#prom") || /#prom\b/i.test(body);
      });
      const signals = (channelId ? cards : promCards.length ? promCards : cards)
        .map(cardToValidateSignal)
        .filter((s) => s.symbol);

      res.json({
        ok: true,
        fromMs,
        toMs,
        channelId: channelId || null,
        total: cards.length,
        promCount: promCards.length,
        cards,
        signals,
        hint: "signals 可直接 POST /api/v1/cards/validate 做真实 K 线回测",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  app.get("/api/telegram/prom/groups", requireLocalRequest, groupsHandler);
  app.get("/api/v1/telegram/prom/groups", openAuth, groupsHandler);
  app.get("/api/telegram/prom/inspect", requireLocalRequest, inspectHandler);
  app.post("/api/telegram/prom/inspect", requireLocalRequest, inspectHandler);
  app.get("/api/v1/telegram/prom/inspect", openAuth, inspectHandler);
  app.post("/api/v1/telegram/prom/inspect", openAuth, inspectHandler);
}
