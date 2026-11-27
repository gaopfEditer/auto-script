/**
 * OpenMausBot 广场筛选 webhook（config/plaza-bot-webhook.json，不进 git）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";

const _dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {{
 *   enabled?: boolean;
 *   name?: string;
 *   url?: string;
 *   endpoint?: string;
 *   authorization_bearer?: string;
 *   note?: string;
 * }} PlazaBotWebhookConfig
 */

/** @returns {string} */
export function defaultPlazaBotWebhookPath() {
  return path.join(_dir, "..", "config", "plaza-bot-webhook.json");
}

/**
 * @param {unknown} raw
 * @returns {PlazaBotWebhookConfig & { enabled: boolean }}
 */
function normalizeConfig(raw) {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const url = String(root.url ?? "").trim();
  const bearer = String(root.authorization_bearer ?? root.bearer ?? "").trim();
  return {
    enabled: root.enabled !== false && Boolean(url),
    name: root.name != null ? String(root.name) : undefined,
    url,
    endpoint: String(root.endpoint ?? "").trim() || undefined,
    authorization_bearer: bearer || undefined,
    note: root.note != null ? String(root.note) : undefined,
  };
}

/**
 * @param {string} [filePath]
 * @returns {PlazaBotWebhookConfig & { enabled: boolean }}
 */
export function loadPlazaBotWebhookConfig(filePath = config.plazaBotWebhookFile) {
  const p = path.resolve(String(filePath ?? "").trim() || defaultPlazaBotWebhookPath());
  if (!fs.existsSync(p)) {
    return { enabled: false };
  }
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return { enabled: false };
  }
}