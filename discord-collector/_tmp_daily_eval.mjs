import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { archiveCardToClient, resolveCardChannelName } from "./src/card-archive-service.js";
import { aggregateMetrics, classifyCardEval } from "./src/card-eval-api.js";

dotenv.config();

const FROM_MS = 1795104000000;
const TO_MS = 1795190400000;
const DAY = "2026-11-20";

function isoToMysqlDatetime3(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 23).replace("T", " ");
  return d.toISOString().slice(0, 23).replace("T", " ");
}

function naiveToMs(str, as) {
  if (!str) return NaN;
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return NaN;
  const msFrac = (m[7] || "0").padEnd(3, "0").slice(0, 3);
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +msFrac);
  if (as === "utc") return utc;
  return utc - 8 * 3600 * 1000;
}

function shanghaiYmd(ms) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date(ms));
}

function shanghaiFmt(ms) {
  if (!Number.isFinite(ms)) return null;
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return parts.year + "-" + parts.month + "-" + parts.day + " " + parts.hour + ":" + parts.minute + ":" + parts.second;
}

function sourceBucket(sourceType) {
  const s = String(sourceType || "").toLowerCase();
  if (s.includes("kolvip")) return "kolvip";
  if (s.includes("telegram") || s.includes("tg")) return "telegram";
  if (s.includes("binance")) return "binance";
  if (s.includes("discord")) return "discord";
  return s || "unknown";
}

function isPlaceholderSymbol(sym) {
  const s = String(sym || "").trim();
  return !s || s === "待补充" || s.includes("待补充");
}

const officialFrom = isoToMysqlDatetime3(new Date(FROM_MS).toISOString());
const officialTo = isoToMysqlDatetime3(new Date(TO_MS).toISOString());

const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE ?? "discord_collector",
  waitForConnections: true,
  connectionLimit: 2,
  timezone: "Z",
  dateStrings: true,
  charset: "utf8mb4",
});

try {
  const [[tz]] = await pool.query(
    "SELECT NOW() AS now_local, UTC_TIMESTAMP() AS now_utc, @@session.time_zone AS session_tz, @@global.time_zone AS global_tz, @@system_time_zone AS system_tz"
  );
  const [rows] = await pool.query(
    "SELECT sc.*, dc.name AS channel_name, dm.created_at_ms AS message_created_at_ms, " +
    "DATE_FORMAT(sc.created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at_str, " +
    "DATE_FORMAT(sc.signal_at, '%Y-%m-%d %H:%i:%s.%f') AS signal_at_str " +
    "FROM discord_signal_cards sc " +
    "LEFT JOIN discord_channels dc ON dc.channel_id = sc.channel_id " +
    "LEFT JOIN discord_messages dm ON dm.message_id = sc.message_id " +
    "WHERE (sc.created_at >= '2026-11-19 00:00:00' AND sc.created_at < '2026-11-21 16:00:00') " +
    "   OR (sc.signal_at  >= '2026-11-19 00:00:00' AND sc.signal_at  < '2026-11-21 16:00:00') " +
    "ORDER BY sc.id DESC LIMIT 2000"
  );

  const officialRows = [];
  const createdLocalDay = [];
  const createdUtcAsShanghaiDay = [];

  for (const row of rows) {
    const createdStr = row.created_at_str || row.created_at;
    const signalStr = row.signal_at_str || row.signal_at;
    const evalKey = signalStr || createdStr;
    const officialHit = !!(evalKey && evalKey >= officialFrom && evalKey <= officialTo);
    const createdLocalMs = naiveToMs(createdStr, "shanghai");
    const createdUtcMs = naiveToMs(createdStr, "utc");
    const inLocalDay = Number.isFinite(createdLocalMs) && shanghaiYmd(createdLocalMs) === DAY;
    const inUtcAsShDay = Number.isFinite(createdUtcMs) && shanghaiYmd(createdUtcMs) === DAY;
    let card = null;
    try { card = archiveCardToClient(row); } catch (e) { card = { _err: String(e && e.message ? e.message : e) }; }
    const rec = { row, card, officialHit, inLocalDay, inUtcAsShDay, createdStr, signalStr, createdLocalMs, createdUtcMs };
    if (officialHit) officialRows.push(rec);
    if (inLocalDay) createdLocalDay.push(rec);
    if (inUtcAsShDay) createdUtcAsShanghaiDay.push(rec);
  }

  function summarize(list, label) {
    const cards = list.map((x) => x.card).filter((c) => c && !c._err);
    const metrics = aggregateMetrics(cards);
    let notEntered = 0, placeholder = 0, entered = 0;
    const byChannel = new Map();
    const settled = [];
    for (const rec of list) {
      const card = rec.card;
      if (!card || card._err) continue;
      const c = classifyCardEval(card);
      const name = card.channelName || resolveCardChannelName(card.channelId, card.channelName) || "未映射";
      const src = sourceBucket(card.sourceType);
      if (!byChannel.has(name)) byChannel.set(name, { total: 0, sources: {} });
      const g = byChannel.get(name);
      g.total += 1;
      g.sources[src] = (g.sources[src] || 0) + 1;
      if (isPlaceholderSymbol(card.symbol)) placeholder += 1;
      if (!c.entered) notEntered += 1;
      else entered += 1;
      if (c.entered && (c.outcome === "take_profit" || c.outcome === "stop_loss")) {
        settled.push({
          id: card.id,
          symbol: card.symbol,
          channel: name,
          sourceType: card.sourceType,
          outcome: c.outcome,
          pnlPct: c.pnlPct,
          created: rec.createdStr,
          createdUtcAsSh: shanghaiFmt(rec.createdUtcMs),
          createdLocalAsSh: shanghaiFmt(rec.createdLocalMs),
        });
      }
    }
    const top = [...byChannel.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 8)
      .map(([name, g]) => ({ name, total: g.total, sources: g.sources }));
    return { label, total: list.length, parseOk: cards.length, entered, notEntered, placeholder, metrics, top, settled };
  }

  const out = {
    nowJs: new Date().toISOString(),
    tzJs: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    mysql: tz,
    officialBounds: { officialFrom, officialTo, FROM_MS, TO_MS },
    wideRowCount: rows.length,
    summaries: [
      summarize(createdUtcAsShanghaiDay, "created_at stored-as-UTC interpreted in Asia/Shanghai day"),
      summarize(createdLocalDay, "created_at stored-as-Shanghai local day"),
      summarize(officialRows, "official eval window COALESCE(signal_at,created_at) UTC-naive (API)"),
    ],
    recentSamples: rows.slice(0, 8).map((row) => ({
      id: row.id,
      symbol: row.symbol,
      source_type: row.source_type,
      channel_name: row.channel_name,
      created_at_str: row.created_at_str,
      signal_at_str: row.signal_at_str,
      created_utc_as_sh: shanghaiFmt(naiveToMs(row.created_at_str || row.created_at, "utc")),
      created_local_as_sh: shanghaiFmt(naiveToMs(row.created_at_str || row.created_at, "shanghai")),
    })),
  };
  console.log(JSON.stringify(out, null, 2));
} finally {
  await pool.end();
}
