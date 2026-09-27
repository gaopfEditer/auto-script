import { memo, useCallback, useState } from "react";
import {
  TRAIN_DISPLAY_TFS,
  candlesForTf,
  sessionCutTs,
  visibleCountForCandles,
} from "../../train/multiTf";
import type { SimTrade, TrainDisplayTf, TrainSession } from "../../train/types";
import {
  DEFAULT_CHART_LAYERS,
  TRAIN_CHART_LAYER_TOGGLES,
  type ChartLayers,
} from "../../utils/chartLayers";
import { TrainBlindChart } from "./TrainBlindChart";

interface Props {
  session: TrainSession;
  timeframe: TrainDisplayTf;
  onTimeframeChange: (tf: TrainDisplayTf) => void;
  revealAll?: boolean;
  trades?: SimTrade[];
  pickPriceMode?: "high" | "low" | "none";
  onPickPrice?: (price: number) => void;
  highlightTradeId?: string | null;
}

export const TrainChartPanel = memo(function TrainChartPanel({
  session,
  timeframe,
  onTimeframeChange,
  revealAll = false,
  trades = [],
  pickPriceMode = "none",
  onPickPrice,
  highlightTradeId = null,
}: Props) {
  const [layers, setLayers] = useState<ChartLayers>(() => ({ ...DEFAULT_CHART_LAYERS }));

  const cutTs = sessionCutTs(session);
  const candles = candlesForTf(session, timeframe);
  const visibleCount = visibleCountForCandles(candles, cutTs, revealAll);
  const showTrades = timeframe === "15m";

  const toggleLayer = useCallback((key: keyof ChartLayers) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return (
    <div className="pattern-chart-panel train-chart-panel">
      <header className="pattern-chart-head">
        <div className="pattern-chart-head-top">
          <div className="pattern-chart-title">
            <div>
              <div className="pattern-chart-symbol-row">
                <span className="pattern-chart-symbol">盲K · {timeframe}</span>
              </div>
              <div className="pattern-chart-meta train-chart-meta">
                可见 {visibleCount}/{candles.length} 根 · 推进按 {timeframe} 计
              </div>
            </div>
          </div>
          <div className="pattern-chart-head-actions">
            <div className="mercu-timeframes pattern-chart-tf">
              {TRAIN_DISPLAY_TFS.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  className={`tf-btn ${tf === timeframe ? "active" : ""}`}
                  onClick={() => onTimeframeChange(tf)}
                  disabled={!candlesForTf(session, tf).length}
                >
                  {tf}
                </button>
              ))}
            </div>
            <div className="pattern-chart-layers" role="group" aria-label="图表图层">
              {TRAIN_CHART_LAYER_TOGGLES.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`layer-btn ${layers[key] ? "active" : ""}`}
                  onClick={() => toggleLayer(key)}
                  title={layers[key] ? `隐藏${label}` : `显示${label}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="train-chart-body-single">
        {!candles.length ? (
          <p className="train-muted train-chart-empty">该周期无数据，请开新一局</p>
        ) : (
          <TrainBlindChart
            candles={candles}
            visibleCount={visibleCount}
            revealAll={revealAll}
            layers={layers}
            trades={trades}
            showTrades={showTrades}
            highlightTradeId={highlightTradeId}
            pickPriceMode={showTrades ? pickPriceMode : "none"}
            onPickPrice={showTrades ? onPickPrice : undefined}
          />
        )}
      </div>
    </div>
  );
});
