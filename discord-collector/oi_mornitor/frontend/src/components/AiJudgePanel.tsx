import { memo, useCallback, useEffect, useState } from "react";

export interface AiJudgmentResult {
  symbol?: string;
  tier?: string;
  signal_tf?: string;
  signal_name?: string;
  price?: number;
  gate_result?: "pass" | "reject" | string;
  gate_reasons?: string[];
  gates_skipped?: string[];
  action?: "LONG" | "SHORT" | "WATCH" | "NO_TRADE" | string;
  confidence?: number;
  entry_watch?: string | number | null;
  sl_watch?: string | number | null;
  conflicts?: string[];
  evidence_refs?: string[];
  rationale?: string;
  formatted_text?: string;
  checked_at?: string;
  llm?: {
    quick_model?: string;
    deep_model?: string;
    technical?: string;
    flow_oi?: string;
    bull?: string;
    bear?: string;
  } | null;
}

interface Props {
  symbol: string;
  timeframe: string;
  signalName?: string;
}

const ACTION_COLOR: Record<string, { bg: string; fg: string; border: string }> = {
  LONG: { bg: "rgba(38, 166, 154, 0.18)", fg: "#4db6ac", border: "rgba(38, 166, 154, 0.5)" },
  SHORT: { bg: "rgba(239, 83, 80, 0.18)", fg: "#ef5350", border: "rgba(239, 83, 80, 0.5)" },
  WATCH: { bg: "rgba(255, 193, 7, 0.16)", fg: "#ffd54f", border: "rgba(255, 193, 7, 0.45)" },
  NO_TRADE: { bg: "rgba(158, 158, 158, 0.14)", fg: "#b0bec5", border: "rgba(158, 158, 158, 0.35)" },
};

export const AiJudgePanel = memo(function AiJudgePanel({
  symbol,
  timeframe,
  signalName,
}: Props) {
  const [judgment, setJudgment] = useState<AiJudgmentResult | null>(null);
  const [snapshotObj, setSnapshotObj] = useState<Record<string, unknown> | null>(null);
  const [busyMode, setBusyMode] = useState<"full" | "gates" | null>(null);
  const [err, setErr] = useState("");
  const [showCopy, setShowCopy] = useState(false);
  const [showLlmDetail, setShowLlmDetail] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadLatest = useCallback(async (sym: string) => {
    try {
      const r = await fetch(`/api/ai-judge/latest?symbol=${encodeURIComponent(sym)}`);
      if (!r.ok) return;
      const data = await r.json();
      if (data?.ok && data.judgment) {
        setJudgment(data.judgment);
        if (data.snapshot) setSnapshotObj(data.snapshot);
      } else {
        setJudgment(null);
      }
    } catch {
      // ignore initial miss
    }
  }, []);

  useEffect(() => {
    setErr("");
    setJudgment(null);
    setSnapshotObj(null);
    void loadLatest(symbol);
  }, [symbol, loadLatest]);

  const runJudge = useCallback(
    async (skipLlm: boolean) => {
      setBusyMode(skipLlm ? "gates" : "full");
      setErr("");
      try {
        const r = await fetch("/api/ai-judge/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol,
            interval: timeframe,
            skip_llm: skipLlm,
            signal_meta: signalName ? { signal_name: signalName, timeframe } : { timeframe },
          }),
        });
        const data = await r.json();
        if (!r.ok || data?.ok === false) {
          setErr(data?.error || `HTTP ${r.status}`);
        } else {
          setJudgment(data.judgment || data);
          if (data.snapshot) setSnapshotObj(data.snapshot);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyMode(null);
      }
    },
    [symbol, timeframe, signalName],
  );

  const copyFormatted = useCallback(() => {
    if (!judgment?.formatted_text) return;
    void navigator.clipboard?.writeText(judgment.formatted_text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [judgment]);

  const act = String(judgment?.action || "NO_TRADE").toUpperCase();
  const actStyle = ACTION_COLOR[act] || ACTION_COLOR.NO_TRADE;
  const gatePass = judgment?.gate_result === "pass";

  return (
    <div
      className="ai-judge-box"
      style={{
        marginTop: 10,
        padding: "10px 12px",
        borderRadius: 8,
        background: "rgba(17, 23, 34, 0.88)",
        border: "1px solid rgba(99, 179, 237, 0.25)",
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <strong style={{ color: "#90cdf4", fontSize: 12.5 }}>
          ⚡ AI 门禁与综合研判 ({timeframe})
        </strong>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            disabled={busyMode !== null}
            onClick={() => void runJudge(true)}
            style={{
              padding: "3px 8px",
              borderRadius: 5,
              border: "1px solid rgba(144, 205, 244, 0.35)",
              background: "rgba(43, 108, 176, 0.22)",
              color: "#bee3f8",
              cursor: busyMode ? "wait" : "pointer",
              fontSize: 11.5,
            }}
            title="只跑硬门禁（毫秒级，不调大模型）"
          >
            {busyMode === "gates" ? "门禁检测中…" : "仅测门禁"}
          </button>
          <button
            type="button"
            disabled={busyMode !== null}
            onClick={() => void runJudge(false)}
            style={{
              padding: "3px 9px",
              borderRadius: 5,
              border: "1px solid rgba(72, 187, 120, 0.55)",
              background: "rgba(47, 133, 90, 0.35)",
              color: "#c6f6d5",
              cursor: busyMode ? "wait" : "pointer",
              fontWeight: 600,
              fontSize: 11.5,
            }}
            title="组装 15m/1h/4h/1d 多周期快照 → 硬门禁 → 多角色大模型研判"
          >
            {busyMode === "full" ? "AI 深度研判中…" : "AI 综合研判"}
          </button>
        </div>
      </div>

      {err ? (
        <p style={{ color: "#fc8181", margin: "4px 0" }}>研判异常：{err}</p>
      ) : null}

      {judgment ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span
              style={{
                padding: "2px 7px",
                borderRadius: 4,
                fontWeight: 700,
                fontSize: 11.5,
                background: gatePass ? "rgba(72, 187, 120, 0.2)" : "rgba(245, 101, 101, 0.22)",
                color: gatePass ? "#68d391" : "#fc8181",
                border: `1px solid ${gatePass ? "rgba(72, 187, 120, 0.45)" : "rgba(245, 101, 101, 0.45)"}`,
              }}
            >
              门禁: {String(judgment.gate_result || "").toUpperCase()}
            </span>
            <span
              style={{
                padding: "2px 8px",
                borderRadius: 4,
                fontWeight: 700,
                fontSize: 11.5,
                background: actStyle.bg,
                color: actStyle.fg,
                border: `1px solid ${actStyle.border}`,
              }}
            >
              {act}
              {judgment.confidence != null ? ` · ${Math.round(Number(judgment.confidence) * 100)}%` : ""}
            </span>
            {judgment.tier ? (
              <span style={{ color: "#a0aec0", fontSize: 11 }}>
                [{judgment.tier} · {judgment.signal_tf || timeframe}]
              </span>
            ) : null}
          </div>

          {judgment.gate_reasons && judgment.gate_reasons.length > 0 ? (
            <div style={{ color: "#feb2b2", fontSize: 11.5 }}>
              <strong>否决原因：</strong>
              {judgment.gate_reasons.join("；")}
            </div>
          ) : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              background: "rgba(0,0,0,0.25)",
              padding: "5px 8px",
              borderRadius: 5,
            }}
          >
            <div>
              <span style={{ color: "#a0aec0" }}>观察入场：</span>
              <strong style={{ color: "#e2e8f0" }}>{judgment.entry_watch ?? "—"}</strong>
            </div>
            <div>
              <span style={{ color: "#a0aec0" }}>观察止损：</span>
              <strong style={{ color: "#feb2b2" }}>{judgment.sl_watch ?? "—"}</strong>
            </div>
          </div>

          {judgment.conflicts && judgment.conflicts.length > 0 ? (
            <div style={{ color: "#fbd38d", fontSize: 11.5 }}>
              <strong>冲突项：</strong>
              {judgment.conflicts.join("、")}
            </div>
          ) : null}

          {judgment.rationale ? (
            <div style={{ color: "#e2e8f0", lineHeight: 1.45 }}>
              <span style={{ color: "#a0aec0" }}>结论逻辑：</span>
              {judgment.rationale}
            </div>
          ) : null}

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
            {judgment.formatted_text ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowCopy((v) => !v)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#63b3ed",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 11,
                  }}
                >
                  {showCopy ? "收起标准推送文案" : "展开标准推送文案"}
                </button>
                <button
                  type="button"
                  onClick={copyFormatted}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#9ae6b4",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 11,
                  }}
                >
                  {copied ? "✓ 已复制" : "复制文案"}
                </button>
              </>
            ) : null}
            {judgment.llm ? (
              <button
                type="button"
                onClick={() => setShowLlmDetail((v) => !v)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#b794f4",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 11,
                }}
              >
                {showLlmDetail ? "收起多席位辩论" : "查看多席位报告"}
              </button>
            ) : null}
            {judgment.checked_at ? (
              <span style={{ color: "#718096", fontSize: 10.5, marginLeft: "auto" }}>
                {judgment.checked_at.replace("T", " ").slice(0, 19)}
              </span>
            ) : null}
          </div>

          {showCopy && judgment.formatted_text ? (
            <pre
              style={{
                margin: "4px 0 0",
                padding: 8,
                borderRadius: 5,
                background: "rgba(0,0,0,0.45)",
                color: "#e2e8f0",
                fontSize: 11,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              {judgment.formatted_text}
            </pre>
          ) : null}

          {showLlmDetail && judgment.llm ? (
            <div
              style={{
                marginTop: 4,
                padding: 8,
                borderRadius: 5,
                background: "rgba(0,0,0,0.4)",
                color: "#cbd5e0",
                fontSize: 11,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                maxHeight: 240,
                overflowY: "auto",
              }}
            >
              <div>
                <strong style={{ color: "#90cdf4" }}>[Technical]</strong> {judgment.llm.technical}
              </div>
              <div>
                <strong style={{ color: "#9ae6b4" }}>[Flow/OI]</strong> {judgment.llm.flow_oi}
              </div>
              <div>
                <strong style={{ color: "#68d391" }}>[Bull]</strong> {judgment.llm.bull}
              </div>
              <div>
                <strong style={{ color: "#fc8181" }}>[Bear]</strong> {judgment.llm.bear}
              </div>
            </div>
          ) : null}
          {snapshotObj ? null : null}
        </div>
      ) : (
        <p style={{ color: "#718096", margin: 0, fontSize: 11.5 }}>
          点击「仅测门禁」或「AI 综合研判」生成当前币种 15m/1h/4h/1d 多周期研判结论。
        </p>
      )}
    </div>
  );
});
