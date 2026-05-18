/**
 * Kook 频道消息入库：与 Show 页同源解析（collector-ui-vue/lib），在 CDP diag / WS 帧处触发。
 */
import {
  isGuildViewApiUrl,
  getGuildViewChannelsArray,
  parseGuildIdFromViewUrl,
} from "../collector-ui-vue/src/lib/kookGuildView.js";
import {
  isKookChannelMessagesUrl,
  extractChannelIdFromMessagesUrl,
  parseKookMessagesResponseBody,
} from "../collector-ui-vue/src/lib/kookMessages.js";
import {
  tryExtractDesktopNotificationFromWsFrameJson,
} from "../collector-ui-vue/src/lib/kookGatewayWs.js";

/**
 * @typedef {{
 *   messageId: string;
 *   guildId?: string;
 *   channelId?: string;
 *   authorId?: string;
 *   createAtMs?: number;
 *   content?: string;
 *   msgType?: number | null;
 *   authorUsername?: string | null;
 *   authorNickname?: string | null;
 *   source?: string;
 *   rawJson?: unknown;
 *   receivedAt?: string;
 * }} KookMessageRowInput
 */

/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {ReturnType<typeof import("./kook-trade-telegram-push.js").createKookTradeTelegramPush> | null} [tradePush]
 */
export function createKookMessageIngest(store, log, tradePush = null) {
  /** @type {Record<string, string>} */
  const reqUrlByRequestId = {};
  const MAX_REQ_TRACK = 600;

  let guildIdLabel = "";

  function pruneReqMap() {
    const keys = Object.keys(reqUrlByRequestId);
    if (keys.length <= MAX_REQ_TRACK) return;
    for (let i = 0; i < keys.length - 400; i += 1) {
      delete reqUrlByRequestId[keys[i]];
    }
  }

  /**
   * @param {import("../collector-ui-vue/src/lib/kookMessages.js").KookHistMsg} hist
   * @param {{ guildId?: string, channelId?: string, source: string }} ctx
   * @returns {KookMessageRowInput | null}
   */
  function histToRow(hist, ctx) {
    const messageId = String(hist.id ?? "").trim();
    if (!messageId) return null;
    return {
      messageId,
      guildId: String(ctx.guildId ?? guildIdLabel ?? "").trim(),
      channelId: String(ctx.channelId ?? "").trim(),
      authorId: String(hist.authorId ?? "").trim(),
      createAtMs: Number(hist.create_at) || 0,
      content: hist.content ?? "",
      msgType: hist.type ?? null,
      authorUsername: hist.authorUsername || null,
      authorNickname: hist.authorNickname || null,
      source: ctx.source,
      rawJson: hist.raw ?? null,
      receivedAt: new Date().toISOString(),
    };
  }

  /**
   * @param {KookMessageRowInput[]} rows
   */
  /**
   * @param {KookMessageRowInput[]} rows
   */
  function queueTradePush(rows) {
    if (!tradePush) return;
    for (const row of rows) {
      void tradePush.maybePush(row).catch((e) => {
        log.debug(`trade push: ${/** @type {Error} */ (e).message}`);
      });
    }
  }

  async function persistRows(rows) {
    const batch = rows.filter((r) => r.messageId);
    if (!batch.length) return { inserted: 0, duplicate: 0 };
    try {
      const r = await store.insertKookMessagesBatch(batch);
      if (r.inserted > 0) {
        log.debug(`kook_messages +${r.inserted} dup=${r.duplicate} (batch ${batch.length})`);
      }
      queueTradePush(batch);
      return r;
    } catch (e) {
      log.error(`kook_messages 写入失败: ${/** @type {Error} */ (e).message}`);
      throw e;
    }
  }

  /**
   * @param {Record<string, unknown>} evt
   */
  async function onDiag(evt) {
    const k = String(evt.kind ?? "");
    const rid = String(evt.requestId ?? "");

    if (k === "net_request" && rid && evt.url) {
      reqUrlByRequestId[rid] = String(evt.url);
      pruneReqMap();
      return;
    }

    if (k !== "net_response_body" || !rid || evt.bodyJson == null) return;

    const url = reqUrlByRequestId[rid];
    if (!url) return;

    if (isGuildViewApiUrl(url)) {
      const arr = getGuildViewChannelsArray(evt.bodyJson);
      if (arr?.length) {
        guildIdLabel = parseGuildIdFromViewUrl(url) || guildIdLabel;
      }
      return;
    }

    if (isKookChannelMessagesUrl(url)) {
      const chId = extractChannelIdFromMessagesUrl(url);
      if (!chId) return;
      const incoming = parseKookMessagesResponseBody(evt.bodyJson);
      if (!incoming.length) return;
      /** @type {KookMessageRowInput[]} */
      const rows = [];
      for (const m of incoming) {
        const row = histToRow(m, { guildId: guildIdLabel, channelId: chId, source: "rest" });
        if (row) rows.push(row);
      }
      await persistRows(rows);
    }
  }

  /**
   * @param {Record<string, unknown>} payload buildFrameChannelPayload 的 payload（kind=ws_frame）
   */
  async function onWsFrame(payload) {
    if (String(payload.kind ?? "") !== "ws_frame") return;
    const body = payload.body;
    const j =
      body != null && typeof body === "object" && "json" in body && body.json != null && typeof body.json === "object"
        ? /** @type {Record<string, unknown>} */ (body.json)
        : null;
    if (!j) return;

    const desk = tryExtractDesktopNotificationFromWsFrameJson(j);
    if (!desk) return;

    const { channelId, guildId, hist } = desk;
    const row = histToRow(hist, {
      guildId: guildId || guildIdLabel,
      channelId,
      source: "ws_desktop",
    });
    if (row) await persistRows([row]);
  }

  /**
   * 前端 / API 批量上报（与 CDP 路径共用 INSERT IGNORE 去重）。
   * @param {KookMessageRowInput[]} rows
   */
  async function onClientBatch(rows) {
    const normalized = rows.map((r) => ({
      ...r,
      messageId: String(r.messageId ?? "").trim(),
      guildId: String(r.guildId ?? guildIdLabel ?? "").trim(),
      channelId: String(r.channelId ?? "").trim(),
      authorId: String(r.authorId ?? "").trim(),
      createAtMs: Number(r.createAtMs) || 0,
      content: r.content ?? "",
      source: r.source ?? "frontend",
      receivedAt: r.receivedAt ?? new Date().toISOString(),
    }));
    return persistRows(normalized);
  }

  return { onDiag, onWsFrame, onClientBatch };
}
