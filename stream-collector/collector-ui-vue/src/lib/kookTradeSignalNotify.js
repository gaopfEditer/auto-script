/**
 * Show 页收到 WS/实时新消息后，通知服务端经 Ollama 判断并推送 Telegram。
 */
import { mightBeTradeSignalRough } from "./kookTradeSignalDetect.js";

/** 与后端 KOOK_TRADE_SOCKET_SOURCES 一致 */
const SOCKET_SOURCES = new Set(["ws_desktop", "frontend", "frontend_notify"]);

/** @type {Set<string>} */
const clientDedup = new Set();

/**
 * @param {import("./kookMessages.js").KookHistMsg} m
 * @param {{ guildId?: string, channelId: string, source?: string }} ctx
 */
export function maybeNotifyCompleteTradeSignal(m, ctx) {
  const messageId = String(m.id ?? "").trim();
  const guildId = String(ctx.guildId ?? "").trim();
  const channelId = String(ctx.channelId ?? "").trim();
  const content = String(m.content ?? "").trim();
  if (!messageId || !guildId || !channelId || !content) return;
  const src = String(ctx.source ?? "frontend").trim();
  if (!SOCKET_SOURCES.has(src)) return;
  if (!mightBeTradeSignalRough(content)) return;
  if (clientDedup.has(messageId)) return;
  clientDedup.add(messageId);
  if (clientDedup.size > 8000) {
    for (const id of [...clientDedup].slice(0, 4000)) clientDedup.delete(id);
  }

  void fetch("/api/kook/trade-signal/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messageId,
      guildId,
      channelId,
      authorId: String(m.authorId ?? "").trim(),
      authorNickname: m.authorNickname || null,
      authorUsername: m.authorUsername || null,
      createAtMs: Number(m.create_at) || 0,
      content,
      source: ctx.source ?? "frontend",
    }),
  }).catch(() => {
    clientDedup.delete(messageId);
  });
}
