/**
 * Discord 源频道消息 → 目标频道 Webhook 实时转发。
 */
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { config } from "./config.js";
import {
  findWebhookForward,
  loadWebhookForwardConfig,
} from "./discord-webhook-forward-config.js";

/** @typedef {{
 *   messageId?: string;
 *   guildId?: string;
 *   channelId?: string;
 *   channelName?: string;
 *   authorUsername?: string;
 *   authorGlobalName?: string;
 *   authorAvatar?: string | null;
 *   content?: string;
 *   rawJson?: unknown;
 * }} DiscordMessageRow */

const DISCORD_CONTENT_MAX = 2000;
const DEDUP_MAX = 2000;

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{ configPath?: string }} [opts]
 */
export function createDiscordWebhookForward(log, opts = {}) {
  let cfg = loadWebhookForwardConfig(opts.configPath);
  /** @type {import("undici").Dispatcher | undefined} */
  let fetchDispatcher;
  if (config.webhookForwardProxy) {
    fetchDispatcher = new ProxyAgent(config.webhookForwardProxy);
    log.info(`Webhook 转发代理(Node): ${config.webhookForwardProxy}`);
  }
  /** @type {((url: string, payload: Record<string, unknown>) => Promise<void>) | null} */
  let browserPost = opts.browserPost ?? null;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const seenOrder = [];

  function reload() {
    cfg = loadWebhookForwardConfig(opts.configPath);
    const channels = [...new Set(cfg.forwards.map((r) => r.channelId))];
    if (cfg.enabled && cfg.forwards.length) {
      log.info(
        `已加载 ${cfg.forwards.length} 条映射，监听频道: ${channels.join(", ")}`
      );
    } else {
      log.warn("未启用或 forwards 为空，请检查 config/channel-webhook-forwards.json");
    }
  }

  reload();

  /** @param {string} key */
  function remember(key) {
    if (seen.has(key)) return false;
    seen.add(key);
    seenOrder.push(key);
    while (seenOrder.length > DEDUP_MAX) {
      const old = seenOrder.shift();
      if (old) seen.delete(old);
    }
    return true;
  }

  /**
   * @param {unknown} rawJson
   * @returns {string[]}
   */
  function embedTexts(rawJson) {
    const o =
      rawJson != null && typeof rawJson === "object" && !Array.isArray(rawJson)
        ? /** @type {Record<string, unknown>} */ (rawJson)
        : null;
    const list = Array.isArray(o?.embeds) ? o.embeds : [];
    /** @type {string[]} */
    const out = [];
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const em = /** @type {Record<string, unknown>} */ (e);
      const title = String(em.title ?? "").trim();
      const desc = String(em.description ?? "").trim();
      const url = String(em.url ?? "").trim();
      const chunk = [title, desc, url].filter(Boolean).join("\n");
      if (chunk) out.push(chunk);
    }
    return out;
  }

  /** @param {string} url */
  function maskWebhookUrl(url) {
    const m = String(url).match(/^(https:\/\/discord\.com\/api\/webhooks\/\d+)\/([^/?#]+)/i);
    if (!m) return url.slice(0, 48);
    return `${m[1]}/${m[2].slice(0, 6)}…`;
  }

  /**
   * @param {unknown} rawJson
   * @returns {string[]}
   */
  function attachmentUrls(rawJson) {
    const o =
      rawJson != null && typeof rawJson === "object" && !Array.isArray(rawJson)
        ? /** @type {Record<string, unknown>} */ (rawJson)
        : null;
    const list = Array.isArray(o?.attachments) ? o.attachments : [];
    /** @type {string[]} */
    const urls = [];
    for (const a of list) {
      if (!a || typeof a !== "object") continue;
      const url = String(/** @type {Record<string, unknown>} */ (a).url ?? "").trim();
      if (url) urls.push(url);
    }
    return urls;
  }

  /**
   * @param {DiscordMessageRow} row
   * @param {import("./discord-webhook-forward-config.js").WebhookForwardRule} rule
   */
  function formatPayload(row, rule) {
    const author =
      String(row.authorGlobalName ?? "").trim() ||
      String(row.authorUsername ?? "").trim() ||
      "未知";
    const body = String(row.content ?? "").trim();
    const attach = attachmentUrls(row.rawJson);
    const embeds = embedTexts(row.rawJson);
    /** @type {string[]} */
    const lines = [];
    if (body) lines.push(body);
    if (embeds.length) lines.push(...embeds);
    if (attach.length) lines.push(...attach.map((u) => u));
    let content = lines.join("\n");
    if (content.length > DISCORD_CONTENT_MAX) {
      content = `${content.slice(0, DISCORD_CONTENT_MAX - 20)}\n\n…(已截断)`;
    }
    /** @type {Record<string, unknown>} */
    const payload = { content: content || "（无文本）" };
    if (author && author !== "未知") payload.username = author.slice(0, 80);
    if (row.authorAvatar) payload.avatar_url = String(row.authorAvatar);
    return payload;
  }

  /** @param {unknown} err */
  function formatFetchError(err) {
    const e = /** @type {Error & { cause?: { code?: string; message?: string } }} */ (err);
    const code = e.cause?.code ?? "";
    let hint = "";
    if (code === "UND_ERR_INVALID_ARG") {
      hint = "（Node fetch 与代理不兼容，已改用 undici；若仍失败请检查 DISCORD_WEBHOOK_PROXY）";
    } else if (code === "UND_ERR_CONNECT_TIMEOUT" || /fetch failed|Timeout.*exceeded/i.test(e.message)) {
      hint = config.webhookForwardProxy
        ? "（经代理仍超时，请确认代理端口可用）"
        : "（请在 .env 设置 DISCORD_WEBHOOK_PROXY，与 Chrome 代理一致）";
    }
    return `${e.message}${code ? ` [${code}]` : ""}${hint}`;
  }

  /**
   * @param {string} webhookUrl
   * @param {Record<string, unknown>} payload
   * @param {string} via
   */
  async function postWebhookHttp(webhookUrl, payload, via) {
    if (config.webhookForwardLog) {
      const preview = String(payload.content ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      log.info(`POST (${via}) ${maskWebhookUrl(webhookUrl)} | ${preview}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.webhookForwardTimeoutMs);
    try {
      const r = await undiciFetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
        ...(fetchDispatcher ? { dispatcher: fetchDispatcher } : {}),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {string} webhookUrl
   * @param {Record<string, unknown>} payload
   */
  async function postWebhook(webhookUrl, payload) {
    // 已配置代理时直接用 undici+ProxyAgent（经验证可用）；Playwright request 不会走 Chrome 代理且易超时
    if (fetchDispatcher) {
      await postWebhookHttp(webhookUrl, payload, "Node+proxy");
      return;
    }

    if (browserPost) {
      if (config.webhookForwardLog) {
        const preview = String(payload.content ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        log.info(`POST (Playwright) ${maskWebhookUrl(webhookUrl)} | ${preview}`);
      }
      try {
        await browserPost(webhookUrl, payload);
        return;
      } catch (e) {
        log.warn(`Playwright POST 失败，回退 Node: ${/** @type {Error} */ (e).message}`);
      }
    }

    await postWebhookHttp(webhookUrl, payload, "Node");
  }

  /**
   * @param {DiscordMessageRow} row
   * @returns {Promise<{ skipped?: string }>}
   */
  async function forward(row) {
    if (!cfg.enabled) return { skipped: "disabled" };

    const channelId = String(row.channelId ?? "").trim();
    const guildId = String(row.guildId ?? "").trim();
    const messageId = String(row.messageId ?? "").trim();
    if (!channelId || !messageId) return { skipped: "missing_ids" };

    const rule = findWebhookForward(channelId, guildId, cfg);
    if (!rule) return { skipped: "no_rule" };

    const content = String(row.content ?? "").trim();
    const attach = attachmentUrls(row.rawJson);
    const embeds = embedTexts(row.rawJson);
    if (!content && !attach.length && !embeds.length) return { skipped: "empty" };

    const dedupKey = `${channelId}:${messageId}`;
    if (!remember(dedupKey)) return { skipped: "duplicate" };

    const payload = formatPayload(row, rule);
    const author =
      String(row.authorGlobalName ?? "").trim() ||
      String(row.authorUsername ?? "").trim() ||
      "?";
    if (config.webhookForwardLog) {
      log.info(
        `准备转发 channel=${channelId} guild=${guildId || "?"} message=${messageId} author=${author}`
      );
    }
    try {
      await postWebhook(rule.webhookUrl, payload);
      if (config.webhookForwardLog) {
        log.info(
          `✓ 已转发 channel=${channelId} message=${messageId} → ${rule.name || maskWebhookUrl(rule.webhookUrl)}`
        );
      }
      return {};
    } catch (e) {
      seen.delete(dedupKey);
      const idx = seenOrder.indexOf(dedupKey);
      if (idx >= 0) seenOrder.splice(idx, 1);
      log.warn(
        `转发失败 channel=${channelId} message=${messageId}: ${formatFetchError(/** @type {Error} */ (e))}`
      );
      return { skipped: "send_failed" };
    }
  }

  /** @param {DiscordMessageRow} row */
  function enqueue(row) {
    if (!cfg.enabled || !cfg.forwards.length) return;
    const channelId = String(row.channelId ?? "").trim();
    const guildId = String(row.guildId ?? "").trim();
    if (!findWebhookForward(channelId, guildId, cfg)) return;
    void forward(row).then((res) => {
      if (
        config.webhookForwardLog &&
        res.skipped &&
        res.skipped !== "duplicate" &&
        res.skipped !== "no_rule"
      ) {
        log.info(
          `未转发 channel=${channelId} message=${row.messageId ?? "?"} reason=${res.skipped}`
        );
      }
    });
  }

  return {
    enqueue,
    forward,
    reload,
    /** @param {(url: string, payload: Record<string, unknown>) => Promise<void>} fn */
    setBrowserPost(fn) {
      browserPost = fn;
      log.info("Webhook 转发已绑定 Playwright APIRequest（非页面 fetch，避免 50067）");
    },
    get enabled() {
      return cfg.enabled && cfg.forwards.length > 0;
    },
    get ruleCount() {
      return cfg.forwards.length;
    },
  };
}
