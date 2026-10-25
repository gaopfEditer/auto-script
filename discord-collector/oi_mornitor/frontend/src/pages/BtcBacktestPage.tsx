import { useNavigate } from "react-router-dom";
import { BtcBacktestView } from "../components/BtcBacktestView";
import { MercuHeader } from "../components/MercuHeader";
import { useRadarSSE } from "../hooks/useRadarSSE";
import { useSpecialFocus } from "../hooks/useSpecialFocus";

export function BtcBacktestPage() {
  const { snapshot, online } = useRadarSSE();
  const { symbols: focusSymbols, entries: focusEntries, remove: removeFocus } = useSpecialFocus();
  const navigate = useNavigate();

  return (
    <div className="mercu-app" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <MercuHeader
        online={online}
        scanTs={snapshot.scan_ts}
        poolMeta={snapshot.pool_meta}
        poolSize={snapshot.pool_size}
        focusSymbols={focusSymbols}
        focusEntries={focusEntries}
        onRemoveFocus={(sym) => void removeFocus(sym)}
      />
      <div style={{ flex: 1, overflowY: "auto" }}>
        <BtcBacktestView
          onOpenChartAt={(symbol, tf) => {
            navigate(`/patterns?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`);
          }}
        />
      </div>
    </div>
  );
}
