/**
 * 巨鲸信号链路持久审计：入库/建卡、专群推送、推单门禁、下单结果、8787 CDP。
 * 按日追加 JSONL，不写密钥。失败不影响主流程。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const SECRET_KEY = /(token|secret|api[_-]?key|cookie|password|authorization|webhook|passphrase)/i;

/** @returns {string} */
export function defaultKolvipPipelineAuditDir() {
  return path.join(_dir, "..", "data", "kolvip-pipeline-audit");
}

/** @param {Date} [d] */
function dayFile(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return path.join(defaultKolvipPipelineAuditDir(), `${y}-${m}-${day}.jsonl`);
}

/** @param {unknown} v @param {number} [max] */
function clip(v, max = 240) {
  if (v == null) return v;
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : JSON.parse(s);
  } catch {
    return String(v).slice(0, max);
  }
}

/** @param {unknown} id */
export function auditCardId(id) {
  const raw = String(id ?? "").trim();
  if (!raw) return undefined;
  const m = raw.match(/^(?:SC-)?(\d+)$/i);
  return m ? Number(m[1]) : raw;
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
export function appendKolvipPipelineAudit(event, fields = {}) {
  const ev = String(event ?? "").trim();
  if (!ev) return null;
  /** @type {Record<string, unknown>} */
  const line = { at: new Date().toISOString(), event: ev };
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || v === "") continue;
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === "string" && SECRET_KEY.test(v) && /https?:\/\//i.test(v)) continue;
    line[k] = clip(v);
  }
  try {
    const dir = defaultKolvipPipelineAuditDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(dayFile(), `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
  return line;
}
