/**
 * Show 页布局（置顶频道等）服务端存储：本地客户端写入，域名客户端首读。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(__dirname, "..", "data", "show-layout.json");

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeShowLayout(raw) {
  const o = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, unknown>} */
  const out = { v: 1 };

  if (o.channelAliases && typeof o.channelAliases === "object") {
    /** @type {Record<string, string>} */
    const aliases = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (o.channelAliases))) {
      if (typeof v === "string" && v.trim()) aliases[String(k)] = v.trim();
    }
    out.channelAliases = aliases;
  }

  if (o.pinnedChannelsByGuild && typeof o.pinnedChannelsByGuild === "object") {
    /** @type {Record<string, string[]>} */
    const pins = {};
    for (const [k, v] of Object.entries(
      /** @type {Record<string, unknown>} */ (o.pinnedChannelsByGuild)
    )) {
      if (!Array.isArray(v)) continue;
      const ids = v.map((id) => String(id ?? "").trim()).filter(Boolean);
      if (ids.length) pins[String(k)] = ids;
    }
    out.pinnedChannelsByGuild = pins;
  }

  if (o.channelGroupsByGuild && typeof o.channelGroupsByGuild === "object") {
    out.channelGroupsByGuild = o.channelGroupsByGuild;
  }

  if (o.ungroupedOrderByGuild && typeof o.ungroupedOrderByGuild === "object") {
    /** @type {Record<string, string[]>} */
    const orders = {};
    for (const [k, v] of Object.entries(
      /** @type {Record<string, unknown>} */ (o.ungroupedOrderByGuild)
    )) {
      if (!Array.isArray(v)) continue;
      const ids = v.map((id) => String(id ?? "").trim()).filter(Boolean);
      if (ids.length) orders[String(k)] = ids;
    }
    out.ungroupedOrderByGuild = orders;
  }

  if (o.selectedGuildId) out.selectedGuildId = String(o.selectedGuildId);
  if (o.selectedChannel && typeof o.selectedChannel === "object") {
    out.selectedChannel = o.selectedChannel;
  }

  return out;
}

/**
 * @param {{ filePath?: string }} [opts]
 */
export function createShowLayoutStore(opts = {}) {
  const filePath = opts.filePath || DEFAULT_FILE;

  async function ensureDir() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  return {
    filePath,
    /** @returns {Promise<{ layout: Record<string, unknown>, updatedAt: number | null }>} */
    async read() {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const updatedAt =
          typeof parsed?.updatedAt === "number"
            ? parsed.updatedAt
            : Number(parsed?.savedAt) || null;
        const layout = normalizeShowLayout(parsed?.layout ?? parsed);
        return { layout, updatedAt };
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") {
          return { layout: { v: 1 }, updatedAt: null };
        }
        throw e;
      }
    },
    /**
     * @param {unknown} layoutRaw
     * @returns {Promise<{ layout: Record<string, unknown>, updatedAt: number }>}
     */
    async write(layoutRaw) {
      const layout = normalizeShowLayout(layoutRaw);
      const updatedAt = Date.now();
      await ensureDir();
      const payload = { v: 1, updatedAt, layout };
      await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      return { layout, updatedAt };
    },
  };
}
