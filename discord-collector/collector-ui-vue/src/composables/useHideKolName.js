import { ref } from "vue";
import { maskProfitPercentText } from "../lib/signalExecution.js";

export const HIDE_KOL_STORAGE_KEY = "dc_archive_hide_kol";

/** 全页共享，与 /cards、/eval 隐藏 KOL 开关同步 */
const hideKolName = ref(false);

try {
  hideKolName.value = localStorage.getItem(HIDE_KOL_STORAGE_KEY) === "1";
} catch {
  /* ignore */
}

export function useHideKolName() {
  function toggleHideKol() {
    hideKolName.value = !hideKolName.value;
    try {
      localStorage.setItem(HIDE_KOL_STORAGE_KEY, hideKolName.value ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  /** @param {string | null | undefined} name */
  function maskKolName(name) {
    const s = String(name ?? "").trim();
    if (!s) return "—";
    return hideKolName.value ? "*****" : s;
  }

  /** @param {string} formatted */
  function maskPercent(formatted) {
    if (!hideKolName.value) return formatted;
    return maskProfitPercentText(formatted);
  }

  return { hideKolName, toggleHideKol, maskKolName, maskPercent };
}
