import { memo, useCallback, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { OiTimeframe } from "../types";
import type { MatrixRow } from "../types";
import { fmtMk, fmtPct, fmtStr } from "../utils/format";
import { patternsPathForSymbol } from "../utils/patternNav";
import { displaySymbol } from "../utils/symbol";
import { CoinAvatar } from "./CoinAvatar";
import { MercuTimeframes } from "./MercuTimeframes";

const TICK_TF_LABELS = ["5m", "15m", "30m", "1h", "4h", "1d"] as const;

function TickMarks({ ticks, side }: { ticks?: number[]; side?: "up" | "down" }) {
  const vals = Array.isArray(ticks) && ticks.length ? ticks : [0.25, 0.25, 0.25, 0.25, 0.25, 0.25];
  const title = TICK_TF_LABELS.map((lab, i) => `${lab}:${Number(vals[i] ?? 0).toFixed(2)}`).join(" · ");
  return (
    <div className="res-ticks" aria-hidden title={title}>
      {vals.slice(0, 6).map((t, i) => (
        <span
          key={TICK_TF_LABELS[i] ?? i}
          className={`res-tick ${Number(t) >= 0.35 ? "on" : ""} ${side === "down" ? "down" : side === "up" ? "up" : ""}`}
          style={{ height: `${Math.max(2, Math.round(Number(t) * 10))}px` }}
        />
      ))}
    </div>
  );
}

function ResDots({ resonance, resonanceLong }: { resonance?: string[]; resonanceLong?: string[] }) {
  const winDots = [...(resonance || []), ...(resonanceLong || [])].slice(0, 6);
  if (!winDots.length) return null;
  return (
    <span className="res-dots" title={`共振: ${winDots.join(" · ")}`}>
      {winDots.map((w) => (
        <i key={w} className="res-dot" data-w={w} />
      ))}
    </span>
  );
}

type ValueMode = "pct" | "mk" | "str";

interface RankListProps {
  title: string;
  subtitle: string;
  rows: MatrixRow[];
  valueMode: ValueMode;
  /** 负向榜（流出/跌幅）：强制红色 */
  negativeBoard?: boolean;
  emptyText?: string;
  hoveredSymbol?: string | null;
  onHoverSymbol?: (symbol: string | null) => void;
  onSelectSymbol?: (symbol: string) => void;
}

function barValue(row: MatrixRow): number {
  return row.matrix_bar ?? Math.abs(row.matrix_score);
}

function formatValue(v: number, mode: ValueMode): string {
  if (mode === "pct") return fmtPct(v);
  if (mode === "str") return fmtStr(v);
  return fmtMk(v);
}

const RankList = memo(function RankList({
  title,
  subtitle,
  rows,
  valueMode,
  negativeBoard = false,
  emptyText = "暂无数据",
  hoveredSymbol = null,
  onHoverSymbol,
  onSelectSymbol,
}: RankListProps) {
  const maxBar = Math.max(...rows.map((r) => barValue(r)), 1);

  return (
    <section className="rank-panel">
      <div className="rank-panel-head">
        <h3>{title}</h3>
        <span>{subtitle}</span>
      </div>
      <ul className="rank-list">
        {rows.length === 0 ? (
          <li className="rank-empty">{emptyText}</li>
        ) : (
          rows.map((row) => {
            const v = row.matrix_score;
            const barPct = (barValue(row) / maxBar) * 100;
            const tone = negativeBoard ? "down" : "up";
            const sym = row.symbol.toUpperCase();
            const crossHover = Boolean(
              hoveredSymbol &&
                hoveredSymbol === sym,
            );

            return (
              <li
                key={`${title}-${subtitle}-${row.symbol}`}
                data-symbol={sym}
                className={`rank-item rank-item-bg ${tone}${crossHover ? " is-cross-hover" : ""}${onSelectSymbol ? " rank-item-clickable" : ""}`}
                style={{ "--bar-pct": `${Math.max(barPct, 6)}%` } as CSSProperties}
                onPointerEnter={() => onHoverSymbol?.(sym)}
                onPointerLeave={() => onHoverSymbol?.(null)}
                onClick={() => onSelectSymbol?.(sym)}
                title={onSelectSymbol ? `查看 ${displaySymbol(sym)} 形态 K 线` : undefined}
                role={onSelectSymbol ? "button" : undefined}
              >
                <span className="rank-badge">{row.matrix_rank}</span>
                <CoinAvatar symbol={row.symbol} variant="rank" />
                <div className="rank-sym-cell">
                  <span className="rank-symbol">${displaySymbol(row.symbol)}</span>
                  <ResDots resonance={row.resonance} resonanceLong={row.resonanceLong} />
                </div>
                <TickMarks ticks={row.ticks} side={row.side ?? (negativeBoard ? "down" : "up")} />
                <span className={`rank-value ${negativeBoard ? "neg" : "pos"}`}>
                  {formatValue(v, valueMode)}
                </span>
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
});

interface Block {
  gainersMagnitude: MatrixRow[];
  losersMagnitude: MatrixRow[];
  gainersStrength: MatrixRow[];
  losersStrength: MatrixRow[];
}

interface OiBlock {
  posMagnitude: MatrixRow[];
  negMagnitude: MatrixRow[];
  posStrength: MatrixRow[];
  negStrength: MatrixRow[];
}

interface FlowBlock {
  inMagnitude: MatrixRow[];
  outMagnitude: MatrixRow[];
  inStrength: MatrixRow[];
  outStrength: MatrixRow[];
}

interface Props {
  timeframe: OiTimeframe;
  onTimeframeChange: (tf: OiTimeframe) => void;
  price: Block;
  oi: OiBlock;
  contract: FlowBlock;
  spot: FlowBlock;
  /** live | cached | unavailable — 合约/现货 Taker 流向可用性 */
  takerFlowStatus?: string;
  /** binance=本机真差分；smartb=兜底榜单（涨跌幅可能不准） */
  boardSource?: string;
}

export const MarketMatrixGrid = memo(function MarketMatrixGrid({
  timeframe,
  onTimeframeChange,
  price,
  oi,
  contract,
  spot,
  takerFlowStatus,
  boardSource = "local",
}: Props) {
  const navigate = useNavigate();
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const onHoverSymbol = useCallback((symbol: string | null) => {
    setHoveredSymbol(symbol);
  }, []);
  const onSelectSymbol = useCallback(
    (symbol: string) => {
      navigate(patternsPathForSymbol(symbol));
    },
    [navigate],
  );

  const flowEmptyHint =
    takerFlowStatus === "unavailable"
      ? "暂无数据（币安 Taker 流向不可用，请检查代理）"
      : takerFlowStatus === "cached"
        ? "暂无数据（使用缓存中，等待刷新）"
        : "暂无数据";
  const contractEmpty = contract.inMagnitude.length === 0 && contract.outMagnitude.length === 0;
  const spotEmpty = spot.inMagnitude.length === 0 && spot.outMagnitude.length === 0;

  const listProps = { hoveredSymbol, onHoverSymbol, onSelectSymbol };

  return (
    <main className="panel matrix-center">
      <div className="matrix-center-head">
        <h2>
          热点观察榜单
          {boardSource === "smartb" ? (
            <span className="matrix-source-warn" title="本机币安扫描未就绪，涨跌幅来自 smart.b 兜底，与 K 线可能不一致">
              · smart.b 兜底
            </span>
          ) : null}
        </h2>
        <MercuTimeframes timeframe={timeframe} onTimeframeChange={onTimeframeChange} />
      </div>
      {(contractEmpty || spotEmpty) && takerFlowStatus && takerFlowStatus !== "live" ? (
        <p className="matrix-flow-hint">
          主力合约/现货流向：{flowEmptyHint}
          {takerFlowStatus === "cached" ? " · 展示缓存" : ""}
        </p>
      ) : null}

      <div className="matrix-quadrants">
        <div className="matrix-quadrant-grid">
          <RankList title="涨幅榜" subtitle={`${timeframe} · 量级`} rows={price.gainersMagnitude} valueMode="pct" {...listProps} />
          <RankList title="跌幅榜" subtitle={`${timeframe} · 量级`} rows={price.losersMagnitude} valueMode="pct" negativeBoard {...listProps} />
          <RankList title="涨速榜" subtitle={`${timeframe} · 强度`} rows={price.gainersStrength} valueMode="pct" {...listProps} />
          <RankList title="跌速榜" subtitle={`${timeframe} · 强度`} rows={price.losersStrength} valueMode="pct" negativeBoard {...listProps} />
        </div>

        <div className="matrix-quadrant-grid">
          <RankList title="持仓增" subtitle={`${timeframe} · 量级`} rows={oi.posMagnitude} valueMode="mk" {...listProps} />
          <RankList title="持仓减" subtitle={`${timeframe} · 量级`} rows={oi.negMagnitude} valueMode="mk" negativeBoard {...listProps} />
          <RankList title="持仓增" subtitle={`${timeframe} · 强度`} rows={oi.posStrength} valueMode="str" {...listProps} />
          <RankList title="持仓减" subtitle={`${timeframe} · 强度`} rows={oi.negStrength} valueMode="str" negativeBoard {...listProps} />
        </div>

        <div className="matrix-quadrant-grid">
          <RankList
            title="主力合约流入"
            subtitle={`${timeframe} · 量级`}
            rows={contract.inMagnitude}
            valueMode="mk"
            emptyText={contractEmpty ? flowEmptyHint : undefined}
            {...listProps}
          />
          <RankList title="主力合约流出" subtitle={`${timeframe} · 量级`} rows={contract.outMagnitude} valueMode="mk" negativeBoard emptyText={contractEmpty ? flowEmptyHint : undefined} {...listProps} />
          <RankList title="主力合约流入" subtitle={`${timeframe} · 强度`} rows={contract.inStrength} valueMode="mk" emptyText={contractEmpty ? flowEmptyHint : undefined} {...listProps} />
          <RankList title="主力合约流出" subtitle={`${timeframe} · 强度`} rows={contract.outStrength} valueMode="mk" negativeBoard emptyText={contractEmpty ? flowEmptyHint : undefined} {...listProps} />
        </div>

        <div className="matrix-quadrant-grid">
          <RankList title="主力现货流入" subtitle={`${timeframe} · 量级`} rows={spot.inMagnitude} valueMode="mk" emptyText={spotEmpty ? flowEmptyHint : undefined} {...listProps} />
          <RankList title="主力现货流出" subtitle={`${timeframe} · 量级`} rows={spot.outMagnitude} valueMode="mk" negativeBoard emptyText={spotEmpty ? flowEmptyHint : undefined} {...listProps} />
          <RankList title="主力现货流入" subtitle={`${timeframe} · 强度`} rows={spot.inStrength} valueMode="mk" emptyText={spotEmpty ? flowEmptyHint : undefined} {...listProps} />
          <RankList title="主力现货流出" subtitle={`${timeframe} · 强度`} rows={spot.outStrength} valueMode="mk" negativeBoard emptyText={spotEmpty ? flowEmptyHint : undefined} {...listProps} />
        </div>
      </div>
    </main>
  );
});
