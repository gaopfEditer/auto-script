import {
  DEFAULT_COPY_SIZING_PARAMS,
  normalizeCopySizingParams,
} from "../../../src/telegram-copy-sizing.js";

const PARAMS_BY_CHAT_KEY = "telegram.copySizing.paramsByChat";
const LEGACY_PARAMS_KEY = "telegram.copySizing.params";

/** @returns {Record<string, import("../../../src/telegram-copy-sizing.js").CopySizingParams>} */
function readStore() {
  try {
    const raw = localStorage.getItem(PARAMS_BY_CHAT_KEY);
    if (!raw) return migrateLegacyIfNeeded();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    /** @type {Record<string, import("../../../src/telegram-copy-sizing.js").CopySizingParams>} */
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v === "object") out[String(k)] = normalizeCopySizingParams(v);
    }
    return out;
  } catch {
    return migrateLegacyIfNeeded();
  }
}

function writeStore(map) {
  try {
    localStorage.setItem(PARAMS_BY_CHAT_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota */
  }
}

/** @returns {Record<string, import("../../../src/telegram-copy-sizing.js").CopySizingParams>} */
function migrateLegacyIfNeeded() {
  /** @type {Record<string, import("../../../src/telegram-copy-sizing.js").CopySizingParams>} */
  const out = {};
  try {
    const raw = localStorage.getItem(LEGACY_PARAMS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        out.__default__ = normalizeCopySizingParams(parsed);
        writeStore(out);
        localStorage.removeItem(LEGACY_PARAMS_KEY);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** @param {string} chatId */
function chatKey(chatId) {
  const s = String(chatId ?? "").trim();
  return s || "__default__";
}

/** @returns {import("../../../src/telegram-copy-sizing.js").CopySizingParams} */
export function loadCopySizingParamsForChat(chatId) {
  const map = readStore();
  const key = chatKey(chatId);
  if (map[key]) return { ...map[key] };
  if (map.__default__) return { ...map.__default__ };
  return { ...DEFAULT_COPY_SIZING_PARAMS };
}

/**
 * @param {string} chatId
 * @param {Partial<import("../../../src/telegram-copy-sizing.js").CopySizingParams>} params
 */
export function saveCopySizingParamsForChat(chatId, params) {
  const map = readStore();
  const key = chatKey(chatId);
  const normalized = normalizeCopySizingParams(params);
  map[key] = normalized;
  writeStore(map);
  return normalized;
}

/** 兼容旧调用：无 chatId 时读全局默认 */
/** @returns {import("../../../src/telegram-copy-sizing.js").CopySizingParams} */
export function loadCopySizingParams() {
  return loadCopySizingParamsForChat("__default__");
}

/** @param {Partial<import("../../../src/telegram-copy-sizing.js").CopySizingParams>} params */
export function saveCopySizingParams(params) {
  return saveCopySizingParamsForChat("__default__", params);
}

/** @param {import("../../../src/telegram-copy-sizing.js").CopySizingParams} p */
export function formatCopySizingBrief(p) {
  const cfg = normalizeCopySizingParams(p);
  return `底${cfg.basePosition}U · 赢+${cfg.winBumpPct}% · 亏−${cfg.lossCutPct}%`;
}

export { DEFAULT_COPY_SIZING_PARAMS, normalizeCopySizingParams };
