import { computed, nextTick, reactive } from "vue";
import router from "../router/index.js";
import { isPageEnabled } from "../lib/uiMode.js";

const STORAGE_KEY = "discord-collector.onboarding.v2";

/** 通知 OI 嵌入页切换路径 / 测量热点 */
export const OI_EMBED_PATH_EVENT = "dc-oi-embed-path";
const OI_MSG_MEASURE = "dc-oi-onboard-measure";
const OI_MSG_RECT = "dc-oi-onboard-rect";

/** 指引要求的 OI 子路径（View 挂载前也能读到） */
let pendingOiEmbedPath = /** @type {string | null} */ (null);

/** @returns {string | null} */
export function getPendingOiEmbedPath() {
  return pendingOiEmbedPath;
}

/**
 * @param {string | null} path
 */
export function setPendingOiEmbedPath(path) {
  pendingOiEmbedPath = path;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(OI_EMBED_PATH_EVENT, {
      detail: { path },
    })
  );
}

/** @typedef {{
 *   id: string,
 *   route: string,
 *   module?: "discord" | "oi",
 *   target?: string | null,
 *   iframeTarget?: string | null,
 *   embedPath?: string,
 *   title: string,
 *   lines: string[],
 * }} GuideStep */

/** @type {GuideStep[]} */
export const ONBOARDING_STEPS = [
  {
    id: "show-channels",
    route: "/show",
    module: "discord",
    target: '[data-onboard="show-channels"]',
    title: "Show · 左侧频道列表",
    lines: [
      "已跳转到 Show 页。左侧为 Discord 频道列表（与采集配置一致）。",
      "置顶频道排最前；带当日「止盈 / 止损」角标的，表示该 KOL 策略含止盈止损，便于对照执行纪律。",
      "单击选中频道；可双击或点 ✎ 自定义显示名；可用分组整理关注的信号博主。",
    ],
  },
  {
    id: "show-messages",
    route: "/show",
    module: "discord",
    target: '[data-onboard="show-messages"]',
    title: "Show · 频道消息",
    lines: [
      "中间区域是当前频道消息流：头像、正文、图片附件。",
      "新消息经 WebSocket 实时推送；未读频道在左侧会有高亮。",
      "信号频道选中后，右侧会出现信号卡片栏，可对照原文与归档卡片。",
    ],
  },
  {
    id: "cards-filters",
    route: "/cards",
    module: "discord",
    target: '[data-onboard="cards-filters"]',
    title: "卡片 · 筛选来源",
    lines: [
      "已跳转到 /cards。左侧筛选区：默认必含 Discord，可勾选 Telegram / X / YouTube 等来源。",
      "博主：按发车频道筛；币种如 BTC / ETH；时间默认「今天」。",
      "时间可选近 2 天、一周、30/90 天或全部；跨度大于 7 天时列表按周分割。",
    ],
  },
  {
    id: "cards-rules",
    route: "/cards",
    module: "discord",
    target: '[data-onboard="cards-rules"]',
    title: "卡片 · 结算规则",
    lines: [
      "高亮处为自动清算规则说明。",
      "BTC / ETH / SOL 按 100x，其余山寨 20x。",
      "卡片仅有方向、未设止盈止损时，按默认 ±5% 止盈止损价清算。",
      "本机可对筛选结果或勾选卡片执行「清算」/「清空结算」。",
    ],
  },
  {
    id: "cards-grid",
    route: "/cards",
    module: "discord",
    target: '[data-onboard="cards-grid"]',
    title: "卡片 · 卡片细则",
    lines: [
      "右侧网格按信号时间倒序：币种、方向、入场 / 止盈 / 止损与执行情况。",
      "点击卡片打开详情：正文、清算进度、手动评价（本机）。",
      "可勾选多张做批量清算、清空结算或删除（权限受本机限制）。",
    ],
  },
  {
    id: "eval-filters",
    route: "/eval",
    module: "discord",
    target: '[data-onboard="eval-period"]',
    title: "评估 · 按时间筛选",
    lines: [
      "已跳转到 /eval。请先看左侧「时间」：默认今天，可切近一周 / 30 天等看历史胜率。",
      "来源、发车频道、币种与卡片页筛选逻辑一致，改时间后汇总会自动刷新。",
      "来源选「全部」或 Discord 时，下方会展示 Discord 信号频道明细。",
    ],
  },
  {
    id: "eval-summary",
    route: "/eval",
    module: "discord",
    target: '[data-onboard="eval-summary"]',
    title: "评估 · 汇总与频道",
    lines: [
      "顶部汇总：已入场卡片数、胜率、总/平均损益、TP1/2/3 命中。",
      "表格按博主分行；下方可点选频道查看该博主历史卡与单笔盈亏。",
      "说明：未入场不计入胜率；任意 TP 命中算赢，先触 SL 算负。",
    ],
  },
  {
    id: "oi-sidebar",
    route: "/oi",
    module: "oi",
    embedPath: "/patterns",
    iframeTarget: '[data-onboard="oi-sidebar"]',
    target: '[data-onboard="oi-frame"]',
    title: "OI · 形态页 · 左侧币种",
    lines: [
      "已切到 OI Monitor，并默认打开「形态」页（非雷达）。",
      "左侧为监听币种列表：来自雷达热钱 / OI 异动入池，排序为置顶 → 持仓 → 其他。",
      "进入页面会默认选中列表第一个币种；也可点其它币种切换右侧 K 线。",
    ],
  },
  {
    id: "oi-main",
    route: "/oi",
    module: "oi",
    embedPath: "/patterns",
    iframeTarget: '[data-onboard="oi-main"]',
    target: '[data-onboard="oi-frame"]',
    title: "OI · 形态页 · 右侧 K 线",
    lines: [
      "右侧默认展示当前选中币种的 15m K 线（布林、MACD、LH/HL/扳机线等）。",
      "点顶栏「形态预警流」可回到阶段说明（LH → HL → 带量突破扳机）与预警列表。",
      "带「形态+OI」的预警 / Toast 可点开同一图表。",
    ],
  },
];

export const onboardingState = reactive({
  open: false,
  stepIndex: 0,
  rect: /** @type {{ top: number, left: number, width: number, height: number } | null} */ (null),
});

/** @returns {GuideStep[]} */
function enabledSteps() {
  return ONBOARDING_STEPS.filter((s) => {
    if (s.module === "oi") return isPageEnabled("oi");
    if (s.route === "/show") return isPageEnabled("show");
    if (s.route === "/cards") return isPageEnabled("cards");
    if (s.route === "/eval") return isPageEnabled("eval");
    return true;
  });
}

export function isOnboardingCompleted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingCompleted() {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function resetOnboardingCompleted() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function measureDomTarget(selector) {
  if (!selector || typeof document === "undefined") {
    onboardingState.rect = null;
    return false;
  }
  const el = document.querySelector(selector);
  if (!el) {
    onboardingState.rect = null;
    return false;
  }
  const r = el.getBoundingClientRect();
  const pad = 6;
  onboardingState.rect = {
    top: Math.max(8, r.top - pad),
    left: Math.max(8, r.left - pad),
    width: Math.min(window.innerWidth - 16, r.width + pad * 2),
    height: Math.min(window.innerHeight - 16, r.height + pad * 2),
  };
  return true;
}

/**
 * @param {string} selector
 * @returns {Promise<boolean>}
 */
function measureIframeTarget(selector) {
  return new Promise((resolve) => {
    const iframe = /** @type {HTMLIFrameElement | null} */ (document.querySelector("iframe.oi-frame"));
    if (!iframe?.contentWindow) {
      resolve(false);
      return;
    }

    let settled = false;
    /** @param {MessageEvent} e */
    const onMsg = (e) => {
      if (e.data?.type !== OI_MSG_RECT) return;
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      const fr = iframe.getBoundingClientRect();
      const r = e.data.rect;
      if (!r || typeof r.top !== "number") {
        resolve(false);
        return;
      }
      const pad = 6;
      onboardingState.rect = {
        top: Math.max(8, fr.top + r.top - pad),
        left: Math.max(8, fr.left + r.left - pad),
        width: Math.min(window.innerWidth - 16, r.width + pad * 2),
        height: Math.min(window.innerHeight - 16, r.height + pad * 2),
      };
      resolve(true);
    };

    window.addEventListener("message", onMsg);
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMsg);
      resolve(false);
    }, 1200);

    try {
      iframe.contentWindow.postMessage(
        { type: OI_MSG_MEASURE, selector, tab: "pattern" },
        "*"
      );
    } catch {
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(false);
    }
  });
}

/** @param {GuideStep | null | undefined} step */
function requestOiEmbedPath(step) {
  if (step?.module === "oi" && step.embedPath) {
    setPendingOiEmbedPath(step.embedPath);
    return;
  }
  if (step?.module !== "oi") {
    setPendingOiEmbedPath(null);
  }
}

/**
 * @param {GuideStep | null | undefined} step
 */
async function measureStep(step) {
  if (!step) {
    onboardingState.rect = null;
    return;
  }
  if (step.iframeTarget) {
    const ok = await measureIframeTarget(step.iframeTarget);
    if (ok) return;
    // iframe 未就绪时退回整框高亮
    if (step.target) measureDomTarget(step.target);
    return;
  }
  measureDomTarget(step.target ?? "");
}

async function waitFrames(n = 2) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => requestAnimationFrame(r));
  }
}

/** @param {GuideStep | null | undefined} step */
async function goRoute(step) {
  if (!step?.route) return;
  const cur = router.currentRoute.value.path;
  if (cur !== step.route && !cur.startsWith(`${step.route}/`)) {
    await router.push(step.route);
  }
  requestOiEmbedPath(step);
  await nextTick();
  await waitFrames(2);
  // OI iframe 首进需要多等一会再量热点
  if (step.module === "oi") {
    await new Promise((r) => setTimeout(r, 450));
  }
  await measureStep(step);
}

export function useOnboardingGuide() {
  const steps = computed(() => enabledSteps());
  const step = computed(() => steps.value[onboardingState.stepIndex] ?? null);
  const isFirst = computed(() => onboardingState.stepIndex <= 0);
  const isLast = computed(() => onboardingState.stepIndex >= steps.value.length - 1);

  async function refreshRect() {
    await measureStep(step.value);
  }

  async function open(at = 0) {
    onboardingState.open = true;
    onboardingState.stepIndex = Math.max(0, Math.min(at, steps.value.length - 1));
    const s = steps.value[onboardingState.stepIndex];
    if (s) await goRoute(s);
    await refreshRect();
  }

  function close() {
    onboardingState.open = false;
    onboardingState.rect = null;
    setPendingOiEmbedPath(null);
  }

  async function next() {
    if (isLast.value) {
      markOnboardingCompleted();
      close();
      return;
    }
    onboardingState.stepIndex += 1;
    const s = steps.value[onboardingState.stepIndex];
    if (s) await goRoute(s);
    await refreshRect();
  }

  async function prev() {
    if (isFirst.value) return;
    onboardingState.stepIndex -= 1;
    const s = steps.value[onboardingState.stepIndex];
    if (s) await goRoute(s);
    await refreshRect();
  }

  async function goTo(index) {
    onboardingState.stepIndex = Math.max(0, Math.min(index, steps.value.length - 1));
    const s = steps.value[onboardingState.stepIndex];
    if (s) await goRoute(s);
    await refreshRect();
  }

  function skip() {
    markOnboardingCompleted();
    close();
  }

  return {
    steps,
    step,
    isFirst,
    isLast,
    open,
    close,
    next,
    prev,
    goTo,
    skip,
    refreshRect,
    state: onboardingState,
  };
}
