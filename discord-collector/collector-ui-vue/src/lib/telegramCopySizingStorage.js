import {
  DEFAULT_COPY_SIZING_PARAMS,
  normalizeCopySizingParams,
} from "../../../src/telegram-copy-sizing.js";

const PARAMS_KEY = "telegram.copySizing.params";

/** @returns {import("../../../src/telegram-copy-sizing.js").CopySizingParams} */
export function loadCopySizingParams() {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (!raw) return { ...DEFAULT_COPY_SIZING_PARAMS };
    const parsed = JSON.parse(raw);
    return normalizeCopySizingParams(parsed);
  } catch {
    return { ...DEFAULT_COPY_SIZING_PARAMS };
  }
}

/** @param {Partial<import("../../../src/telegram-copy-sizing.js").CopySizingParams>} params */
export function saveCopySizingParams(params) {
  const normalized = normalizeCopySizingParams(params);
  try {
    localStorage.setItem(PARAMS_KEY, JSON.stringify(normalized));
  } catch {
    /* ignore quota */
  }
  return normalized;
}

export { DEFAULT_COPY_SIZING_PARAMS, normalizeCopySizingParams };
