/**
 * 卡片外送：产生/更新卡片时推到外部评估服务。
 * WebSocket：ws://…/ws/cards · HTTP：POST /api/cards
 * 载荷：完整 JSON（text 必填，附带时间/作者/频道等元数据）
 */
import WebSocket from "ws";
import { config } from "./config.js";
import { formatCardUid } from "./card-uid.js";

/**
 * @param {unknown} v
 * @returns {string}
 */
function isoOrEmpty(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v).toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/**
 * @param {string} iso
 * @returns {string}
 */
function formatLocalTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

/**
 * @param {Record<string, unknown>} [message]
 */
function pickAuthor(message = {}) {
  const authorId = String(message.authorId ?? message.author_id ?? "").trim();
  const username = String(message.authorUsername ?? message.author_username ?? "").trim();
  const globalName = String(message.authorGlobalName ?? message.author_global_name ?? "").trim();
  const display = globalName || username || authorId || "";
  return { authorId, username, globalName, display };
}

/**
 * 组装外送正文：元数据头 + 卡片正文（下游只读 text 也能看到作者/时间）。
 * @param {string} bodyText
 * @param {Record<string, unknown>} meta
 */
export function buildCardSinkText(bodyText, meta = {}) {
  const body = String(bodyText ?? "").trim();
  /** @type {string[]} */
  const head = [];
  // uid / card_id 不写进正文，仅在 JSON 结构化字段中携带
  const sourceLabel = String(meta.source_label || "").trim();
  if (sourceLabel) head.push(`来源：${sourceLabel}`);
  const channelName = String(meta.channel_name || "").trim();
  const channelId = String(meta.channel_id || "").trim();
  if (channelName || channelId) {
    head.push(`频道：${channelName || "—"}${channelId ? ` (${channelId})` : ""}`);
  }
  const guildName = String(meta.guild_name || "").trim();
  const guildId = String(meta.guild_id || "").trim();
  if (guildName || guildId) {
    head.push(`服务器：${guildName || "—"}${guildId ? ` (${guildId})` : ""}`);
  }
  const author = String(meta.author_display || meta.author_username || "").trim();
  const authorId = String(meta.author_id || "").trim();
  if (author || authorId) {
    const un = String(meta.author_username || "").trim();
    head.push(
      `作者：${author || "—"}${un && un !== author ? ` (@${un})` : ""}${authorId ? ` id=${authorId}` : ""}`
    );
  }
  const signalAt = String(meta.signal_at || meta.message_at || "").trim();
  if (signalAt) {
    head.push(`信号时间：${formatLocalTime(signalAt)} (${signalAt})`);
  }
  const createdAt = String(meta.created_at || "").trim();
  if (createdAt && createdAt !== signalAt) {
    head.push(`建卡时间：${formatLocalTime(createdAt)} (${createdAt})`);
  }
  const messageId = String(meta.message_id || "").trim();
  if (messageId) head.push(`消息ID：${messageId}`);
  const event = String(meta.event || "").trim();
  if (event) head.push(`事件：${event}`);
  const phase = String(meta.signal_phase || "").trim();
  if (phase) head.push(`阶段：${phase}`);

  if (!head.length) return body;
  return `${head.join("\n")}\n────────\n${body}`;
}

/**
 * 构建完整外送 JSON（兼容 oi_mornitor：text / card_id / title / source_label）。
 * @param {{
 *   text: string,
 *   card?: Record<string, unknown> | null,
 *   message?: Record<string, unknown> | null,
 *   channelName?: string,
 *   channelId?: string,
 *   guildId?: string,
 *   guildName?: string,
 *   event?: string,
 *   parsed?: Record<string, unknown> | null,
 *   execution?: unknown,
 *   embed?: unknown,
 * }} input
 */
export function buildCardSinkPayload(input) {
  const card = input.card && typeof input.card === "object" ? input.card : {};
  const message = input.message && typeof input.message === "object" ? input.message : {};
  const author = pickAuthor(message);

  const cardIdNum = Number(card.id ?? input.card?.id ?? 0);
  const uid =
    String(card.uid ?? "").trim() ||
    formatCardUid(cardIdNum) ||
    String(card.id ?? "").trim();

  const channelId = String(
    input.channelId ?? card.channelId ?? message.channelId ?? message.channel_id ?? ""
  ).trim();
  const channelName = String(
    input.channelName ?? card.channelName ?? message.channelName ?? message.channel_name ?? ""
  ).trim();
  const guildId = String(
    input.guildId ?? card.guildId ?? message.guildId ?? message.guild_id ?? ""
  ).trim();
  const guildName = String(
    input.guildName ?? message.guildName ?? message.guild_name ?? ""
  ).trim();

  const signalAt =
    isoOrEmpty(card.signalAt) ||
    isoOrEmpty(message.createdAtMs ?? message.created_at_ms) ||
    isoOrEmpty(message.timestamp) ||
    isoOrEmpty(card.createdAt);

  const createdAt = isoOrEmpty(card.createdAt) || signalAt;
  const updatedAt = isoOrEmpty(card.updatedAt) || createdAt;
  const messageId = String(card.messageId ?? message.messageId ?? message.message_id ?? "").trim();
  const sourceType = String(card.sourceType ?? card.source ?? message.sourceType ?? "discord").trim();
  const sourceLabel =
    [sourceType, channelName || channelId].filter(Boolean).join(" · ") || sourceType;

  const parsed =
    (input.parsed && typeof input.parsed === "object" ? input.parsed : null) ||
    (card.parsedJson && typeof card.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (card.parsedJson)
      : null);
  const execution = input.execution ?? card.execution ?? null;
  const embed = input.embed ?? card.cardFields ?? null;
  const rawContent = String(card.rawContent ?? message.content ?? "").trim();
  const bodyText = String(input.text ?? "").trim() || rawContent;
  const title =
    String(
      (embed && typeof embed === "object" && /** @type {Record<string, unknown>} */ (embed).title) ||
        parsed?.title ||
        bodyText.split("\n")[0] ||
        ""
    ).trim();

  const event = String(input.event ?? "created").trim() || "created";
  const signalPhase = String(parsed?.signalPhase ?? "").trim();

  /** @type {Record<string, unknown>} */
  const metaForText = {
    uid,
    card_id: uid,
    source_label: sourceLabel,
    channel_id: channelId,
    channel_name: channelName,
    guild_id: guildId,
    guild_name: guildName,
    author_id: author.authorId,
    author_username: author.username,
    author_global_name: author.globalName,
    author_display: author.display,
    signal_at: signalAt,
    created_at: createdAt,
    message_id: messageId,
    event,
    signal_phase: signalPhase,
  };

  const text = buildCardSinkText(bodyText, metaForText);

  return {
    // —— 下游解析核心 ——
    text,
    card_id: uid,
    id: Number.isFinite(cardIdNum) && cardIdNum > 0 ? cardIdNum : undefined,
    uid,
    title,
    source_label: sourceLabel,
    source: sourceType,
    raw_text: bodyText,
    raw_content: rawContent,
    // —— 时间 ——
    signal_at: signalAt || undefined,
    message_at: signalAt || undefined,
    created_at: createdAt || undefined,
    updated_at: updatedAt || undefined,
    signal_at_local: signalAt ? formatLocalTime(signalAt) : undefined,
    // —— 作者 ——
    author_id: author.authorId || undefined,
    author_username: author.username || undefined,
    author_global_name: author.globalName || undefined,
    author_display: author.display || undefined,
    // —— 频道 / 服务器 ——
    channel_id: channelId || undefined,
    channel_name: channelName || undefined,
    guild_id: guildId || undefined,
    guild_name: guildName || undefined,
    message_id: messageId || undefined,
    // —— 结构 ——
    event,
    parser: parsed?.parser != null ? String(parsed.parser) : undefined,
    signal_phase: signalPhase || undefined,
    symbol: String(parsed?.symbol ?? card.symbol ?? card.execution?.symbol ?? "").trim() || undefined,
    direction:
      String(parsed?.direction ?? card.execution?.direction ?? "").trim() || undefined,
    parsed: parsed || undefined,
    execution: execution || undefined,
    embed: embed || undefined,
    cards_by_style: card.cardsByStyle || undefined,
    note: card.note != null ? String(card.note) : undefined,
  };
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function createCardExternalSink(log) {
  const wsUrl = String(config.cardSinkWsUrl ?? "").trim();
  const httpUrl = String(config.cardSinkHttpUrl ?? "").trim();
  const enabled = Boolean(config.cardSinkEnabled && (wsUrl || httpUrl));
  const timeoutMs = Math.max(1000, Number(config.cardSinkTimeoutMs) || 8_000);
  const reconnectMs = Math.max(1000, Number(config.cardSinkReconnectMs) || 3_000);

  /** @type {import("ws").WebSocket | null} */
  let socket = null;
  let connecting = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let stopped = false;

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || !wsUrl || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectMs);
  }

  function connect() {
    if (stopped || !wsUrl || connecting) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    connecting = true;
    clearReconnect();
    try {
      const ws = new WebSocket(wsUrl);
      socket = ws;
      ws.on("open", () => {
        connecting = false;
        log.info(`卡片外送 WebSocket 已连接 ${wsUrl}`);
      });
      ws.on("close", () => {
        connecting = false;
        if (socket === ws) socket = null;
        if (!stopped) {
          log.warn(`卡片外送 WebSocket 断开，${reconnectMs}ms 后重连`);
          scheduleReconnect();
        }
      });
      ws.on("error", (err) => {
        log.warn(`卡片外送 WebSocket 错误: ${/** @type {Error} */ (err).message}`);
      });
    } catch (e) {
      connecting = false;
      socket = null;
      log.warn(`卡片外送 WebSocket 连接失败: ${/** @type {Error} */ (e).message}`);
      scheduleReconnect();
    }
  }

  /**
   * @param {Record<string, unknown>} payload
   */
  async function publishHttp(payload) {
    if (!httpUrl) throw new Error("card sink http url empty");
    const res = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return { ok: true, via: "http", status: res.status, body: body.slice(0, 500) };
  }

  /**
   * @param {string} raw
   */
  function publishWs(raw) {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("ws not open"));
    }
    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout>} */
      let timer;
      const finish = (/** @type {{ ok: boolean, via: string, ack?: string }} */ result) => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(result);
      };
      const onMessage = (/** @type {import("ws").RawData} */ data) => {
        finish({ ok: true, via: "ws", ack: String(data).slice(0, 500) });
      };
      timer = setTimeout(() => {
        finish({ ok: true, via: "ws", ack: undefined });
      }, Math.min(timeoutMs, 3000));
      ws.on("message", onMessage);
      ws.send(raw, (err) => {
        if (err) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          reject(err);
        }
      });
    });
  }

  /**
   * @param {string | Record<string, unknown>} textOrPayload
   * @param {Record<string, unknown>} [meta] 仅当第一参为 string 时作为简易 meta（兼容旧调用）
   */
  async function publish(textOrPayload, meta = {}) {
    if (!enabled) return { skipped: "disabled" };

    /** @type {Record<string, unknown>} */
    let payload;
    if (typeof textOrPayload === "string") {
      const text = textOrPayload.trim();
      if (!text) return { skipped: "empty" };
      payload = buildCardSinkPayload({
        text,
        card: {
          id: meta.cardId,
          uid: meta.uid,
          channelId: meta.channelId,
        },
        channelId: String(meta.channelId ?? ""),
        channelName: String(meta.channelName ?? ""),
        event: String(meta.event ?? "created"),
        message: /** @type {Record<string, unknown>} */ (meta.message ?? {}),
        parsed: /** @type {Record<string, unknown> | null} */ (meta.parsed ?? null),
      });
    } else if (textOrPayload && typeof textOrPayload === "object") {
      payload = textOrPayload;
    } else {
      return { skipped: "empty" };
    }

    if (!String(payload.text ?? "").trim()) return { skipped: "empty" };

    const raw = JSON.stringify(payload);
    const tag = String(payload.uid || payload.card_id || payload.channel_id || "?");

    if (socket?.readyState === WebSocket.OPEN) {
      try {
        const result = await publishWs(raw);
        log.info(
          `卡片外送 WS 成功 ${tag}${result.ack ? ` ack=${result.ack.slice(0, 120)}` : ""}`
        );
        return result;
      } catch (e) {
        log.warn(`卡片外送 WS 发送失败 ${tag}: ${/** @type {Error} */ (e).message}，尝试 HTTP`);
      }
    } else if (wsUrl) {
      connect();
    }

    if (httpUrl) {
      try {
        const result = await publishHttp(payload);
        log.info(`卡片外送 HTTP 成功 ${tag}`);
        return result;
      } catch (e) {
        log.warn(`卡片外送 HTTP 失败 ${tag}: ${/** @type {Error} */ (e).message}`);
        return { ok: false, error: String(/** @type {Error} */ (e).message ?? e) };
      }
    }

    return { skipped: "not_connected" };
  }

  function start() {
    stopped = false;
    if (enabled && wsUrl) connect();
    else if (enabled && httpUrl) log.info(`卡片外送仅 HTTP ${httpUrl}`);
    else log.info("卡片外送未启用（CARD_SINK_ENABLED=0 或未配置 URL）");
  }

  function stop() {
    stopped = true;
    clearReconnect();
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
    }
  }

  return {
    enabled,
    wsUrl,
    httpUrl,
    publish,
    start,
    stop,
  };
}

/**
 * 从卡片对象取外送正文（优先 telegram/首个风格）。
 * @param {Record<string, unknown>} card
 * @param {string} [preferredStyle]
 */
export function pickCardSinkText(card, preferredStyle = "") {
  const styles =
    card.cardsByStyle && typeof card.cardsByStyle === "object"
      ? /** @type {Record<string, string>} */ (card.cardsByStyle)
      : {};
  if (preferredStyle && styles[preferredStyle]) return String(styles[preferredStyle]);
  const first = Object.values(styles).find((v) => String(v ?? "").trim());
  if (first) return String(first);
  return String(card.rawContent ?? "").trim();
}
