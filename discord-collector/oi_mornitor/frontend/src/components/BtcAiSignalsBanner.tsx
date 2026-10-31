import { memo, useCallback, useEffect, useState } from "react";
import type { AiJudgmentResult } from "./AiJudgePanel";

export interface BtcSignalRecord {
  dedup_key?: string;
  symbol?: string;
  timeframe?: string;
  signal_name?: string;
  signal_kind?: string;
  side?: string;
  bar_ts?: number;
  price?: number;
  entry_price?: number;
  stop_loss?: number;
  confidence_pct?: number;
  confidence_band?: string;
  tight_sl_strategy?: Record<string, any> | null;
  triggered_at?: string;
  telegram_pushed?: boolean;
  formatted_text?: string;
  judgment?: AiJudgmentResult & {
    confidence_pct?: number;
    confidence_band?: string;
    tight_sl_strategy?: Record<string, any> | null;
    tp?: any;
    sl?: any;
  };
}

interface Props {
  onOpenBtcChart?: (tf: string) => void;
  onOpenBacktest?: () => void;
}

const BTC_TFS = ["15m", "1h", "4h", "1d"] as const;
const TARGET_SYMS = ["BTC", "ETH"] as const;

export const BtcAiSignalsBanner = memo(function BtcAiSignalsBanner({
  onOpenBtcChart,
  onOpenBacktest,
}: Props) {
  const [items, setItems] = useState<BtcSignalRecord[]>([]);
  const [activeSym, setActiveSym] = useState<"BTC" | "ETH">("BTC");
  const [busyTf, setBusyTf] = useState<string | null>(null);
  const [skipLlmMode, setSkipLlmMode] = useState(false);
  const [pushTgMode, setPushTgMode] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const fetchFeed = useCallback(async () => {
    try {
      const r = await fetch("/api/ai-judge/btc-signals?limit=20");
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d?.items)) {
        setItems(d.items);
      }
    } catch {
      // ignore poll error
    }
  }, []);

  useEffect(() => {
    void fetchFeed();
    const timer = window.setInterval(() => void fetchFeed(), 15000);
    return () => window.clearInterval(timer);
  }, [fetchFeed]);

  const triggerSignalTf = useCallback(
    async (sym: "BTC" | "ETH", tf: string) => {
      setBusyTf(`${sym}_${tf}`);
      setErr("");
      try {
        const r = await fetch("/api/ai-judge/btc-signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: `${sym}USDT`,
            timeframe: tf,
            signal_kind: tf === "15m" ? `tight_sl_15m_${sym.toLowerCase()}` : `manual_${tf}`,
            signal_name: tf === "15m" ? `${sym} 15m 小止损策略研判` : `${sym} ${tf} 信号研判`,
            bar_ts: Math.floor(Date.now() / 1000),
            skip_llm: skipLlmMode,
            push_telegram: pushTgMode,
            force: true,
          }),
        });
        const d = await r.json();
        if (!r.ok || d?.ok === false) {
          setErr(d?.error || `HTTP ${r.status}`);
        } else {
          await fetchFeed();
          setExpanded(true);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyTf(null);
      }
    },
    [skipLlmMode, pushTgMode, fetchFeed],
  );

  const latest = items[0] || null;
  const latestJ = latest?.judgment;
  const act = String(latestJ?.action || "WATCH").toUpperCase();
  const gatePass = latestJ?.gate_result === "pass";
  const latestSym = String(latest?.symbol || latestJ?.symbol || "BTC").replace(/USDT$/i, "");
  const latestConfPct =
    latest?.confidence_pct ??
    latestJ?.confidence_pct ??
    (latestJ?.confidence != null ? Math.round(Number(latestJ.confidence) * 100) : null);
  const latestBand = latest?.confidence_band || latestJ?.confidence_band || "";
  const latestTsl = latest?.tight_sl_strategy || latestJ?.tight_sl_strategy || null;

  return (
    <section
      className="btc-ai-signals-banner"
      style={{
        margin: "8px 0 12px",
        padding: "10px 14px",
        borderRadius: 10,
        background: "linear-gradient(90deg, rgba(26,32,44,0.95) 0%, rgba(23,25,35,0.95) 100%)",
        border: "1px solid rgba(246, 173, 85, 0.35)",
        fontSize: 12.5,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 5,
              background: "rgba(237, 137, 54, 0.2)",
              color: "#fbd38d",
              border: "1px solid rgba(237, 137, 54, 0.45)",
              fontWeight: 700,
              fontSize: 12,
            }}
          >
            🟠 BTC / ETH · 15m小止损 & 四周期自动研判流
          </span>
          {latest && latestJ ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <strong style={{ color: "#edf2f7" }}>
                最新 [{latestSym} · {latest.timeframe}] {latest.signal_name || `${latestSym} 信号`}
              </strong>
              {latestTsl?.matched && (
                <span
                  style={{
                    padding: "1px 7px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    background: "rgba(159, 122, 234, 0.24)",
                    color: "#e9d8fd",
                    border: "1px solid rgba(159, 122, 234, 0.5)",
                  }}
                >
                  🎯 15m小止损 (SL {latestTsl.sl_pct}% · {latestTsl.rr_tp1}R/{latestTsl.rr_tp2}R)
                </span>
              )}
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: 4,
                  fontSize: 11.5,
                  fontWeight: 700,
                  background: gatePass ? "rgba(72,187,120,0.2)" : "rgba(245,101,101,0.22)",
                  color: gatePass ? "#68d391" : "#fc8181",
                }}
              >
                门禁:{String(latestJ.gate_result || "").toUpperCase()}
              </span>
              <span
                style={{
                  padding: "1px 7px",
                  borderRadius: 4,
                  fontSize: 11.5,
                  fontWeight: 700,
                  background:
                    act === "LONG"
                      ? "rgba(38,166,154,0.22)"
                      : act === "SHORT"
                        ? "rgba(239,83,80,0.22)"
                        : "rgba(255,193,7,0.18)",
                  color:
                    act === "LONG" ? "#4db6ac" : act === "SHORT" ? "#ef5350" : "#ffd54f",
                }}
              >
                {act}
                {latestConfPct != null
                  ? ` · 信心指数 ${latestBand ? `${latestBand}·` : ""}${latestConfPct}%`
                  : ""}
              </span>
              <span style={{ color: "#cbd5e0", fontSize: 12 }}>
                入场:<strong>{latestJ.entry_watch ?? latestTsl?.entry ?? "—"}</strong> · 止损:
                <strong style={{ color: "#feb2b2" }}>{latestJ.sl_watch ?? latestTsl?.sl ?? "—"}</strong>
              </span>
              {latestJ.rationale ? (
                <span
                  style={{
                    color: "#a0aec0",
                    maxWidth: 380,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={latestJ.rationale}
                >
                  — {latestJ.rationale}
                </span>
              ) : null}
            </div>
          ) : (
            <span style={{ color: "#a0aec0", fontSize: 12 }}>
              当 BTC / ETH 在 15m 触发「形态+支撑压力+均线交叉」小止损共振或 1h/4h/1d 信号时，自动汇总四周期跑门禁+大模型并直推 TG
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden", border: "1px solid rgba(246,173,85,0.4)" }}>
            {TARGET_SYMS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setActiveSym(s)}
                style={{
                  padding: "2px 8px",
                  border: "none",
                  background: activeSym === s ? "rgba(237,137,54,0.38)" : "rgba(26,32,44,0.8)",
                  color: activeSym === s ? "#fbd38d" : "#a0aec0",
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "#cbd5e0",
              fontSize: 11.5,
              cursor: "pointer",
            }}
            title="勾选后只跑毫秒级硬门禁+15m小止损量化评分，不调大模型"
          >
            <input
              type="checkbox"
              checked={skipLlmMode}
              onChange={(e) => setSkipLlmMode(e.target.checked)}
            />
            仅门禁
          </label>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "#cbd5e0",
              fontSize: 11.5,
              cursor: "pointer",
            }}
            title="手动点击下列周期按钮时是否同步推送到 Telegram"
          >
            <input
              type="checkbox"
              checked={pushTgMode}
              onChange={(e) => setPushTgMode(e.target.checked)}
            />
            同步推TG
          </label>
          {BTC_TFS.map((tf) => {
            const key = `${activeSym}_${tf}`;
            return (
              <button
                key={tf}
                type="button"
                disabled={busyTf !== null}
                onClick={() => void triggerSignalTf(activeSym, tf)}
                style={{
                  padding: "3px 8px",
                  borderRadius: 5,
                  border: tf === "15m" ? "1px solid rgba(159, 122, 234, 0.65)" : "1px solid rgba(246, 173, 85, 0.45)",
                  background:
                    busyTf === key
                      ? "rgba(237, 137, 54, 0.45)"
                      : tf === "15m"
                        ? "rgba(159, 122, 234, 0.22)"
                        : "rgba(237, 137, 54, 0.16)",
                  color: tf === "15m" ? "#e9d8fd" : "#feebc8",
                  cursor: busyTf ? "wait" : "pointer",
                  fontSize: 11.5,
                  fontWeight: 600,
                }}
                title={`立即对 ${activeSym} ${tf} 运行多周期 AI 信号 & 小止损研判`}
              >
                {busyTf === key ? `${activeSym} ${tf}…` : `${activeSym} ${tf === "15m" ? "15m小止损" : tf}`}
              </button>
            );
          })}
          {onOpenBacktest && (
            <button
              type="button"
              onClick={onOpenBacktest}
              style={{
                padding: "3px 9px",
                borderRadius: 5,
                border: "1px solid rgba(72, 187, 120, 0.55)",
                background: "rgba(72, 187, 120, 0.18)",
                color: "#9ae6b4",
                cursor: "pointer",
                fontSize: 11.5,
                fontWeight: 700,
              }}
              title="查看多币种/多周期严格无未来数据 AI 回测报告"
            >
              📊 多周期AI回测
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              padding: "3px 8px",
              borderRadius: 5,
              border: "1px solid rgba(160, 174, 192, 0.3)",
              background: "rgba(255,255,255,0.05)",
              color: "#cbd5e0",
              cursor: "pointer",
              fontSize: 11.5,
            }}
          >
            {expanded ? "收起记录" : `记录 (${items.length})`}
          </button>
        </div>
      </div>

      {err ? (
        <div style={{ color: "#fc8181", marginTop: 6, fontSize: 11.5 }}>触发失败：{err}</div>
      ) : null}

      {expanded ? (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            gap: 10,
          }}
        >
          {items.length === 0 ? (
            <div style={{ color: "#718096", fontSize: 12 }}>
              暂无 BTC/ETH 15m/1h/4h/1d 自动研判记录，可点击上方「BTC/ETH 15m小止损」立即生成。
            </div>
          ) : (
            items.slice(0, 8).map((rec, idx) => {
              const j = rec.judgment || ({} as any);
              const symLabel = String(rec.symbol || j.symbol || "BTC").replace(/USDT$/i, "");
              const key = rec.dedup_key || `${symLabel}-${rec.timeframe}-${idx}`;
              const copyText = rec.formatted_text || j.formatted_text || "";
              const confPct =
                rec.confidence_pct ??
                j.confidence_pct ??
                (j.confidence != null ? Math.round(Number(j.confidence) * 100) : null);
              const tsl = rec.tight_sl_strategy || j.tight_sl_strategy || null;
              return (
                <div
                  key={key}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: "rgba(0,0,0,0.35)",
                    border: tsl?.matched ? "1px solid rgba(159, 122, 234, 0.45)" : "1px solid rgba(255,255,255,0.08)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <strong style={{ color: "#fbd38d" }}>
                        {symLabel} · {rec.timeframe} · {rec.signal_name || "信号"}
                      </strong>
                      {confPct != null && (
                        <span
                          style={{
                            padding: "1px 6px",
                            borderRadius: 4,
                            fontSize: 10.5,
                            fontWeight: 700,
                            background: confPct >= 68 ? "rgba(72,187,120,0.22)" : "rgba(236,201,75,0.2)",
                            color: confPct >= 68 ? "#68d391" : "#f6e05e",
                          }}
                        >
                          信心 {confPct}%
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {rec.telegram_pushed ? (
                        <span style={{ color: "#68d391", fontSize: 10.5 }}>✓已推TG</span>
                      ) : null}
                      {onOpenBtcChart && rec.timeframe ? (
                        <button
                          type="button"
                          onClick={() => onOpenBtcChart(rec.timeframe || "15m")}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#90cdf4",
                            cursor: "pointer",
                            fontSize: 11,
                            padding: 0,
                          }}
                        >
                          看K线
                        </button>
                      ) : null}
                      {copyText ? (
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard?.writeText(copyText);
                            setCopiedKey(key);
                            setTimeout(() => setCopiedKey(null), 1500);
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#9ae6b4",
                            cursor: "pointer",
                            fontSize: 11,
                            padding: 0,
                          }}
                        >
                          {copiedKey === key ? "✓已复制" : "复制直推文案"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 8,
                      borderRadius: 6,
                      background: "rgba(0,0,0,0.45)",
                      color: "#e2e8f0",
                      fontSize: 11,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      lineHeight: 1.45,
                    }}
                  >
                    {copyText || j.rationale || "—"}
                  </pre>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
});
