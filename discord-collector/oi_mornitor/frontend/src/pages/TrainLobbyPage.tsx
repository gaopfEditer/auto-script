import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSpecialFocus } from "../hooks/useSpecialFocus";
import { createTrainSession } from "../train/createSession";
import { DEFAULT_TRAIN_CONFIG } from "../train/defaults";
import {
  exportSessionsJson,
  getActiveSessionId,
  getSession,
  loadCapitalDefaults,
  loadTrainConfig,
  saveCapitalDefaults,
  saveTrainConfig,
  upsertSession,
} from "../train/storage";
import type { TrainConfig, TrainPresetId, TrainTimeframe } from "../train/types";

const TF_OPTIONS: TrainTimeframe[] = ["5m", "15m", "1h", "4h", "1d"];

export function TrainLobbyPage() {
  const nav = useNavigate();
  const { symbols: focusSymbols } = useSpecialFocus();
  const [config, setConfig] = useState<TrainConfig>(() => ({
    ...loadTrainConfig(),
    capital: loadCapitalDefaults(),
  }));
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const activeId = getActiveSessionId();
  const active = activeId ? getSession(activeId) : undefined;

  const symbolText = useMemo(() => config.symbols.join(", "), [config.symbols]);

  const patch = (partial: Partial<TrainConfig>) => {
    setConfig((c) => {
      const next = { ...c, ...partial };
      saveTrainConfig(next);
      saveCapitalDefaults(next.capital);
      return next;
    });
  };

  const importFocus = () => {
    patch({ symbols: [...new Set(focusSymbols.map((s) => s.toUpperCase()))] });
  };

  const start = async (random: boolean) => {
    setErr("");
    setLoading(true);
    try {
      const cfg = {
        ...config,
        randomizeSymbol: random ? config.randomizeSymbol : false,
        randomizeTimeframe: random ? config.randomizeTimeframe : false,
        randomizeStart: true,
      };
      const session = await createTrainSession(cfg);
      upsertSession(session);
      nav(`/train/session/${session.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="train-lobby">
      <aside className="train-howto">
        <h2>一局怎么玩</h2>
        <ol>
          <li>选条件或一键随机，系统抽取历史片段</li>
          <li>只展示起点及之前 N 根 K 线</li>
          <li>先填「当前判断」，才能下一根 / 下 5 根 / 播放</li>
          <li>可随时模拟下单（入、出、止损止盈）</li>
          <li>结束揭晓后市，对照计划 vs 结果</li>
          <li>写一句复盘才能保存</li>
        </ol>
        <p className="train-howto-warn">未提交判断，禁止往前走。</p>
      </aside>

      <section className="train-lobby-main">
        {active?.status === "running" ? (
          <div className="train-resume-banner">
            有进行中的局：
            <button type="button" onClick={() => nav(`/train/session/${active.id}`)}>
              继续 #{active.id.slice(0, 8)}
            </button>
          </div>
        ) : null}

        <div className="train-form-grid">
          <label>
            币种（逗号分隔）
            <input
              value={symbolText}
              onChange={(e) =>
                patch({
                  symbols: e.target.value
                    .split(/[,，\s]+/)
                    .map((s) => s.trim().toUpperCase())
                    .filter(Boolean),
                })
              }
            />
            <button type="button" className="train-link-btn" onClick={importFocus}>
              从自选导入
            </button>
          </label>

          <label>
            周期
            <div className="train-chips">
              {TF_OPTIONS.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  className={config.timeframes.includes(tf) ? "active" : ""}
                  onClick={() => {
                    const set = new Set(config.timeframes);
                    if (set.has(tf)) set.delete(tf);
                    else set.add(tf);
                    patch({ timeframes: [...set] as TrainTimeframe[] });
                  }}
                >
                  {tf}
                </button>
              ))}
            </div>
          </label>

          <label>
            可见历史（根）
            <input
              type="number"
              min={80}
              max={500}
              value={config.lookbackBars}
              onChange={(e) => patch({ lookbackBars: Number(e.target.value) || 200 })}
            />
          </label>
          <label>
            本局推进（根）
            <input
              type="number"
              min={50}
              max={500}
              value={config.sessionBars}
              onChange={(e) => patch({ sessionBars: Number(e.target.value) || 200 })}
            />
          </label>
          <label>
            续载阈值（剩余 ≤ 根时预加载）
            <input
              type="number"
              min={10}
              max={200}
              value={config.extendThresholdBars ?? 50}
              onChange={(e) => patch({ extendThresholdBars: Number(e.target.value) || 50 })}
            />
          </label>

          <fieldset className="train-presets">
            <legend>快捷预设</legend>
            {(
              [
                ["naked", "裸K"],
                ["structure", "结构 MA20/60"],
                ["full", "复盘实战（带提示）"],
              ] as const
            ).map(([id, label]) => (
              <label key={id} className="train-radio">
                <input
                  type="radio"
                  name="preset"
                  checked={config.preset === id}
                  onChange={() => patch({ preset: id as TrainPresetId })}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <label className="train-check">
            <input
              type="checkbox"
              checked={config.hideSymbol}
              onChange={(e) => patch({ hideSymbol: e.target.checked })}
            />
            双盲：隐藏币名
          </label>
          <label className="train-check">
            <input
              type="checkbox"
              checked={config.hideDate}
              onChange={(e) => patch({ hideDate: e.target.checked })}
            />
            双盲：隐藏日期
          </label>

          <fieldset>
            <legend>资金</legend>
            <label>
              初始 U
              <input
                type="number"
                value={config.capital.initialBalance}
                onChange={(e) =>
                  patch({
                    capital: {
                      ...config.capital,
                      initialBalance: Number(e.target.value) || 10_000,
                    },
                  })
                }
              />
            </label>
            <label>
              单笔默认 U
              <input
                type="number"
                value={config.capital.defaultOrderUsdt}
                onChange={(e) =>
                  patch({
                    capital: {
                      ...config.capital,
                      defaultOrderUsdt: Number(e.target.value) || 100,
                    },
                  })
                }
              />
            </label>
            <label>
              手续费率
              <input
                type="number"
                step="0.0001"
                value={config.capital.feeRate}
                onChange={(e) =>
                  patch({
                    capital: { ...config.capital, feeRate: Number(e.target.value) || 0.0004 },
                  })
                }
              />
            </label>
          </fieldset>
        </div>

        {err ? <p className="train-error">{err}</p> : null}

        <div className="train-lobby-actions">
          <button type="button" disabled={loading} onClick={() => void start(true)}>
            {loading ? "抽段中…" : "一键随机开局"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => void start(false)}
          >
            按当前条件开局
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const blob = new Blob([exportSessionsJson()], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `train-sessions-${Date.now()}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            导出 JSON
          </button>
        </div>
      </section>
    </div>
  );
}
