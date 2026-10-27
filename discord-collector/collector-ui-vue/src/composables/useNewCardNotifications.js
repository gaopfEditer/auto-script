import { ref } from "vue";
import { fetchSignalConfig } from "../lib/discordSignalApi.js";
import { subscribeCollectorSocket } from "./useCollectorSocket.js";
import { cardExecution, directionLabel } from "../lib/signalExecution.js";

/** @typedef {{
 *   key: string,
 *   cardId: number,
 *   title: string,
 *   channelName: string,
 *   preview: string,
 *   direction: string,
 *   at: number,
 * }} CardToast */

const toasts = ref(/** @type {CardToast[]} */ ([]));
/** @type {Record<string, string>} */
let channelNameMap = {};
let channelNamesLoaded = false;

/** @type {{ desktop: boolean, position: "bottom-right" | "top-right" }} */
export const notificationPrefs = ref({ desktop: false, position: /** @type {"bottom-right"} */ ("bottom-right") });
let notificationPrefsLoaded = false;

async function ensureChannelNames() {
  if (channelNamesLoaded) return;
  try {
    const cfg = await fetchSignalConfig();
    for (const [id, ch] of Object.entries(cfg.channels ?? {})) {
      const name = /** @type {{ name?: string }} */ (ch)?.name;
      if (name) channelNameMap[id] = name;
    }
    applyNotificationPrefs(cfg.cardNotifications);
  } catch {
    /* ignore */
  }
  channelNamesLoaded = true;
}

async function ensureNotificationPrefs() {
  if (notificationPrefsLoaded) return;
  try {
    const cfg = await fetchSignalConfig();
    applyNotificationPrefs(cfg.cardNotifications);
  } catch {
    /* ignore */
  }
  notificationPrefsLoaded = true;
}

/** @param {unknown} raw */
function applyNotificationPrefs(raw) {
  if (!raw || typeof raw !== "object") return;
  const o = /** @type {Record<string, unknown>} */ (raw);
  notificationPrefs.value = {
    desktop: Boolean(o.desktop),
    position: o.position === "top-right" ? "top-right" : "bottom-right",
  };
  notificationPrefsLoaded = true;
}

/** @param {Record<string, unknown>} card */
function cardPreview(card) {
  const fields = card.cardFields ?? card.card_fields;
  if (fields && typeof fields === "object") {
    const f = /** @type {Record<string, unknown>} */ (fields);
    const desc = String(f.description ?? f.title ?? "").trim();
    if (desc) return desc.length > 120 ? `${desc.slice(0, 120)}…` : desc;
  }
  const styles = /** @type {Record<string, string>} */ (card.cardsByStyle ?? {});
  const first = Object.keys(styles)[0];
  const body = (first && styles[first]) || String(card.rawContent ?? "");
  return body.length > 120 ? `${body.slice(0, 120)}…` : body;
}

/** @param {Record<string, unknown>} card */
function cardSymbol(card) {
  const ex = cardExecution(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (card));
  if (ex.symbol) return ex.symbol.replace(/^\$/, "").replace(/USDT$/i, "");
  const sym = String(card.symbol ?? "").trim();
  if (sym) return sym.replace(/USDT$/i, "");
  return "";
}

/** @param {CardToast} toast */
function maybeDesktopNotify(toast) {
  if (!notificationPrefs.value.desktop) return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "denied") return;

  const show = () => {
    try {
      new Notification(`新卡片 · ${toast.title}`, {
        body: [toast.channelName, toast.direction, toast.preview].filter(Boolean).join(" · "),
        tag: `card-${toast.cardId}`,
      });
    } catch {
      /* ignore */
    }
  };

  if (Notification.permission === "granted") {
    show();
    return;
  }
  void Notification.requestPermission().then((perm) => {
    if (perm === "granted") show();
  });
}

/**
 * @param {Record<string, unknown>} card
 * @param {string} kind
 */
export function pushNewCardToast(card, kind) {
  const cardId = Number(card.id);
  if (!Number.isFinite(cardId) || cardId <= 0) return;
  if (toasts.value.some((t) => t.cardId === cardId)) return;

  void Promise.all([ensureChannelNames(), ensureNotificationPrefs()]).then(() => {
    const channelId = String(card.channelId ?? "").trim();
    const channelName =
      String(card.channelName ?? "").trim() ||
      channelNameMap[channelId] ||
      channelId ||
      "未知频道";
    const ex = cardExecution(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (card));
    /** @type {CardToast} */
    const toast = {
      key: `${kind}-${cardId}-${Date.now()}`,
      cardId,
      title: cardSymbol(card),
      channelName,
      preview: cardPreview(card),
      direction: directionLabel(ex.direction),
      at: Date.now(),
    };
    toasts.value.unshift(toast);
    maybeDesktopNotify(toast);
  });
}

/** @param {Record<string, unknown>} msg */
export function handleNewCardSocketMessage(msg) {
  if (msg.channel !== "meta") return;
  if (
    (msg.kind === "signal_card_created" || msg.kind === "card_archived") &&
    msg.card &&
    typeof msg.card === "object"
  ) {
    pushNewCardToast(/** @type {Record<string, unknown>} */ (msg.card), String(msg.kind));
  }
}

/** 全局 WS 订阅：不依赖某个页面组件挂载 */
subscribeCollectorSocket(handleNewCardSocketMessage);

/** @param {string} key */
export function dismissCardToast(key) {
  toasts.value = toasts.value.filter((t) => t.key !== key);
}

export function dismissAllCardToasts() {
  toasts.value = [];
}

export function useNewCardNotifications() {
  return {
    toasts,
    dismissCardToast,
    dismissAllCardToasts,
    notificationPrefs,
    ensureNotificationPrefs,
  };
}