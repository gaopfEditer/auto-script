import { computed, nextTick, reactive } from "vue";
import router from "../router/index.js";
import { isPageEnabled } from "../lib/uiMode.js";

const STORAGE_KEY = "discord-collector.onboarding.v1";

/** @typedef {{
 *   id: string,
 *   route: string,
 *   module?: "discord" | "oi",
 *   target?: string | null,
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
    title: "Show · 信号频道",
    lines: [
      "左侧列表为 Discord 信号频道（与采集配置一致）。",
      "置顶频道排在最前；带当日止盈/止损角标的为策略含止盈的博主频道。",
      "单击一行选中频道；可双击或点 ✎ 自定义显示名称。",
    ],
  },
  {
    id: "show-messages",
    route: "/show",
    module: "discord",
    target: '[data-onboard="show-messages"]',
    title: "Show · 频道内容与卡片",
    lines: [
      "选中频道后，中间区域显示该频道消息流（头像、正文、图片附件）。",
      "新消息经 WebSocket 实时推送；未读频道会有高亮提示。",
      "若是信号频道，右侧会出现信号卡片侧栏，可查看同频道归档卡片。",
    ],
  },
  {
    id: "cards-filters",
    route: "/cards",
    module: "discord",
    target: '[data-onboard="cards-filters"]',
    title: "卡片 · 筛选逻辑",
    lines: [
      "默认包含 Discord 信号卡片，可勾选 Telegram / X / YouTube 等来源一并查看。",
      "博主：按发车频道筛选；币种：如 BTC / ETH；时间默认「今天」。",
      "时间可选近 2 天、一周、30/90 天或全部；跨度大于 7 天时列表按周分割。",
      "改筛选后会自动刷新列表与左侧博主下拉（仅显示当前条件下有卡的频道）。",
    ],
  },
  {
    id: "cards-grid",
    route: "/cards",
    module: "discord",
    target: '[data-onboard="cards-grid"]',
    title: "卡片 · 列表与历史",
    lines: [
      "右侧网格按信号时间倒序展示卡片：币种、方向、入场/止盈/止损与执行情况。",
      "点击卡片可打开详情，查看正文、清算进度与手动评价（本机）。",
      "顶栏说明默认杠杆清算规则：BTC/ETH/SOL 100x，其余山寨 20x。",
    ],
  },
  {
    id: "eval-filters",
    route: "/eval",
    module: "discord",
    target: '[data-onboard="eval-filters"]',
    title: "评估 · 筛选条件",
    lines: [
      "筛选与卡片页一致：来源、发车频道、币种、时间。",
      "默认时间也是「今天」；可切到近一周等查看历史胜率。",
      "来源选「全部」或 Discord 时，下方会展示 Discord 信号频道明细。",
    ],
  },
  {
    id: "eval-summary",
    route: "/eval",
    module: "discord",
    target: '[data-onboard="eval-summary"]',
    title: "评估 · 汇总内容",
    lines: [
      "顶部汇总：已入场卡片数、胜率、总/平均损益、TP1/2/3 命中次数。",
      "表格按博主/频道分行，展示卡片数、胜负、PnL 与 TP 分布。",
      "再下方可点选频道查看该博主历史卡片与单笔盈亏（与表格联动）。",
      "说明：未入场不计入胜率；任意 TP 命中算赢，先触 SL 算负。",
    ],
  },
  {
    id: "oi-pattern",
    route: "/oi",
    module: "oi",
    target: null,
    title: "OI Monitor · 形态与信号",
    lines: [
      "顶栏切换到「OI Monitor」后进入嵌入页（需 collect:ui + oi:dev/oi:start）。",
      "打开「形态」标签：左侧为监听币种列表（置顶 / 持仓中优先）。",
      "点击任一币种，右侧展开 K 线图，显示布林、MACD、形态标记（LH/HL/扳机线等）。",
      "形态列表与 Toast 中的「形态+OI」推荐可点币种跳转同一图表。",
      "沙盒标签下持仓区的币种芯片同样可点开右侧 K 线查看信号上下文。",
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

function measureTarget(selector) {
  if (!selector || typeof document === "undefined") {
    onboardingState.rect = null;
    return;
  }
  const el = document.querySelector(selector);
  if (!el) {
    onboardingState.rect = null;
    return;
  }
  const r = el.getBoundingClientRect();
  const pad = 6;
  onboardingState.rect = {
    top: Math.max(8, r.top - pad),
    left: Math.max(8, r.left - pad),
    width: Math.min(window.innerWidth - 16, r.width + pad * 2),
    height: Math.min(window.innerHeight - 16, r.height + pad * 2),
  };
}

async function goRoute(step) {
  if (!step?.route) return;
  const cur = router.currentRoute.value.path;
  if (cur !== step.route && !cur.startsWith(`${step.route}/`)) {
    await router.push(step.route);
  }
  await nextTick();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  measureTarget(step.target ?? "");
}

export function useOnboardingGuide() {
  const steps = computed(() => enabledSteps());
  const step = computed(() => steps.value[onboardingState.stepIndex] ?? null);
  const isFirst = computed(() => onboardingState.stepIndex <= 0);
  const isLast = computed(() => onboardingState.stepIndex >= steps.value.length - 1);

  async function refreshRect() {
    measureTarget(step.value?.target ?? "");
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
