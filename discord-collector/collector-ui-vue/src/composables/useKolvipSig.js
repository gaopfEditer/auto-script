import { ref, computed, watch, reactive } from "vue";
import {
  fetchKolvipSigBlogger,
  fetchKolvipSigMeta,
  fetchKolvipSigRank,
  syncKolvipSigLocal,
} from "../lib/kolvipSigApi.js";

/** 去掉 Show 侧栏「名称（91.7%）」后缀，用于对上 kolvip 博主名 */
export function normalizeBloggerLabel(name) {
  return String(name ?? "")
    .trim()
    .replace(/（\s*[\d.]+%\s*）$/u, "")
    .trim();
}

/**
 * @param {string} label
 * @param {Array<{ name?: string }>} list
 */
export function resolveBloggerName(label, list) {
  const raw = normalizeBloggerLabel(label);
  if (!raw) return "";
  const names = list.map((x) => String(x.name ?? ""));
  if (names.includes(raw)) return raw;
  const low = raw.toLowerCase();
  const hit = names.find((n) => n.toLowerCase() === low);
  if (hit) return hit;
  return names.find((n) => n.includes(raw) || raw.includes(n)) || raw;
}

export function useKolvipSig() {
  /** @type {import('vue').Ref<'7'|'30'|'all'>} */
  const range = ref("30");
  const loading = ref(false);
  const syncing = ref(false);
  const error = ref("");
  const meta = ref(/** @type {Record<string, unknown>|null} */ (null));
  /** @type {import('vue').Ref<Record<string, unknown>|null>} */
  const rank = ref(null);
  /** @type {import('vue').Ref<Record<string, unknown>|null>} */
  const blogger = ref(null);
  const selectedName = ref("");

  const rangeLabels = { 7: "近 7 天", 30: "近 30 天", all: "全部" };

  const rankedList = computed(() => {
    const list = Array.isArray(rank.value?.list) ? rank.value.list : [];
    return list.filter((x) => x.ranked);
  });

  const moreList = computed(() => {
    const list = Array.isArray(rank.value?.list) ? rank.value.list : [];
    return list.filter((x) => !x.ranked).slice(0, 30);
  });

  const stat = computed(() => blogger.value?.stat || null);
  const history = computed(() => (Array.isArray(blogger.value?.history) ? blogger.value.history : []));
  const openList = computed(() => (Array.isArray(blogger.value?.open) ? blogger.value.open : []));

  async function loadRank() {
    loading.value = true;
    error.value = "";
    try {
      const j = await fetchKolvipSigRank(range.value);
      if (!j?.ok) throw new Error(j?.error || "加载失败");
      rank.value = j;
      const list = Array.isArray(j.list) ? j.list : [];
      const ranked = list.filter((x) => x.ranked);
      const resolved = resolveBloggerName(selectedName.value, list);
      if (!resolved || !list.some((x) => x.name === resolved)) {
        selectedName.value = (ranked[0] || list[0] || {}).name || "";
      } else {
        selectedName.value = resolved;
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      rank.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function loadBlogger() {
    if (!selectedName.value) {
      blogger.value = null;
      return;
    }
    try {
      const j = await fetchKolvipSigBlogger(selectedName.value, range.value);
      if (!j?.ok) throw new Error(j?.error || "加载博主失败");
      blogger.value = j;
    } catch {
      blogger.value = null;
    }
  }

  async function loadMeta() {
    try {
      meta.value = await fetchKolvipSigMeta();
    } catch {
      meta.value = null;
    }
  }

  async function onSync() {
    syncing.value = true;
    error.value = "";
    try {
      const j = await syncKolvipSigLocal();
      if (j?.ok === false) throw new Error(j.error || "同步失败");
      await loadMeta();
      await loadRank();
      await loadBlogger();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      syncing.value = false;
    }
  }

  /** @param {string} name */
  function pickBlogger(name) {
    const list = Array.isArray(rank.value?.list) ? rank.value.list : [];
    const resolved = resolveBloggerName(name, list);
    if (resolved) selectedName.value = resolved;
  }

  function fmtR(r) {
    const n = Number(r);
    if (!Number.isFinite(n)) return "–";
    return `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100}R`;
  }

  function sideLabel(s) {
    return Number(s) > 0 ? "多" : "空";
  }

  watch([range, selectedName], () => {
    void loadBlogger();
  });

  async function init() {
    await loadMeta();
    await loadRank();
    await loadBlogger();
  }

  return reactive({
    range,
    loading,
    syncing,
    error,
    meta,
    rank,
    blogger,
    selectedName,
    rangeLabels,
    rankedList,
    moreList,
    stat,
    history,
    openList,
    loadRank,
    loadBlogger,
    loadMeta,
    onSync,
    pickBlogger,
    fmtR,
    sideLabel,
    init,
  });
}