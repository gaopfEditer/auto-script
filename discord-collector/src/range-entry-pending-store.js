/**
 * 区间入场待触发任务持久化。进程重启后只恢复 status=waiting，不扫描历史卡片。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rangeEntryKey } from "./range-entry-policy.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));

export function defaultRangeEntryPendingPath() {
  return path.resolve(__dir, "..", "data", "range-entry-pending.json");
}

/**
 * @param {string} [filePath]
 */
export function createRangeEntryPendingStore(filePath) {
  const dest = path.resolve(String(filePath || defaultRangeEntryPendingPath()));

  /** @returns {{ version: number, updatedAt: string, items: Record<string, Record<string, unknown>> }} */
  function load() {
    try {
      const raw = fs.readFileSync(dest, "utf8");
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return empty();
      const items =
        obj.items && typeof obj.items === "object" && !Array.isArray(obj.items)
          ? /** @type {Record<string, Record<string, unknown>>} */ (obj.items)
          : {};
      return {
        version: 1,
        updatedAt: String(obj.updatedAt ?? ""),
        items,
      };
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err && err.code === "ENOENT") return empty();
      throw e;
    }
  }

  function empty() {
    return { version: 1, updatedAt: "", items: /** @type {Record<string, Record<string, unknown>>} */ ({}) };
  }

  /** @param {ReturnType<typeof load>} state */
  function save(state) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const next = {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: state.items,
    };
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, dest);
    return next;
  }

  /**
   * @param {Record<string, unknown>} item
   * @returns {Record<string, unknown> | null} 已存在的 waiting 项则返回它；新登记返回 null
   */
  function addWaiting(item) {
    const exchange = String(item.exchange ?? "");
    const cardId = Number(item.cardId);
    const key = String(item.key ?? rangeEntryKey(exchange, cardId));
    const state = load();
    const prev = state.items[key];
    if (prev && String(prev.status) === "waiting") {
      return prev;
    }
    const now = new Date().toISOString();
    state.items[key] = {
      ...item,
      key,
      status: "waiting",
      createdAt: String(item.createdAt ?? now),
      updatedAt: now,
    };
    save(state);
    return null;
  }

  /** @returns {Record<string, unknown>[]} */
  function listWaiting() {
    const state = load();
    return Object.values(state.items).filter((it) => String(it.status) === "waiting");
  }

  /**
   * @param {string} key
   * @param {Record<string, unknown>} patch
   */
  function update(key, patch) {
    const state = load();
    const prev = state.items[key];
    if (!prev) return null;
    const next = { ...prev, ...patch, key, updatedAt: new Date().toISOString() };
    state.items[key] = next;
    save(state);
    return next;
  }

  /**
   * @param {string} key
   * @param {string} status
   * @param {Record<string, unknown>} [patch]
   */
  function complete(key, status, patch = {}) {
    return update(key, { ...patch, status });
  }

  function get(key) {
    return load().items[key] ?? null;
  }

  return {
    path: dest,
    load,
    addWaiting,
    listWaiting,
    update,
    complete,
    get,
    key: rangeEntryKey,
  };
}
