#!/usr/bin/env node
/**
 * MAIN 群卡片推送胜率日报（供 Grok Bot / cron 正午调用）
 *
 * 需 collect:ui 已启动（默认 http://127.0.0.1:3851）。
 *
 * 用法：
 *   node scripts/main-card-telegram-digest.mjs
 *   node scripts/main-card-telegram-digest.mjs --window=today
 *   node scripts/main-card-telegram-digest.mjs --day-offset=-1 --json
 *   CARDS_API_KEY=xxx node scripts/main-card-telegram-digest.mjs --v1
 *
 * 默认 --window=last_shanghai_day（上一上海自然日 telegram_sent_at），
 * 便于 12:00 推送前一日信号的结算胜率。
 */
const BASE = (process.env.COLLECTOR_UI_URL ?? "http://127.0.0.1:3851").replace(/\/$/, "");
const API_KEY = process.env.CARDS_API_KEY ?? "Gpf123456";
const useV1 = process.argv.includes("--v1");
const wantJson = process.argv.includes("--json");

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

function headers() {
  const h = { Accept: "application/json" };
  if (API_KEY) h["X-Cards-Api-Key"] = API_KEY;
  return h;
}

async function main() {
  const params = new URLSearchParams();
  const window = arg("--window", "last_shanghai_day");
  if (window) params.set("window", window);
  const dayOffset = arg("--day-offset", "");
  if (dayOffset !== "") params.set("dayOffset", dayOffset);
  const chatId = arg("--chat-id", "");
  if (chatId) params.set("chatId", chatId);

  const path = useV1 ? "/api/v1/cards/digest/main-telegram" : "/api/cards/digest/main-telegram";
  const url = `${BASE}${path}?${params}`;
  const res = await fetch(url, { headers: headers() });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.error(`非 JSON (${res.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }
  if (!res.ok || !body.ok) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  if (wantJson) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (body.warnings?.length) {
    for (const w of body.warnings) console.warn(`[!] ${w}`);
  }
  console.log(body.summaryZh ?? "");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
