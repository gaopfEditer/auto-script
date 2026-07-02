/**
 * 源频道 → Discord Webhook 转发映射（JSON 文件）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";

const _dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {{
 *   name?: string;
 *   guildId?: string;
 *   channelId: string;
 *   webhookUrl: string;
 *   enabled?: boolean;
 * }} WebhookForwardRule
 *
 * @typedef {{ enabled?: boolean; forwards: WebhookForwardRule[] }} WebhookForwardConfig
 */

/** @returns {string} */
export function defaultWebhookForwardsPath() {
  return path.join(_dir, "..", "config", "channel-webhook-forwards.json");
}

/**
 * @param {unknown} raw
 * @returns {WebhookForwardConfig}
 */
function normalizeConfig(raw) {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const list = Array.isArray(root.forwards) ? root.forwards : [];
  /** @type {WebhookForwardRule[]} */
  const forwards = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    const channelId = String(o.channelId ?? "").trim();
    const webhookUrl = String(o.webhookUrl ?? "").trim();
    if (!channelId || !webhookUrl) continue;
    forwards.push({
      name: o.name != null ? String(o.name) : undefined,
      guildId: String(o.guildId ?? "").trim() || undefined,
      channelId,
      webhookUrl,
      enabled: o.enabled !== false,
    });
  }
  return {
    enabled: root.enabled !== false,
    forwards,
  };
}

/**
 * @param {string} [filePath]
 * @returns {WebhookForwardConfig}
 */
export function loadWebhookForwardConfig(filePath = config.webhookForwardsFile) {
  const p = path.resolve(String(filePath ?? "").trim() || defaultWebhookForwardsPath());
  if (!fs.existsSync(p)) {
    return { enabled: false, forwards: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return normalizeConfig(raw);
  } catch {
    return { enabled: false, forwards: [] };
  }
}

/**
 * @param {string} channelId
 * @param {string} [guildId]
 * @param {WebhookForwardConfig} cfg
 * @returns {WebhookForwardRule | null}
 */
export function findWebhookForward(channelId, guildId, cfg) {
  const cid = String(channelId ?? "").trim();
  const gid = String(guildId ?? "").trim();
  if (!cid || !cfg?.enabled) return null;
  for (const rule of cfg.forwards) {
    if (!rule.enabled || rule.channelId !== cid) continue;
    if (rule.guildId && gid && rule.guildId !== gid) continue;
    return rule;
  }
  return null;
}
