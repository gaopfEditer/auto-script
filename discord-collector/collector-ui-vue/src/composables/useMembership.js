import { computed, ref } from "vue";

/** 本地会员体验：默认会员（全部可见），切换结果写在 localStorage，不发到外部。 */
export const MEMBER_STATE_KEY = "discord-collector.membership.v1";
export const MEMBER_MESSAGES_KEY = "discord-collector.membership.messages.v1";

export const MEMBER_PLANS = Object.freeze([
  { id: "monthly", name: "月度", priceLabel: "50U", duration: "30 天" },
  { id: "quarterly", name: "季度", priceLabel: "100U", duration: "90 天" },
  { id: "yearly", name: "年度", priceLabel: "360U", duration: "365 天" },
  { id: "lifetime", name: "永久", priceLabel: "998U", duration: "永久有效" },
]);

const DEFAULT_PLAN = "quarterly";

/** @typedef {{ id: string, role: "user" | "agent", text: string, ts: number, planId?: string }} MemberMessage */

const isMember = ref(true);
const planId = ref(DEFAULT_PLAN);
/** @type {import("vue").Ref<MemberMessage[]>} */
const messages = ref([]);
const contactOpen = ref(false);
let hydrated = false;

function safeParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function hydrate() {
  if (hydrated || typeof localStorage === "undefined") return;
  hydrated = true;
  const state = safeParse(localStorage.getItem(MEMBER_STATE_KEY), null);
  if (state && typeof state === "object") {
    isMember.value = state.isMember !== false;
    const pid = String(state.planId || "");
    planId.value = MEMBER_PLANS.some((p) => p.id === pid) ? pid : DEFAULT_PLAN;
  } else {
    isMember.value = true;
    planId.value = DEFAULT_PLAN;
  }
  const list = safeParse(localStorage.getItem(MEMBER_MESSAGES_KEY), []);
  messages.value = Array.isArray(list)
    ? list
        .filter((m) => m && (m.role === "user" || m.role === "agent") && m.text)
        .map((m) => ({
          id: String(m.id || `${m.ts || 0}`),
          role: m.role,
          text: String(m.text),
          ts: Number(m.ts) || Date.now(),
          planId: m.planId ? String(m.planId) : undefined,
        }))
    : [];
}

function persistState() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    MEMBER_STATE_KEY,
    JSON.stringify({ isMember: isMember.value, planId: planId.value }),
  );
}

function persistMessages() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(MEMBER_MESSAGES_KEY, JSON.stringify(messages.value));
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 非会员时整页锁定的本地内容：博主胜率、手动统计详情。
 * /show/messages 不整页锁，改为按「默认列表前 15 个频道」锁定消息。
 * 会员中心本身不锁。
 * @param {string} path
 */
export function isMemberLockedPath(path) {
  const p = String(path || "").replace(/\/+$/, "") || "/";
  if (p === "/show/rank" || p === "/show") return true;
  if (p === "/local/manual-stats") return true;
  if (p === "/local/manual-stats/kolvip-sig") return true;
  return false;
}

/** 非会员锁定的会员频道数量（按默认列表顺序，不随置顶/拖拽变化） */
export const MEMBER_LOCKED_CHANNEL_LIMIT = 15;

/**
 * 按 Show 默认频道顺序取前 N 个 channelId，作为非会员锁定的会员频道。
 * 默认顺序优先用 /api/show/discord-groups 的 channelIds（discord_groups.json 白名单），
 * 未启用白名单时再用当前服务器可见频道的原始顺序。
 * @param {Iterable<unknown>} defaultOrderedIds
 * @param {number} [limit=MEMBER_LOCKED_CHANNEL_LIMIT]
 * @returns {string[]}
 */
export function memberLockedChannelIds(defaultOrderedIds, limit = MEMBER_LOCKED_CHANNEL_LIMIT) {
  const cap = Number(limit);
  const max = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : MEMBER_LOCKED_CHANNEL_LIMIT;
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const raw of defaultOrderedIds || []) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * @param {number} ts
 */
export function formatMessageTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hh}:${mm}`;
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${mon}-${day} ${hh}:${mm}`;
}

export function useMembership() {
  hydrate();

  const selectedPlan = computed(
    () => MEMBER_PLANS.find((p) => p.id === planId.value) || MEMBER_PLANS[1],
  );
  const unreadForMember = computed(() =>
    messages.value.filter((m) => m.role === "user").length,
  );

  /** @param {boolean} on */
  function setMember(on) {
    isMember.value = Boolean(on);
    persistState();
  }

  function toggleMember() {
    setMember(!isMember.value);
  }

  /** @param {string} id */
  function setPlan(id) {
    if (!MEMBER_PLANS.some((p) => p.id === id)) return;
    planId.value = id;
    persistState();
  }

  /**
   * @param {"user" | "agent"} role
   * @param {string} text
   * @param {{ planId?: string, ts?: number }} [extra]
   */
  function addMessage(role, text, extra = {}) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    /** @type {MemberMessage} */
    const msg = {
      id: newId(),
      role,
      text: trimmed,
      ts: extra.ts || Date.now(),
      planId: extra.planId || planId.value,
    };
    messages.value = [...messages.value, msg];
    persistMessages();
    return msg;
  }

  function ensurePresetMessage() {
    if (messages.value.length) return;
    const plan = selectedPlan.value;
    addMessage("user", `【会员开通】我想开通会员（鲸享 VIP · ${plan.name} ${plan.priceLabel}）`);
    addMessage(
      "agent",
      "已收到。这是本地体验客服，留言只保存在本机，不会发送到外部，也不是真实付费通道。",
    );
  }

  function openContact({ preset = true } = {}) {
    if (preset) ensurePresetMessage();
    contactOpen.value = true;
  }

  function closeContact() {
    contactOpen.value = false;
  }

  /** @param {string} text */
  function sendFromVisitor(text) {
    const msg = addMessage("user", text);
    if (!msg) return null;
    const userCount = messages.value.filter((m) => m.role === "user").length;
    if (userCount === 1) {
      addMessage(
        "agent",
        "已收到。这是本地体验客服，留言只保存在本机，不会发送到外部，也不是真实付费通道。",
      );
    }
    return msg;
  }

  /** @param {string} text */
  function sendFromAgent(text) {
    return addMessage("agent", text);
  }

  return {
    isMember,
    planId,
    selectedPlan,
    messages,
    contactOpen,
    unreadForMember,
    setMember,
    toggleMember,
    setPlan,
    addMessage,
    ensurePresetMessage,
    openContact,
    closeContact,
    sendFromVisitor,
    sendFromAgent,
  };
}
