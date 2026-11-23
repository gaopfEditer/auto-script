/**
 * 币安广场帖子 → operate 本地 signal_cards.db 中的博主 handle（回填展示名）。
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

import { config } from "./config.js";
import { isPlaceholderChannelLabel } from "./kolvip-channel-display.js";

/** @type {Map<string, string>} */
const cache = new Map();

/**
 * @param {string} postId
 * @returns {string}
 */
export function lookupOperateBinanceAuthor(postId) {
  const id = String(postId ?? "").trim();
  if (!id) return "";
  if (cache.has(id)) return cache.get(id) ?? "";
  const db = config.operateSignalCardsDb;
  if (!db || !existsSync(db)) return "";

  const safeId = id.replace(/'/g, "''");
  try {
    const out = execSync(
      `sqlite3 ${JSON.stringify(db)} "SELECT COALESCE(NULLIF(trim(user_handle),''), trim(replace(author,'@',''))) FROM signal_cards WHERE tweet_id='${safeId}' LIMIT 1;"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const name = out.replace(/^@/, "").trim();
    const val = name && !isPlaceholderChannelLabel(name) ? name : "";
    cache.set(id, val);
    return val;
  } catch {
    cache.set(id, "");
    return "";
  }
}