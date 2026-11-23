/**
 * 巨鲸榜 KOL 频道 → Bitget 下单策略（模板 A/B、保证金、分批止盈）。
 * 配置：config/kolvip-bitget-autotrade.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kolvipScanVirtualChannelId } from "./kolvip-scan-config.js";

const _dir = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {"tp1_all" | "track2"} KolvipExecutionTemplate */

/**
 * @typedef {{
 *   key: string;
 *   name: string;
 *   namePatterns?: string[];
 *   channelIds?: string[];
 *   executionTemplate: KolvipExecutionTemplate;
 *   orderSizeUsdt: number;
 *   leverageCrypto?: number;
 *   leverageGold?: number;
 *   tpPartialRatios?: number[];
 *   tpSkipFirstLevel?: boolean;
 * }} KolvipBitgetPolicy
 */

const TEMPLATE_TP1 = {
  executionTemplate: /** @type {const} */ ("tp1_all"),
  tpPartialRatios: [1],
  tpSkipFirstLevel: false,
};

const TEMPLATE_TRACK2 = {
  executionTemplate: /** @type {const} */ ("track2"),
  /** 从 TP2 起：30% @TP2，跳过至 TP5 再 50%，余仓最后一档 */
  tpPartialRatios: [0.3, 0, 0, 0.5, 1],
  tpSkipFirstLevel: true,
};

/** @returns {string} */
export function defaultKolvipBitgetAutotradePath() {
  const unified = path.join(_dir, "..", "config", "kolvip-autotrade.json");
  const legacy = path.join(_dir, "..", "config", "kolvip-bitget-autotrade.json");
  if (fs.existsSync(unified)) return unified;
  return legacy;
}

/** @param {string} channelId @param {string} [kolvipChannelId] */
export function isKolvipAutotradeIngestChannel(channelId, kolvipChannelId) {
  const cfg = loadKolvipBitgetAutotrade();
  if (!cfg.enabled) return false;
  const want = new Set(listKolvipAutotradeChannelIds().map(String));
  const cid = String(channelId ?? "").trim();
  if (cid && want.has(cid)) return true;
  const kid = String(kolvipChannelId ?? "").trim();
  if (kid && want.has(kolvipScanVirtualChannelId(kid))) return true;
  return false;
}

/** @returns {string[]} Bitget/WEEX 白名单（可由 JSON 一键复制到 .env） */
export function listKolvipAutotradeChannelIds() {
  const cfg = loadKolvipBitgetAutotrade();
  if (Array.isArray(cfg.autoTradeChannelIds) && cfg.autoTradeChannelIds.length) {
    return [...cfg.autoTradeChannelIds];
  }
  const ids = new Set();
  for (const p of cfg.policies) {
    for (const id of p.channelIds ?? []) ids.add(String(id));
  }
  return [...ids];
}

/** @returns {{ enabled: boolean; policies: KolvipBitgetPolicy[]; autoTradeChannelIds?: string[]; marginDefaultUsdt?: { queen?: number; others?: number } }} */
export function loadKolvipBitgetAutotrade(filePath = defaultKolvipBitgetAutotradePath()) {
  const p = path.resolve(String(filePath ?? "").trim() || defaultKolvipBitgetAutotradePath());
  if (!fs.existsSync(p)) return { enabled: false, policies: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const policies = Array.isArray(raw?.channels)
      ? raw.channels
      : Array.isArray(raw?.policies)
        ? raw.policies
        : [];
    return {
      enabled: raw?.enabled !== false,
      policies: policies
        .filter((x) => x && typeof x === "object")
        .map((x) => /** @type {KolvipBitgetPolicy} */ (x)),
      autoTradeChannelIds: Array.isArray(raw?.autoTradeChannelIds)
        ? raw.autoTradeChannelIds.map(String)
        : undefined,
      marginDefaultUsdt:
        raw?.marginDefaultUsdt && typeof raw.marginDefaultUsdt === "object"
          ? /** @type {{ queen?: number; others?: number }} */ (raw.marginDefaultUsdt)
          : undefined,
    };
  } catch {
    return { enabled: false, policies: [] };
  }
}

/** @param {string} s */
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\s·|｜\-_—（）()[\]【】vip合约频道信号日内]/gi, "");
}

/**
 * @param {string} channelId
 * @param {string} [channelName]
 * @returns {KolvipBitgetPolicy | null}
 */
export function resolveKolvipBitgetPolicy(channelId, channelName) {
  const cfg = loadKolvipBitgetAutotrade();
  if (!cfg.enabled || !cfg.policies.length) return null;
  const cid = String(channelId ?? "").trim();
  const cname = normName(channelName);
  for (const p of cfg.policies) {
    const ids = Array.isArray(p.channelIds) ? p.channelIds.map(String) : [];
    if (cid && ids.includes(cid)) return enrichTemplate(p);
    for (const pat of p.namePatterns ?? []) {
      const np = normName(pat);
      if (np && cname && (cname.includes(np) || np.includes(cname))) return enrichTemplate(p);
    }
  }
  return null;
}

/** @param {KolvipBitgetPolicy} p */
function enrichTemplate(p) {
  const t = p.executionTemplate === "tp1_all" ? TEMPLATE_TP1 : TEMPLATE_TRACK2;
  return {
    ...p,
    ...t,
    executionTemplate: t.executionTemplate,
    tpPartialRatios: p.tpPartialRatios ?? t.tpPartialRatios,
    tpSkipFirstLevel: p.tpSkipFirstLevel ?? t.tpSkipFirstLevel,
  };
}

/**
 * 单笔保证金 USDT：优先卡片/频道已解析值，否则频道 policy.orderSizeUsdt（统一默认 2）。
 * @param {Record<string, unknown> | null | undefined} parsed
 * @param {Record<string, unknown> | null | undefined} channelTrade
 */
export function resolveKolvipMarginUsdt(parsed, channelTrade) {
  const fromParsed = Number(parsed?.kolvipOrderSizeUsdt);
  if (Number.isFinite(fromParsed) && fromParsed > 0) return fromParsed;
  const fromCh = Number(channelTrade?.orderSizeUsdt);
  if (Number.isFinite(fromCh) && fromCh > 0) return fromCh;
  const cfg = loadKolvipBitgetAutotrade();
  const key = String(channelTrade?.kolvipPolicyKey ?? parsed?.kolvipPolicyKey ?? "").trim();
  if (key) {
    const pol = cfg.policies.find((p) => p.key === key);
    if (pol && Number(pol.orderSizeUsdt) > 0) return Number(pol.orderSizeUsdt);
  }
  const defs = cfg.marginDefaultUsdt && typeof cfg.marginDefaultUsdt === "object"
    ? /** @type {{ queen?: number; others?: number }} */ (cfg.marginDefaultUsdt)
    : {};
  return Number(defs.others) > 0 ? Number(defs.others) : 2;
}

/** @param {string} symbol @param {KolvipBitgetPolicy | null} policy */
export function leverageForKolvipSymbol(symbol, policy) {
  const s = String(symbol ?? "").toUpperCase();
  const gold = Number(policy?.leverageGold) > 0 ? Number(policy.leverageGold) : 50;
  const major = Number(policy?.leverageMajor) > 0 ? Number(policy.leverageMajor) : 100;
  const crypto = Number(policy?.leverageCrypto) > 0 ? Number(policy.leverageCrypto) : 20;
  if (/XAU|XAG|GOLD|PAXG/.test(s)) return gold;
  const bare = s.replace(/(USDT|USDC|BUSD)$/, "");
  if (bare === "BTC" || bare === "ETH") return major;
  return crypto;
}