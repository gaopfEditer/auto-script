import { useMemo, useState } from "react";
import { AlertFeed } from "../components/AlertFeed";
import { BreakoutToastStack } from "../components/BreakoutToastStack";
import { GlobalTrendPanel } from "../components/GlobalTrendPanel";
import { MarketMatrixGrid } from "../components/MarketMatrixGrid";
import { MercuHeader } from "../components/MercuHeader";
import { PageBootLoading } from "../components/PageBootLoading";
import { ToastStack } from "../components/ToastStack";
import { useRadarSSE } from "../hooks/useRadarSSE";
import { useSpecialFocus } from "../hooks/useSpecialFocus";
import type { OiTimeframe } from "../types";
import { deriveAllLists } from "../utils/deriveLists";

export function RadarPage() {
  const { snapshot, online, bootstrapping } = useRadarSSE();
  const bootBlocking =
    bootstrapping && !(snapshot.all_tickers?.length ?? 0);
  const { symbols: focusSymbols, entries: focusEntries, remove: removeFocus } = useSpecialFocus();
  const [timeframe, setTimeframe] = useState<OiTimeframe>("5m");
  const {
    all_tickers: all,
    hot_tickers: hot,
    meta,
    scan_ts: scanTs,
    alert_tickers: alertTickers,
    alert_scan_ts: alertScanTs,
    pool_size: poolSize,
    thresholds,
    radar_source: boardSource = "local",
    breakout_alerts: breakoutAlerts = [],
  } = snapshot;

  const boardRows = alertTickers?.length ? alertTickers : all;
  const alertTs = alertScanTs && alertScanTs > 0 ? alertScanTs : scanTs;
  const boardScanTs = alertScanTs && alertScanTs > 0 ? alertScanTs : scanTs;

  const lists = useMemo(() => deriveAllLists(boardRows, timeframe), [boardRows, timeframe]);

  return (
    <div className="mercu-app">
      <MercuHeader
        online={online}
        scanTs={boardScanTs}
        poolMeta={snapshot.pool_meta}
        poolSize={snapshot.pool_size}
        focusSymbols={focusSymbols}
        focusEntries={focusEntries}
        onRemoveFocus={(sym) => void removeFocus(sym)}
      />
      {bootBlocking ? (
        <PageBootLoading
          inset={false}
          message="加载 OI 雷达…"
          hint="首次打开需连接 SSE 并拉取全池快照，可能需十数秒"
        />
      ) : (
      <div className="mercu-body">
        <AlertFeed
          rows={boardRows}
          scanTs={alertTs}
          poolSize={poolSize}
          thresholds={thresholds}
          radarSource="local"
        />
        <MarketMatrixGrid
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
          price={lists.price}
          oi={lists.oi}
          contract={lists.contract}
          spot={lists.spot}
          takerFlowStatus={snapshot.pool_meta?.taker_flow_status}
          boardSource={boardSource}
        />
        <GlobalTrendPanel
          meta={meta}
          capitalConfluence={lists.capitalConfluence}
          capitalIntensity={lists.capitalIntensity}
          biasTf={timeframe}
        />
      </div>
      )}
      <ToastStack hot={hot} scanTs={scanTs} />
      <BreakoutToastStack alerts={breakoutAlerts} scanTs={scanTs} />
    </div>
  );
}
