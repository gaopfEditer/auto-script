import type { CapitalBiasItem, MatrixRow, OiTimeframe, RankDomain, TickerRow } from "../types";
import { getOiWindow, getRankMetric } from "./timeframe";
import { fmtNum } from "./format";

const TOP = 7;

/** 与 mercu / smart.b 对齐的多周期轴（ticks 一格一期） */
const TICK_TFS: OiTimeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];
const SHORT_RES: OiTimeframe[] = ["5m", "15m", "30m", "1h", "4h"];
const LONG_RES: OiTimeframe[] = ["1d"];

type RankMode = "magnitude" | "strength";

function toMatrixRow(
  row: TickerRow,
  rank: number,
  score: number,
  barScore: number,
  category: string,
  tf: OiTimeframe,
  extra?: Pick<MatrixRow, "side" | "resonance" | "resonanceLong" | "ticks">,
): MatrixRow {
  const win = getOiWindow(row, tf);
  return {
    symbol: row.symbol,
    category,
    matrix_rank: rank,
    matrix_score: score,
    matrix_bar: barScore,
    last_price: row.last_price,
    price_change_pct_24h: row.price_change_pct_24h ?? 0,
    quote_volume: row.quote_volume,
    volume_rank: row.volume_rank,
    current_oi_usd: row.current_oi_usd,
    delta_5m_usd: win.delta_usd,
    pct_5m: win.pct,
    delta_15m_usd: win.delta_usd,
    pct_15m: win.pct,
    global_intensity_rank: row.global_intensity_rank,
    global_volume_rank: row.global_volume_rank,
    side: extra?.side,
    resonance: extra?.resonance,
    resonanceLong: extra?.resonanceLong,
    ticks: extra?.ticks,
  };
}

function eligible(rows: TickerRow[]): TickerRow[] {
  return rows.filter((r) => r.status !== "warming");
}

function pctFromRate(rate: number): number {
  return rate * 100;
}

/** 负向榜（流出/跌幅）显示负数；正向榜显示正数 */
function displayScore(
  m: ReturnType<typeof getRankMetric>,
  positive: boolean,
  unit: "pct" | "mk" | "str",
): number {
  if (unit === "str") {
    const s = Math.abs(m.intensity_score);
    return positive ? s : -s;
  }
  if (unit === "pct") return pctFromRate(m.change_rate);
  const abs = Math.abs(m.magnitude_usd);
  return positive ? abs : -abs;
}

function absRankScore(
  m: ReturnType<typeof getRankMetric>,
  unit: "pct" | "mk" | "str",
): number {
  if (unit === "str") return Math.abs(m.intensity_score);
  return unit === "pct" ? Math.abs(pctFromRate(m.change_rate)) : Math.abs(m.magnitude_usd);
}

function sameSide(m: ReturnType<typeof getRankMetric>, positive: boolean): boolean {
  return positive ? m.change_rate > 0 : m.change_rate < 0;
}

function sortKey(
  row: TickerRow,
  tf: OiTimeframe,
  domain: RankDomain,
  positive: boolean,
  mode: RankMode,
  unit: "pct" | "mk" | "str",
): number {
  const m = getRankMetric(row, tf, domain);
  if (mode === "strength") return Math.abs(m.intensity_score);
  return absRankScore(m, unit);
}

/** 各周期同侧 TOP 集合，用于跨周期共振 */
function buildTopSets(
  rows: TickerRow[],
  domain: RankDomain,
  positive: boolean,
  mode: RankMode,
  unit: "pct" | "mk" | "str",
): Record<OiTimeframe, Set<string>> {
  const pool = eligible(rows);
  const out = {} as Record<OiTimeframe, Set<string>>;
  for (const tf of TICK_TFS) {
    const picked = pool
      .filter((r) => sameSide(getRankMetric(r, tf, domain), positive))
      .sort(
        (a, b) =>
          sortKey(b, tf, domain, positive, mode, unit) -
          sortKey(a, tf, domain, positive, mode, unit),
      )
      .slice(0, TOP)
      .map((r) => r.symbol);
    out[tf] = new Set(picked);
  }
  return out;
}

function buildTicks(
  row: TickerRow,
  domain: RankDomain,
  positive: boolean,
  topSets: Record<OiTimeframe, Set<string>>,
): number[] {
  return TICK_TFS.map((w) => {
    const m = getRankMetric(row, w, domain);
    if (!sameSide(m, positive)) return 0.18;
    const inTop = topSets[w]?.has(row.symbol);
    const inten = Number(m.intensity_score) || 0;
    // intensity 常见 0~100；无强度时用上榜/同侧占位
    let t = inten > 1 ? inten / 100 : inten > 0 ? inten : inTop ? 0.72 : 0.42;
    t = Math.max(0.22, Math.min(0.95, t));
    // 同侧但未进 TOP 时略压暗，仍可 >=0.35 点亮
    if (!inTop) t = Math.min(t, 0.48);
    return Number(t.toFixed(2));
  });
}

function resonanceFields(
  row: TickerRow,
  tf: OiTimeframe,
  domain: RankDomain,
  positive: boolean,
  topSets: Record<OiTimeframe, Set<string>>,
): Pick<MatrixRow, "side" | "resonance" | "resonanceLong" | "ticks"> {
  const sym = row.symbol;
  return {
    side: positive ? "up" : "down",
    resonance: SHORT_RES.filter((w) => w !== tf && topSets[w]?.has(sym)),
    resonanceLong: LONG_RES.filter((w) => w !== tf && topSets[w]?.has(sym)),
    ticks: buildTicks(row, domain, positive, topSets),
  };
}

function deriveMagnitudeList(
  rows: TickerRow[],
  tf: OiTimeframe,
  domain: RankDomain,
  category: string,
  positive: boolean,
  unit: "pct" | "mk" | "str",
): MatrixRow[] {
  const topSets = buildTopSets(rows, domain, positive, "magnitude", unit);
  const picked = eligible(rows)
    .filter((r) => sameSide(getRankMetric(r, tf, domain), positive))
    .sort((a, b) => absRankScore(getRankMetric(b, tf, domain), unit) - absRankScore(getRankMetric(a, tf, domain), unit))
    .slice(0, TOP);

  return picked.map((r, i) => {
    const m = getRankMetric(r, tf, domain);
    const display = displayScore(m, positive, unit);
    const bar = absRankScore(m, unit);
    return toMatrixRow(r, i + 1, display, bar, category, tf, resonanceFields(r, tf, domain, positive, topSets));
  });
}

function deriveStrengthList(
  rows: TickerRow[],
  tf: OiTimeframe,
  domain: RankDomain,
  category: string,
  positive: boolean,
  unit: "pct" | "mk" | "str",
): MatrixRow[] {
  const topSets = buildTopSets(rows, domain, positive, "strength", unit);
  const picked = eligible(rows)
    .filter((r) => sameSide(getRankMetric(r, tf, domain), positive))
    .sort(
      (a, b) =>
        Math.abs(getRankMetric(b, tf, domain).intensity_score) -
        Math.abs(getRankMetric(a, tf, domain).intensity_score),
    )
    .slice(0, TOP);

  return picked.map((r, i) => {
    const m = getRankMetric(r, tf, domain);
    const display = displayScore(m, positive, unit);
    const bar = Math.abs(m.intensity_score) || absRankScore(m, unit);
    return toMatrixRow(r, i + 1, display, bar, category, tf, resonanceFields(r, tf, domain, positive, topSets));
  });
}

// ── 涨跌幅（单位 %）──

export function deriveGainersMagnitude(rows: TickerRow[], tf: OiTimeframe) {
  return deriveMagnitudeList(rows, tf, "price", "gainers_magnitude", true, "pct");
}

export function deriveLosersMagnitude(rows: TickerRow[], tf: OiTimeframe) {
  return deriveMagnitudeList(rows, tf, "price", "losers_magnitude", false, "pct");
}

export function deriveGainersStrength(rows: TickerRow[], tf: OiTimeframe) {
  return deriveStrengthList(rows, tf, "price", "gainers_strength", true, "pct");
}

export function deriveLosersStrength(rows: TickerRow[], tf: OiTimeframe) {
  return deriveStrengthList(rows, tf, "price", "losers_strength", false, "pct");
}

// ── 持仓（量级 M/K，强度 Str，与 smart.b 一致）──

export function deriveOiPumps(rows: TickerRow[], tf: OiTimeframe) {
  return deriveMagnitudeList(rows, tf, "oi", "oi_pumps", true, "mk");
}

export function deriveOiDumps(rows: TickerRow[], tf: OiTimeframe) {
  return deriveMagnitudeList(rows, tf, "oi", "oi_dumps", false, "mk");
}

export function deriveOiPumpStrength(rows: TickerRow[], tf: OiTimeframe) {
  return deriveStrengthList(rows, tf, "oi", "oi_pump_strength", true, "str");
}

export function deriveOiDumpStrength(rows: TickerRow[], tf: OiTimeframe) {
  return deriveStrengthList(rows, tf, "oi", "oi_dump_strength", false, "str");
}

// ── 合约流向（M/K）──

export function deriveContractInflow(rows: TickerRow[], tf: OiTimeframe) {
  return deriveMagnitudeList(rows, tf, "contract_flow", "contract_inflow", true, "mk");
}

export function deriveContractOutflow(rows: TickerRow[], tf: OiTimeframe) {
  return deriveMagnitudeList(rows, tf, "contract_flow", "contract_outflow", false, "mk");
}

export function deriveContractInflowStrength(rows: TickerRow[], tf: OiTimeframe) {
  return deriveStrengthList(rows, tf, "contract_flow", "contract_inflow_strength", true, "mk");
}

export function deriveContractOutflowStrength(rows: TickerRow[], tf: OiTimeframe) {
  return deriveStrengthList(rows, tf, "contract_flow", "contract_outflow_strength", false, "mk");
}

// ── 现货流向（M/K）──

export function deriveSpotInflow(rows: TickerRow[], tf: OiTimeframe) {
  return deriveMagnitudeList(rows, tf, "spot_flow", "spot_inflow", true, "mk");
}

export function deriveSpotOutflow(rows: TickerRow[], tf: OiTimeframe) {
  return deriveMagnitudeList(rows, tf, "spot_flow", "spot_outflow", false, "mk");
}

export function deriveSpotInflowStrength(rows: TickerRow[], tf: OiTimeframe) {
  return deriveStrengthList(rows, tf, "spot_flow", "spot_inflow_strength", true, "mk");
}

export function deriveSpotOutflowStrength(rows: TickerRow[], tf: OiTimeframe) {
  return deriveStrengthList(rows, tf, "spot_flow", "spot_outflow_strength", false, "mk");
}

// ── 右侧资金倾向 ──

function toBiasItem(
  row: TickerRow,
  rank: number,
  score: number,
  direction: "inflow" | "outflow",
): CapitalBiasItem {
  return {
    symbol: row.symbol,
    rank,
    direction,
    direction_label: direction === "inflow" ? "流入" : "流出",
    score,
    score_fmt: fmtNum(score),
  };
}

export function deriveCapitalConfluence(rows: TickerRow[], tf: OiTimeframe): CapitalBiasItem[] {
  const scored = eligible(rows)
    .map((row) => {
      const contract = getRankMetric(row, tf, "contract_flow").magnitude_usd;
      const spot = getRankMetric(row, tf, "spot_flow").magnitude_usd;
      const oiDelta = getOiWindow(row, tf).delta_usd;

      let score = 0;
      let direction: "inflow" | "outflow" = "inflow";

      if (contract * spot > 0) {
        score = Math.min(Math.abs(contract), Math.abs(spot));
        direction = contract > 0 ? "inflow" : "outflow";
      }
      if (oiDelta < 0 && spot > 0) {
        const rev = Math.abs(spot) + (contract < 0 ? Math.abs(contract) * 0.5 : 0);
        if (rev > score) {
          score = rev;
          direction = "inflow";
        }
      } else if (oiDelta > 0 && spot < 0) {
        const rev = Math.abs(spot) + (contract > 0 ? Math.abs(contract) * 0.5 : 0);
        if (rev > score) {
          score = rev;
          direction = "outflow";
        }
      }

      return { row, score, direction };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP);

  return scored.map((x, i) => toBiasItem(x.row, i + 1, x.score, x.direction));
}

export function deriveCapitalIntensity(rows: TickerRow[], tf: OiTimeframe): CapitalBiasItem[] {
  const scored = eligible(rows)
    .map((row) => {
      const contract = getRankMetric(row, tf, "contract_flow").magnitude_usd;
      const spot = getRankMetric(row, tf, "spot_flow").magnitude_usd;
      const total = contract + spot;
      const score = Math.abs(contract) + Math.abs(spot);
      const direction: "inflow" | "outflow" = total >= 0 ? "inflow" : "outflow";
      return { row, score, direction };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP);

  return scored.map((x, i) => toBiasItem(x.row, i + 1, x.score, x.direction));
}

export function deriveAllLists(rows: TickerRow[], tf: OiTimeframe) {
  return {
    price: {
      gainersMagnitude: deriveGainersMagnitude(rows, tf),
      losersMagnitude: deriveLosersMagnitude(rows, tf),
      gainersStrength: deriveGainersStrength(rows, tf),
      losersStrength: deriveLosersStrength(rows, tf),
    },
    oi: {
      posMagnitude: deriveOiPumps(rows, tf),
      negMagnitude: deriveOiDumps(rows, tf),
      posStrength: deriveOiPumpStrength(rows, tf),
      negStrength: deriveOiDumpStrength(rows, tf),
    },
    contract: {
      inMagnitude: deriveContractInflow(rows, tf),
      outMagnitude: deriveContractOutflow(rows, tf),
      inStrength: deriveContractInflowStrength(rows, tf),
      outStrength: deriveContractOutflowStrength(rows, tf),
    },
    spot: {
      inMagnitude: deriveSpotInflow(rows, tf),
      outMagnitude: deriveSpotOutflow(rows, tf),
      inStrength: deriveSpotInflowStrength(rows, tf),
      outStrength: deriveSpotOutflowStrength(rows, tf),
    },
    capitalConfluence: deriveCapitalConfluence(rows, tf),
    capitalIntensity: deriveCapitalIntensity(rows, tf),
  };
}
