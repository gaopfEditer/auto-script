/**
 * Telegram 频道展示：部署版仅别名 + 公网头像；本机可切换真实名称/头像。
 */
import personas from "../../../../telegram/channel_public_personas.json";
import { isDeployUi } from "./uiMode.js";

const STORAGE_KEY = "discord-collector.tg.showRealIdentity";

/** @param {string} chatId */
export function getPersonaForChatId(chatId) {
  const id = String(chatId ?? "").trim();
  const row = /** @type {Record<string, { alias?: string, senderAlias?: string, avatarUrl?: string }>} */ (
    personas
  )[id];
  if (!row) {
    const tail = id.slice(-4) || "?";
    return {
      alias: `路人群 ${tail}`,
      senderAlias: `群友${tail}`,
      avatarUrl: `https://api.dicebear.com/9.x/identicon/png?seed=${encodeURIComponent(id || "x")}&size=128`,
    };
  }
  const alias = String(row.alias || "").trim() || `路人群 ${id.slice(-4)}`;
  const senderAlias = String(row.senderAlias || "").trim() || alias;
  return {
    alias,
    senderAlias,
    avatarUrl: String(row.avatarUrl || "").trim(),
  };
}

/** 部署包强制别名；本机默认别名，可切换看真实群名 */
export function canToggleTelegramRealIdentity() {
  return !isDeployUi();
}

export function getTelegramShowRealIdentity() {
  if (isDeployUi()) return false;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** @param {boolean} showReal */
export function setTelegramShowRealIdentity(showReal) {
  if (isDeployUi()) return;
  try {
    localStorage.setItem(STORAGE_KEY, showReal ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ chatId: string, name: string, avatarUrl?: string }} ch
 * @param {boolean} showReal
 */
export function disguiseChannel(ch, showReal) {
  if (showReal) return { ...ch };
  const p = getPersonaForChatId(ch.chatId);
  return {
    ...ch,
    name: p.alias,
    avatarUrl: p.avatarUrl || ch.avatarUrl,
  };
}

/**
 * @param {Record<string, { name: string, avatarUrl?: string }>} channelById
 * @param {{ chatId: string, chatName?: string, avatarUrl?: string }} msg
 * @param {boolean} showReal
 */
export function disguiseMessage(msg, channelById, showReal) {
  if (showReal) return { ...msg };
  const cid = String(msg.chatId ?? "").trim();
  const ch = channelById[cid] || channelById[String(Number(cid))];
  const p = getPersonaForChatId(cid);
  return {
    ...msg,
    chatName: ch?.name ?? p.alias,
    sender: p.senderAlias,
    avatarUrl: ch?.avatarUrl ?? p.avatarUrl ?? msg.avatarUrl,
  };
}
