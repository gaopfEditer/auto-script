import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DEFAULT_TRAIN_CONFIG } from "../train/defaults";
import { loadTrainConfig, saveTrainConfig } from "../train/storage";

export function TrainSettingsPage() {
  const nav = useNavigate();
  const [config, setConfig] = useState(() => loadTrainConfig());

  const save = () => {
    saveTrainConfig(config);
    nav("/train?new=1");
  };

  const patch = (partial: Partial<typeof config>) => {
    setConfig((c) => {
      const next = { ...c, ...partial };
      saveTrainConfig(next);
      return next;
    });
  };

  return (
    <div className="train-settings-page">
      <h1>盲K 开局设置</h1>
      <p className="train-muted">仅 K 线长度与续载；资金仍在对局内按默认保证金下单。</p>

      <div className="train-form-grid">
        <label>
          可见历史 lookbackBars
          <input
            type="number"
            min={80}
            max={500}
            value={config.lookbackBars}
            onChange={(e) => patch({ lookbackBars: Number(e.target.value) || DEFAULT_TRAIN_CONFIG.lookbackBars })}
          />
        </label>
        <label>
          首段长度 sessionBars（初始片段 + 每批续载至少 200）
          <input
            type="number"
            min={50}
            max={500}
            value={config.sessionBars}
            onChange={(e) => patch({ sessionBars: Number(e.target.value) || DEFAULT_TRAIN_CONFIG.sessionBars })}
          />
        </label>
        <label>
          续载阈值（剩余可见 K 线 ≤）
          <input
            type="number"
            min={10}
            max={200}
            value={config.extendThresholdBars}
            onChange={(e) =>
              patch({
                extendThresholdBars:
                  Number(e.target.value) || DEFAULT_TRAIN_CONFIG.extendThresholdBars,
              })
            }
          />
        </label>
      </div>

      <div className="train-actions">
        <button type="button" className="primary" onClick={save}>
          保存并开始新局
        </button>
        <Link to="/train" className="ghost">
          返回
        </Link>
      </div>
    </div>
  );
}
