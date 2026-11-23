/**
 * /eval（巨鲸源）：主指标与 kolvip 网页「博主胜率」/webu/sig/* 完全一致；本地卡片仅 localPath 对照。
 */
import { loadKolvipCatalogCache } from "./kolvip-api-catalog.js";
import { getKolvipEvalRankSource, kolvipLabelsMatch } from "./kolvip-eval-rank.js";
import { loadKolvipSigRank } from "./kolvip-sig-store.js";
import { resolveKolvipChannelIdForShow } from "./kolvip-channel-catchup.js";
import { kolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import { getKolvipChannelMappings } from "./kolvip-cdp-config.js";
import { config } from "./config.js";

/** @param {number} fromMs @param {number} toMs */
export function resolveKolvipSigRangeForEval(fromMs, toMs) {
  const spanDays = Math.max(1, Math.round((toMs - fromMs) / 86_400_000));
  if (spanDays <= 8) return "7";
  if (spanDays <= 35) return "30";
  return "all";
}

/** @param {{ name?: string, channel?: string }} row @param {import('./kolvip-api-catalog.js').KolvipCatalogChannel[]} catalog */
function resolveSigRowChannelId(row, catalog) {
  const labels = [row.name, row.channel].filter(Boolean).map(String);
  const names = config.discordShowSidebar?.namesByChannelId ?? {};
  for (const m of getKolvipChannelMappings()) {
    for (const lab of labels) {
      if (kolvipLabelsMatch(lab, m.logicName)) {
        return m.discordChannelId;
      }
    }
  }
  for (const [discordId, showName] of Object.entries(names)) {
    for (const lab of labels) {
      if (kolvipLabelsMatch(lab, showName)) {
        return String(discordId);
      }
    }
  }
  for (const c of catalog) {
    for (const lab of labels) {
      if (kolvipLabelsMatch(lab, c.name)) {
        const kid = String(c.kolvipChannelId);
        const curated = getKolvipChannelMappings().find((m) => m.kolvipChannelId === kid);
        return curated?.discordChannelId ?? kolvipScanVirtualChannelId(kid);
      }
    }
  }
  const kid = resolveKolvipChannelIdForShow(labels[0] || "");
  if (kid) {
    const curated = getKolvipChannelMappings().find((m) => m.kolvipChannelId === kid);
    return curated?.discordChannelId ?? kolvipScanVirtualChannelId(kid);
  }
  return "";
}

/**
 * @param {unknown} row
 */
export function kolvipSigMetricsFromRankRow(row) {
  const o = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : {};
  const wins = Number(o.wins) || 0;
  const losses = Number(o.losses) || 0;
  const count = Number(o.count) || wins + losses || 0;
  const winRate = count > 0 && Number.isFinite(Number(o.win_rate)) ? Number(o.win_rate) : null;
  const totalR = Number.isFinite(Number(o.r)) ? Number(o.r) : null;
  const avgR = count > 0 && totalR != null ? Math.round((totalR / count) * 100) / 100 : null;
  const be = Number(o.be) || 0;
  return {
    bloggerName: String(o.name ?? o.channel ?? "").trim(),
    winRate,
    totalR,
    avgR,
    pl: Number.isFinite(Number(o.pl)) ? Number(o.pl) : null,
    count,
    wins,
    losses,
    be,
    open: Number(o.open) || 0,
    maxLose: Number.isFinite(Number(o.max_lose)) ? Number(o.max_lose) : null,
    ranked: o.ranked === true,
  };
}

/** @param {unknown} row @param {import('./kolvip-api-catalog.js').KolvipCatalogChannel[]} catalog */
function indexSigRankRow(row, catalog) {
  const channelId = resolveSigRowChannelId(
    row && typeof row === "object" ? /** @type {{ name?: string, channel?: string }} */ (row) : {},
    catalog
  );
  if (!channelId) return null;
  const metrics = kolvipSigMetricsFromRankRow(row);
  return { channelId, metrics, raw: row };
}

/** 与 card-eval-path-quality.EVAL_PATH_PNL_ABS_MAX 一致 */
const PATH_PNL_ABS_MAX = 1_500;
const PATH_AVG_PNL_ABS_MAX = 800;

/** @param {Record<string, unknown>} metrics */
function isPathPnlSane(metrics) {
  const total = Number(metrics.totalPnlPct);
  const avg = Number(metrics.avgPnlPct);
  if (Number.isFinite(total) && Math.abs(total) > PATH_PNL_ABS_MAX) return false;
  if (Number.isFinite(avg) && Math.abs(avg) > PATH_AVG_PNL_ABS_MAX) return false;
  return true;
}

/** @param {Record<string, unknown>} metrics */
function snapshotLocalPath(metrics) {
  return {
    cardCount: Number(metrics.cardCount) || 0,
    winCount: Number(metrics.winCount) || 0,
    lossCount: Number(metrics.lossCount) || 0,
    pendingCount: Number(metrics.pendingCount) || 0,
    winRate: metrics.winRate ?? null,
    totalPnlPct: Number.isFinite(Number(metrics.totalPnlPct)) ? Number(metrics.totalPnlPct) : null,
    avgPnlPct:
      metrics.avgPnlPct != null && Number.isFinite(Number(metrics.avgPnlPct)) ? Number(metrics.avgPnlPct) : null,
    tp1Hits: Number(metrics.tp1Hits) || 0,
    tp2Hits: Number(metrics.tp2Hits) || 0,
    tp3Hits: Number(metrics.tp3Hits) || 0,
    excludedCorrupt: Number(metrics.excludedCorrupt) || 0,
    pathPnlReliable: isPathPnlSane(metrics) && !(Number(metrics.excludedCorrupt) > 0),
  };
}

/**
 * @param {number} fromMs
 * @param {number} toMs
 */
export async function buildKolvipSigEvalOverlay(fromMs, toMs) {
  const range = resolveKolvipSigRangeForEval(fromMs, toMs);
  const data = await loadKolvipSigRank(range);
  const list = Array.isArray(data?.list) ? data.list : [];
  const catalog = (await loadKolvipCatalogCache()).channels ?? [];
  /** @type {Map<string, ReturnType<typeof kolvipSigMetricsFromRankRow>>} */
  const byChannelId = new Map();
  /** @type {Map<string, ReturnType<typeof kolvipSigMetricsFromRankRow>>} */
  const byBloggerName = new Map();
  /** @type {Map<string, unknown>} */
  const rawByChannelId = new Map();
  for (const row of list) {
    const m = kolvipSigMetricsFromRankRow(row);
    if (m.bloggerName) byBloggerName.set(m.bloggerName, m);
    const hit = indexSigRankRow(row, catalog);
    if (!hit?.channelId) continue;
    byChannelId.set(hit.channelId, hit.metrics);
    rawByChannelId.set(hit.channelId, hit.raw);
    const kid = resolveKolvipChannelIdForShow(hit.channelId);
    if (kid) {
      const scanId = kolvipScanVirtualChannelId(kid);
      byChannelId.set(scanId, hit.metrics);
      rawByChannelId.set(scanId, hit.raw);
    }
  }
  const rangeLabel = range === "7" ? "近7天" : range === "30" ? "近30天" : "全部";
  return {
    available: list.length > 0,
    range,
    rangeLabel,
    minCount: Number(data?.min_count) || 5,
    openTotal: Number(data?.open) || 0,
    rankList: list,
    rankSource: getKolvipEvalRankSource(),
    byChannelId,
    byBloggerName,
    rawByChannelId,
    note:
      list.length > 0
        ? `主指标与 kolvip「博主胜率统计」${rangeLabel}一致（/webu/sig/* 镜像）；表内笔数/胜率/累计 R 均为网页字段`
        : "kolvip-sig 未同步：请 POST /api/kolvip/sig/sync 后刷新",
  };
}

/**
 * @param {ReturnType<typeof kolvipSigMetricsFromRankRow>} sig
 */
function evalRowFromKolvipSig(sig) {
  return {
    metricsSource: "kolvip_web",
    pnlDisplaySource: "kolvip_sig",
    pnlDisplayUnit: sig.totalR != null ? "R" : "none",
    cardCount: sig.count,
    winCount: sig.wins,
    lossCount: sig.losses,
    pendingCount: sig.open,
    winRate: sig.winRate,
    totalPnlPct: sig.totalR,
    avgPnlPct: sig.avgR,
    tp1Hits: 0,
    tp2Hits: 0,
    tp3Hits: 0,
    sig,
  };
}

/**
 * @param {Record<string, unknown>} channelRow
 * @param {Awaited<ReturnType<typeof buildKolvipSigEvalOverlay>>} overlay
 */
export function applyKolvipSigToEvalChannel(channelRow, overlay) {
  const cid = String(channelRow.channelId ?? "").trim();
  let sig = overlay.byChannelId.get(cid);
  if (!sig) {
    const label = String(channelRow.channelName ?? "").trim();
    if (label && overlay.byBloggerName?.size) {
      sig = overlay.byBloggerName.get(label) ?? null;
      if (!sig) {
        for (const [name, m] of overlay.byBloggerName) {
          if (kolvipLabelsMatch(label, name)) {
            sig = m;
            break;
          }
        }
      }
    }
  }
  const localPath = snapshotLocalPath(channelRow);
  if (!sig) {
    const label = String(channelRow.channelName ?? "").trim() || String(channelRow.channelId ?? "").trim();
    return {
      channelId: channelRow.channelId,
      channelName: label || "—",
      rank: channelRow.rank,
      localPath,
      kolvipSigMissing: true,
      metricsSource: "kolvip_sig_missing",
      pnlDisplaySource: "none",
      pnlDisplayUnit: "none",
      cardCount: null,
      winCount: null,
      lossCount: null,
      pendingCount: null,
      winRate: null,
      totalPnlPct: null,
      avgPnlPct: null,
      tp1Hits: localPath.tp1Hits,
      tp2Hits: localPath.tp2Hits,
      tp3Hits: localPath.tp3Hits,
      sig: null,
    };
  }
  return {
    ...evalRowFromKolvipSig(sig),
    channelId: channelRow.channelId,
    channelName: sig.bloggerName || channelRow.channelName,
    rank: channelRow.rank,
    localPath,
    kolvipSigMissing: false,
    pathPnlReliable: localPath.pathPnlReliable,
  };
}

/**
 * @param {string[]} rankedChannelIds
 * @param {Awaited<ReturnType<typeof buildKolvipSigEvalOverlay>>} overlay
 */
/**
 * 全站上榜博主（ranked=true）合计，直接对 rank 行求和，与网页榜单区一致。
 * @param {unknown[]} rankList
 */
export function aggregateKolvipSigRankedBoardFromList(rankList) {
  let wins = 0;
  let losses = 0;
  let totalR = 0;
  let count = 0;
  let open = 0;
  let be = 0;
  let plWeighted = 0;
  let bloggerCount = 0;
  for (const row of rankList) {
    if (row && typeof row === "object" && row.ranked === false) continue;
    const m = kolvipSigMetricsFromRankRow(row);
    bloggerCount += 1;
    wins += m.wins;
    losses += m.losses;
    count += m.count;
    open += m.open;
    be += m.be || 0;
    if (m.pl != null && m.count > 0) plWeighted += m.pl * m.count;
    if (m.totalR != null) totalR += m.totalR;
  }
  const decided = wins + losses;
  const winRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null;
  return {
    bloggerCount,
    wins,
    losses,
    be,
    decided,
    count,
    open,
    totalR: Math.round(totalR * 100) / 100,
    winRate,
    avgR: count > 0 ? Math.round((totalR / count) * 100) / 100 : null,
    avgPl: count > 0 && plWeighted > 0 ? Math.round((plWeighted / count) * 100) / 100 : null,
  };
}

/** @param {Awaited<ReturnType<typeof buildKolvipSigEvalOverlay>>} overlay */
export function aggregateKolvipSigRankedBoard(overlay) {
  return aggregateKolvipSigRankedBoardFromList(overlay.rankList);
}

export function aggregateKolvipSigForChannelIds(rankedChannelIds, overlay) {
  let wins = 0;
  let losses = 0;
  let totalR = 0;
  let count = 0;
  let open = 0;
  let be = 0;
  let plWeighted = 0;
  let mapped = 0;
  for (const cid of rankedChannelIds) {
    const sig = overlay.byChannelId.get(String(cid ?? "").trim());
    if (!sig) continue;
    mapped += 1;
    wins += sig.wins;
    losses += sig.losses;
    count += sig.count;
    open += sig.open;
    be += sig.be || 0;
    if (sig.pl != null && sig.count > 0) plWeighted += sig.pl * sig.count;
    if (sig.totalR != null) totalR += sig.totalR;
  }
  const decided = wins + losses;
  const winRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null;
  return {
    bloggerCount: mapped,
    wins,
    losses,
    be,
    decided,
    count,
    open,
    totalR: Math.round(totalR * 100) / 100,
    winRate,
    avgR: count > 0 ? Math.round((totalR / count) * 100) / 100 : null,
    avgPl: count > 0 && plWeighted > 0 ? Math.round((plWeighted / count) * 100) / 100 : null,
  };
}

/**
 * @param {Record<string, unknown>} localOverall
 * @param {string[]} rankedChannelIds
 * @param {Awaited<ReturnType<typeof buildKolvipSigEvalOverlay>>} overlay
 * @param {{ focusChannelId?: string, topN?: number }} [opts]
 */
export function applyKolvipSigToEvalOverall(localOverall, rankedChannelIds, overlay, opts = {}) {
  const localPath = snapshotLocalPath(localOverall);
  const focusChannelId = String(opts.focusChannelId ?? "").trim();

  if (!overlay.available) {
    return {
      ...localOverall,
      localPath,
      metricsSource: "local_path",
      pnlDisplayUnit: "pct_margin",
    };
  }

  if (focusChannelId) {
    const sig = overlay.byChannelId.get(focusChannelId);
    if (sig) {
      return {
        ...evalRowFromKolvipSig(sig),
        localPath,
        kolvipScopeLabel: sig.bloggerName,
        kolvipAvgPl: sig.pl,
        metricsSource: "kolvip_web",
      };
    }
  }

  const agg = aggregateKolvipSigForChannelIds(rankedChannelIds, overlay);
  const topN = Number(opts.topN) || rankedChannelIds.length;
  return {
    metricsSource: "kolvip_web",
    pnlDisplaySource: "kolvip_sig",
    pnlDisplayUnit: "R",
    cardCount: agg.count,
    winCount: agg.wins,
    lossCount: agg.losses,
    pendingCount: agg.open,
    winRate: agg.winRate,
    totalPnlPct: agg.totalR,
    avgPnlPct: agg.avgR,
    tp1Hits: localPath.tp1Hits,
    tp2Hits: localPath.tp2Hits,
    tp3Hits: localPath.tp3Hits,
    sigWinCount: agg.wins,
    sigLossCount: agg.losses,
    sigAggregateR: agg.totalR,
    sigBloggerCount: agg.bloggerCount,
    kolvipAvgPl: agg.avgPl ?? null,
    kolvipBeCount: agg.be,
    kolvipScopeLabel: `胜率榜前 ${topN}（网页合计）`,
    localPath,
    noteLocalPath:
      localPath.cardCount > 0
        ? `本地归档 ${localPath.cardCount} 张卡 / 路径清算胜率 ${localPath.winRate != null ? `${localPath.winRate}%` : "—"}（仅供对照，不作主指标）`
        : null,
  };
}