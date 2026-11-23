/**
 * 博主胜率（巨鲸 /webu/sig/*）本地镜像：rank、blogger、detail。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const KOLVIP_SIG_DATA_DIR = path.join(__dirname, "..", "data", "kolvip-sig");

/** @type {readonly string[]} */
export const KOLVIP_SIG_RANGES = ["7", "30", "all"];

/**
 * @param {string} name
 */
export function kolvipSigBloggerKey(name) {
  return encodeURIComponent(String(name || "").trim() || "_");
}

/**
 * @param {string} range
 */
function rankPath(range) {
  return path.join(KOLVIP_SIG_DATA_DIR, `rank-${range}.json`);
}

/**
 * @param {string} name
 * @param {string} range
 */
function bloggerPath(name, range) {
  return path.join(KOLVIP_SIG_DATA_DIR, "blogger", kolvipSigBloggerKey(name), `${range}.json`);
}

/**
 * @param {string|number} id
 */
function detailPath(id) {
  return path.join(KOLVIP_SIG_DATA_DIR, "detail", `${String(id)}.json`);
}

const META_PATH = path.join(KOLVIP_SIG_DATA_DIR, "meta.json");

async function ensureDirs() {
  await fs.mkdir(path.join(KOLVIP_SIG_DATA_DIR, "blogger"), { recursive: true });
  await fs.mkdir(path.join(KOLVIP_SIG_DATA_DIR, "detail"), { recursive: true });
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadKolvipSigMeta() {
  try {
    const raw = await fs.readFile(META_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { note: "尚未同步；POST /api/kolvip/sig/sync" };
  }
}

/**
 * @param {Record<string, unknown>} patch
 */
export async function saveKolvipSigMeta(patch) {
  await ensureDirs();
  const prev = await loadKolvipSigMeta();
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  await fs.writeFile(META_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * @param {string} range
 * @param {unknown} data
 */
export async function saveKolvipSigRank(range, data) {
  await ensureDirs();
  const p = rankPath(range);
  await fs.writeFile(
    p,
    `${JSON.stringify({ range, syncedAt: new Date().toISOString(), data }, null, 2)}\n`,
    "utf8"
  );
}

/**
 * @param {string} range
 */
export async function loadKolvipSigRank(range) {
  try {
    const raw = await fs.readFile(rankPath(range), "utf8");
    const j = JSON.parse(raw);
    return j?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} name
 * @param {string} range
 * @param {unknown} data
 */
export async function saveKolvipSigBlogger(name, range, data) {
  await ensureDirs();
  const p = bloggerPath(name, range);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(
    p,
    `${JSON.stringify({ name, range, syncedAt: new Date().toISOString(), data }, null, 2)}\n`,
    "utf8"
  );
}

/**
 * @param {string} name
 * @param {string} range
 */
export async function loadKolvipSigBlogger(name, range) {
  try {
    const raw = await fs.readFile(bloggerPath(name, range), "utf8");
    const j = JSON.parse(raw);
    return j?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string|number} id
 * @param {unknown} data
 */
export async function saveKolvipSigDetail(id, data) {
  await ensureDirs();
  await fs.writeFile(
    detailPath(id),
    `${JSON.stringify({ id: String(id), syncedAt: new Date().toISOString(), data }, null, 2)}\n`,
    "utf8"
  );
}

/**
 * @param {string|number} id
 */
export async function loadKolvipSigDetail(id) {
  try {
    const raw = await fs.readFile(detailPath(id), "utf8");
    const j = JSON.parse(raw);
    return j?.data ?? null;
  } catch {
    return null;
  }
}