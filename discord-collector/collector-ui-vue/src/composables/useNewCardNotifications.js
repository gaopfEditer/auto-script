import { ref } from "vue";
import { fetchSignalConfig } from "../lib/discordSignalApi.js";
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

async function ensureChannelNames() {
  if (channelNamesLoaded) return;
  try {
    const cfg = await fetchSignalConfig();
    for (const [id, ch] of Object.entries(cfg.channels ?? {})) {
      const name = /** @type {{ name?: string }} */ (ch)?.name;
      if (name) channelNameMap[id] = name;
    }
  } catch {
    /* ignore */
  }
  channelNamesLoaded = true;
}

/** @param {Record<string, unknown>} card */
function cardPreview(card) {
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
  return `#${card.id}`;
}

/**
 * @param {Record<string, unknown>} card
 * @param {string} kind
 */
export function pushNewCardToast(card, kind) {
  const cardId = Number(card.id);
  if (!Number.isFinite(cardId) || cardId <= 0) return;
  if (toasts.value.some((t) => t.cardId === cardId)) return;

  void ensureChannelNames().then(() => {
    const channelId = String(card.channelId ?? "").trim();
    const channelName =
      String(card.channelName ?? "").trim() ||
      channelNameMap[channelId] ||
      channelId ||
      "未知频道";
    const ex = cardExecution(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (card));
    toasts.value.unshift({
      key: `${kind}-${cardId}-${Date.now()}`,
      cardId,
      title: cardSymbol(card),
      channelName,
      preview: cardPreview(card),
      direction: directionLabel(ex.direction),
      at: Date.now(),
    });
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

/** @param {string} key */
export function dismissCardToast(key) {
  toasts.value = toasts.value.filter((t) => t.key !== key);
}

export function useNewCardNotifications() {
  return {
    toasts,
    dismissCardToast,
  };
}
