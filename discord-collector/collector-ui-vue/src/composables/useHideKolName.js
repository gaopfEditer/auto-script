import { computed, ref } from "vue";
import { maskProfitPercentText } from "../lib/signalExecution.js";
import { isDeployUi } from "../lib/uiMode.js";

export const HIDE_KOL_STORAGE_KEY = "dc_archive_hide_kol";

/** 全页共享，与 /cards、/eval 隐藏 KOL 开关同步 */
const hideKolName = ref(false);

try {
  hideKolName.value = localStorage.getItem(HIDE_KOL_STORAGE_KEY) === "1";
} catch {
  /* ignore */
}

export function useHideKolName() {
  /** 仅本地 UI 显示开关；deploy / build:all 公网页不出现、也不掩码 */
  const hideKolControlVisible = computed(() => !isDeployUi());
  const namesHidden = computed(() => hideKolControlVisible.value && hideKolName.value);

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

  /**
   * 榜单截图用占位：星号个数与原名称 Unicode 码点数相同（如 6 字 → ******），便于区分不同频道。
   * @param {string | null | undefined} name
   */
  function maskKolChannelLabel(name) {
    const s = String(name ?? "").trim();
    if (!namesHidden.value) return s || "—";
    if (!s) return "—";
    return "*".repeat(Array.from(s).length);
  }

  /** @param {string} formatted */
  function maskPercent(formatted) {
    if (!hideKolName.value) return formatted;
    return maskProfitPercentText(formatted);
  }

  return {
    hideKolName,
    hideKolControlVisible,
    namesHidden,
    toggleHideKol,
    maskKolName,
    maskKolChannelLabel,
    maskPercent,
  };
}
