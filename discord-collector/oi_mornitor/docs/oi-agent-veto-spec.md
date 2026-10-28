# OI 决策 Agent 接入规格：实时 Slim Veto + 周度强 Agent 校准

> 状态：规格（2026-10-28，拍板修订）· **本轮不改交易代码**  
> 角色定位：**Risk / Veto Officer**（否决官），不是第二套信号机 / 主观盘手  
> **已拍板**：默认 **shadow / 先不硬拦**；硬拦靠开关；全体数据验证有效后再开  
> 口径同步：与 `signal-logic.md`、`backtest-vs-live.md`、`ezcoin-adapter/gates.yaml`、`ai_judge_bridge.py` 并列维护

---

## 0. 一句话

形态 / 量能 / OI / KOL / 共振分只产**候选**；硬门禁砍掉不合格；实时只跑**瘦身否决席**（`pass | veto | size_down`）；全量 TradingAgents 只做**周复盘与规则校准**。胜率来自少做错的，不是更会讲多空。**默认不硬拦实盘**：始终算决策并落库（含 `would_veto` / `would_size_down`），用全体数据对照验证后再把 `SLIM_VETO_HARD_BLOCK` 拨到 `1`。

---

## 1. 角色边界

| 层 | 职责 | 允许 | 禁止 |
|----|------|------|------|
| **发现层** | `oi_mornitor`：雷达 OI、蜡烛/结构形态、量价、KOL 次级、`signal_confluence` 共振分、MAIN/山寨卡片 | 产候选、因子分、`typeLabel`、推送/入库 | 直接当下单理由；用叙事当方向 |
| **硬门禁** | `pattern_emit_gate` / `pattern_push_gate` / `signal_policy`；`ezcoin-adapter/gates.py` + `gates.yaml`（T1 / T1_EQ / ALT） | TTL、MTF、停推、量能、OI/强度、价 OI 协同、risk_off、session | 模型一票通过；绕过 `gate_result=reject` |
| **现有 5 席** | `ezcoin-adapter/judge.py`：tech / flow_oi / bull / bear / **trader** | 在硬门禁 **pass** 后产出 `action∈{LONG,SHORT,WATCH,NO_TRADE}` + SL/TP 建议 + rationale | 重算行情；编造 snapshot 没有的价位/OI；覆盖硬门禁 reject |
| **实时 Slim Veto（本规格新增）** | 否决官：在「可开仓意图」之后、**交易所下单之前** | 仅 `pass` / `veto` / `size_down` + 理由码 + 置信 | 反向开仓；自由散文开仓；发明新方向；自行扫所 |
| **离线强 Agent** | 全量 TradingAgents（`~/frontend/code/1.operations/TradingAgents`） | 周复盘、单币深挖、提出「加/删否决规则」草案 | 实时路径每笔辩论；直接改 `gates.yaml` 不经人工确认即生效 |
| **执行护栏** | `bitget-tpsl-guard.js`（`BITGET_REQUIRE_TPSL=1`）等 | 无 SL 拒开或平掉；核验/重试 | 裸仓放行 |

**数据流（实时）**

```
发现（形态/OI/KOL/共振） 
  → pattern_emit / push 门控 + 可选 confluence tier
  → ai_judge_bridge.build_ezcoin_snapshot → POST :5179/judge
       ├─ gates.apply_gates（硬门禁）
       └─ 5 席 LLM → action / sl / tp / confidence
  → 【Slim Veto】仅当意图为 LONG|SHORT 且 gate=pass
  → Bitget/WEEX 下单（须默认 TP/SL）
```

KOL / Discord 白名单自动下单（`bitget-order-from-signal.js`）若未走 5 席，仍须：硬规则过滤 → **同一 Slim Veto** → 下单。

---

## 2. 推荐接入点（相对 5 席）

### 推荐方案：**5 席之后加一层 Veto（不替换 trader）**

| 方案 | 做法 | 结论 |
|------|------|------|
| A. 替换 trader 为否决官 | 失去现有 LONG/SHORT + `formatted_text` TG 文案与 BTC 研判流 | ❌ 破坏现网 UX |
| B. **5 席后加 Veto** | trader 仍出方向/SL/TP；Veto 只做风险裁剪 | ✅ **推荐** |
| C. 砍成单席否决官、关 bull/bear | 可作 Phase2+ 的 `llm_mode=veto_only` 加速项 | 可选优化，不作第一步 |

**为何 B**

1. 与既有口径一致：硬门禁不能被模型否决；模型也不能一票通过——Veto 是**再砍一刀**，不是放行钥匙。  
2. 现网 `ai_judge_bridge` / `:5179` / TG「是否入场」依赖 trader 的 `action`/`sl`/`tp`。  
3. Veto 输入可复用 trader 结论 + 历史同类 setup 结算，专门回答「做不做 / 做多大」，避免和因子抢方向。  
4. Bitget 路径可共用同一 Veto schema，不强制每笔跑满 5 席（KOL 卡可 `llm_mode=trader_only` 或跳过 5 席只跑 Veto）。

**挂载代码落点（实现阶段，本轮不动代码）**

| 挂点 | 文件 / 服务 |
|------|-------------|
| 快照与 5 席出口 | `oi_mornitor/ai_judge_bridge.py` → `call_adapter_judge` 返回后 |
| 研判服务 | `ezcoin-adapter/judge.py` 在最终 `out` 组装后、写 `logs/judge-*.json` 前 |
| HTTP | `POST :5179/judge` 响应增加 `veto` 块；或独立 `POST :5179/veto` |
| 下单前 | `discord-collector/src/bitget-order-from-signal.js` / staged-order 入口 |
| 配置 | 新建 `ezcoin-adapter/veto_codes.yaml`（理由码表）；开关 env 见 §7 |

---

## 3. 实时输入 Schema（最小必要集）

包名建议：`VetoRequest`（`schema_version: "veto-1.0"`）。  
**原则**：只喂程序已算字段 + 结构化摘要；禁止整页新闻散文。

### 3.1 必填

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `schema_version` | string | 固定 | `"veto-1.0"` |
| `candidate_id` | string | 调用方 | 幂等键，如 `BTC:1h:shooting_star:<bar_ts>` 或 cardId |
| `symbol` / `tier` / `asset_class` | string | `build_ezcoin_snapshot` / `classify_tier_and_asset` | 与 snapshot 一致：`T1`/`T1_EQ`/`ALT` |
| `side_intent` | `long`\|`short` | trader `action` 或 KOL 卡方向 | 仅多空意图；WATCH/NO_TRADE **不进** Veto |
| `gate` | object | `gates.apply_gates` | 必含 `gate_result`（须为 `pass`）、`gate_reasons`、`gates_skipped`、`soft_warnings`、`risk_off_block_long` |
| `factor_scores` | object | 见下表 | 发现层因子，不作开仓叙事 |
| `setup_peer_summary` | object | 胜率库 / AI 回测库 | 近 N 笔同类结算摘要（§3.3） |
| `macro_window` | object | 日历/配置 | 至少 `fomc_or_cpi_within_h`、`label` |
| `sl_tp` | object | trader 或默认 staged | `sl_pct` 或 `sl` 价；缺 SL → **执行层拒开**，Veto 前也可直接 `veto`/`reject_pre` |
| `proposed_size_usdt` | number | 频道配置 / Bitget channel defaults | 供 `size_down` 缩放 |
| `ts` | ISO8601 | 调用时刻 | 与 snapshot TTL 对齐检查 |

### 3.2 `factor_scores`（必填子集，缺则标 `null` 并计入 `gates_skipped` 风格）

| 子字段 | 来源模块 | 备注 |
|--------|----------|------|
| `confluence_score` / `confluence_tier` | `signal_confluence.py` | A/B/C；与 `OI_CONFLUENCE_PUSH_MIN_TIER` 对齐 |
| `mtf_count` / `mtf_label` | `pattern_mtf_resonance` / `pattern_push_gate` | 如 ≥`OI_PATTERN_PUSH_MTF_MIN`(默认 2) |
| `volume_spike_x` | snapshot `tf.*.volume_spike_x` | 已过硬门禁量能 |
| `oi_chg_15m_pct` / `rank_intensity_global` / `price_oi_synergy` | snapshot `oi` | ALT 协同等 |
| `pattern_family` / `type_label` / `signal_tf` | 形态/卡片 | 族名用于 peer 匹配 |
| `kol_hit` | `kol_secondary_alert` / Discord 频道元数据 | bool + 可选频道名；KOL 路径必填 |

### 3.3 `setup_peer_summary`（必填结构，允许 `n=0`）

近 **N=30**（可配 `VETO_PEER_N`）笔：**同 tier + 同 side + 同 pattern_family**（不足则放宽到同 tier+side），且仅用 **signalAt ≤ 当前 ts** 的 Point-in-Time 样本（禁止未来结算泄漏）。

| 子字段 | 说明 |
|--------|------|
| `n` | 样本数 |
| `win_rate` | 胜率（列表 settle 口径或 PIT MFE>MAE 口径须在请求里声明 `peer_metric=settle|pit_mfe`） |
| `avg_mfe_4h_pct` / `avg_mae_4h_pct` | 对齐 `btc_1h_backtest` outcome 字段名 |
| `avg_mfe_8h_pct` / `avg_mae_8h_pct` | 同上 |
| `expectancy_hint` | 可选：简单 `avg(move)` 或 R 期望 |
| `veto_hit_rate_hist` | 可选：历史若启用 Veto 的命中占比（Phase1+） |

**口径声明（必须写进文档与请求）**

- **形态列表 settle**：`pattern_settle` / 胜率库 3h 统一 TP/SL——**不**与 AI 席混算。  
- **PIT gate+LLM**：`btc_1h_backtest` / `ai_btc_backtest_jobs` 的 +1h/+4h/+8h/+24h 与 `mfe_*`/`mae_*`——Veto 校准与「agent 有没有用」**默认用这套**。

### 3.4 可选

| 字段 | 来源 | 用途 |
|------|------|------|
| `trader_action` / `trader_confidence` / `trader_conflicts` | 5 席输出 | 冲突列表给否决理由 |
| `snapshot_refs` | evidence_refs | 短引用，非全文 dump |
| `is_main_whitelist` | `main_card_policy` / focus | 硬拦开启后的可选分级用；默认 shadow 仅记账 |
| `risk_off` | snapshot `market.risk_off` | 与门禁重复但便于 prompt |
| `funding_pct` / `long_short_ratio` | snapshot `market` | 拥挤度否决 |

---

## 4. 实时输出 Schema

仅允许下列 JSON（禁止自由开仓散文；`rationale` 最多一句且须对应 `reason_code`）：

```json
{
  "schema_version": "veto-1.0",
  "candidate_id": "BTC:1h:shooting_star:1730000000000",
  "decision": "pass",
  "reason_code": "OK",
  "confidence": 0.72,
  "size_mult": 1.0,
  "rationale": "同类 4h MFE≥MAE 且无宏观窗冲突。",
  "model": "slim-veto",
  "latency_ms": 800,
  "input_fingerprint": "sha256:..."
}
```

| 字段 | 约束 |
|------|------|
| `decision` | **仅** `pass` \| `veto` \| `size_down` |
| `reason_code` | 枚举见 §4.1；`pass` 时用 `OK` 或 `PASS_WEAK_PEER` |
| `confidence` | 0–1；解析失败 → 视为 `veto` + `PARSE_FAIL`（失败安全） |
| `size_mult` | `pass`→`1.0`；`size_down`→默认 `0.5`（可配）；`veto`→`0` |
| `rationale` | ≤120 字中文，禁止给出新方向或「建议改做空」 |

### 4.1 拒单 / 理由码表（`veto_codes.yaml`）

| reason_code | 典型触发 | 默认 decision |
|-------------|----------|---------------|
| `OK` | 无否决项 | pass |
| `PASS_WEAK_PEER` | peer n&lt;10，谨慎通过 | pass 或 size_down（可配） |
| `HARD_GATE_NOT_PASS` | 上游 gate≠pass（防御） | veto |
| `NO_SL` | 无有效止损 | veto（执行层亦拒） |
| `MACRO_WINDOW` | FOMC/CPI 等窗内且策略禁止新开 | veto 或 size_down |
| `PEER_EDGE_NEG` | 近 N 笔 avg_mfe_4h &lt; avg_mae_4h（或期望&lt;0） | veto |
| `PEER_MAE_SPIKE` | mae_8h 分位极端 | size_down 或 veto |
| `TF_SOFT_CONFLICT` | soft_warnings 含逆大周期 | size_down |
| `RISK_OFF_LONG` | risk_off 且意图 long | veto（对齐 `risk_off_block_long`） |
| `CROWDED_FUNDING` | funding 极端同向拥挤 | size_down |
| `CONFLUENCE_C` | 仅 C 档且未豁免 | veto 或 observation |
| `KOL_FACTOR_WEAK` | KOL 有信号但 OI/量能因子空心 | size_down |
| `TIMEOUT` | 超时 | **默认 fail-open**：与 shadow 一致，**不影响下单**，只记日志；仅当 `SLIM_VETO_HARD_BLOCK=1` 后才按 T1 fail-open / ALT fail-closed 细分 |
| `PARSE_FAIL` | 输出非 JSON / 非法 decision | veto |
| `MAIN_OVERRIDE_BLOCK` | 硬拦开启且 MAIN 策略为「只减仓不硬否」时 | 硬 `veto` 降级为 `size_down` 或记 `would_veto` 后按策略执行；**默认 shadow 下一律只记账** |

### 4.2 与执行层合成

**默认（`SLIM_VETO_HARD_BLOCK=0`）**：无论 `decision` 为何，**实盘下单路径不变**；必须落库 `veto_decision`、`would_veto`、`would_size_down`、`size_mult_would_apply`，供全体样本对照。

**仅当 `SLIM_VETO_HARD_BLOCK=1` 且已达 §6.4 验证门槛后**：

```
if decision == veto:        不下单；记 counterfactual（可选：MAIN 降级为 size_down，见 §8）
if decision == size_down:   order_usdt *= size_mult；仍须 TP/SL
if decision == pass:        默认仓；仍须 TP/SL
```

任何路径无 SL：`BITGET_REQUIRE_TPSL` 拒开或平掉（已有，与 Veto 开关无关）。

---

## 5. 周度强 Agent 校准

### 5.1 节奏

- 建议：**北京时间周日 03:30**（紧接现有 `confluence-calibrate` cron 03:00，见 `signal-logic.md` §10.0）。  
- 输入包只读；**写回必须人工确认**后再生效。

### 5.2 输入包（`WeeklyVetoPack`）

| 内容 | 来源 |
|------|------|
| 本周所有 `VetoRequest`+`VetoResponse` 日志 | `ezcoin-adapter/logs/veto-*.jsonl`（待建） |
| 对照标签：PIT +1h/+4h/+8h/+24h、`mfe_*`/`mae_*` | `ai_btc_backtest_jobs` / 扩展后的多标的 PIT |
| 形态列表 settle 摘要（**分开表**） | `pattern_alert_stats` — 仅作参考，不混进主 KPI |
| 当前 `gates.yaml` + `veto_codes.yaml` | 仓库 |
| 宏观窗事件表 | 人工/日历 |
| 误杀个案（可选标注） | 人工 tag `false_veto` |

### 5.3 输出（校准建议，非自动生效）

```json
{
  "week": "2026-W44",
  "proposals": [
    {
      "target": "veto_codes|gates.yaml|VETO_PEER_N",
      "change": "将 PEER_EDGE_NEG 的窗口从 4h 改为同时看 8h",
      "evidence": "veto 后真阳误杀率 18%→…",
      "action": "add_rule|delete_rule|tune_threshold|keep"
    }
  ],
  "keep_weight": "full|veto_only|off",
  "summary_zh": "…"
}
```

### 5.4 写回流程

1. 强 Agent 产出 `proposals` → 写入 `oi_mornitor/docs/veto-calibration/YYYY-Www.md`（或 logs）。  
2. 人工勾选 → PR 改 `gates.yaml` / `veto_codes.yaml` / env 默认。  
3. **禁止**周度 Agent 直接热更新生产门禁。  
4. 与 `confluence-calibrate` 一样：仅当 hold-out 指标改善才合并。

---

## 6. 如何验证「Agent 有没有用」

### 6.1 对照实验

| 臂 | 行为 |
|----|------|
| **A 基线** | 发现 → 硬门禁 →（可选 5 席）→ 下单意图；**不读** Veto decision |
| **B 干预** | 同上 + 应用 Veto（Phase 对应 shadow / size_down / veto） |

同一 `candidate_id` 双写：`baseline_would_trade`、`veto_decision`、`executed`。

### 6.2 单独记账字段（每笔）

| 字段 | 含义 |
|------|------|
| `veto_decision` / `veto_reason_code` / `veto_confidence` | 产出 |
| `baseline_side` / `executed_side` / `size_mult_applied` | 执行 |
| `pit_ret_1h/4h/8h/24h` | PIT 收益 |
| `mfe_4h_pct` / `mae_4h_pct` / `mfe_8h_pct` / `mae_8h_pct` | 与 `btc_1h_backtest` 同名 |
| `counterfactual_if_no_veto` | 若被 veto，仍结算「若开仓」路径（纸面） |
| `false_veto` | 人工/规则：否决后若基线本可达到 MFE 阈值且 MAE 可控 |

### 6.3 主 KPI（默认 PIT，**不用**形态列表 settle 当主指标）

对照臂（全体数据、同一 `candidate_id`）：

| 臂 | 定义 |
|----|------|
| **基线** | 忽略 Veto；按现网实际（或纸面等价）结算全样本 |
| **若执行 veto** | 凡 `decision=veto` 的候选视为不开；`size_down` 按 `size_mult` 缩放后结算 |

主表：

| 指标 | 允许把 `SLIM_VETO_HARD_BLOCK` 拨到 `1` | 保持 / 拨回 `0` |
|------|----------------------------------------|-----------------|
| 相对基线 **期望**（E[ret] 或 E[R]，PIT） | 干预臂 ≥ 基线，且 4h/8h 同向改善或持平 | 连续 2 周 &lt; −ε |
| **胜率**（PIT：如 MFE&gt;MAE 或同口径 win） | 干预臂不低于基线，或略降但期望/回撤明显更好 | 胜率与期望双差 |
| **回撤** / 最差 MAE 尾 | 不差于基线 | 明显恶化 |
| **误杀率** `false_veto_rate` | ≤ 25%（起步阈值） | &gt; 35% |
| 否决样本的反事实期望 | &lt; 0（否掉的是毒药） | 否决样本反事实仍显著为正 |
| **最低样本** | 见 §6.4 | n 不足只保持 shadow |

**形态列表 settle**：另表监控推送质量，**不**决定硬拦开关。

### 6.4 打开硬拦的最低门槛（拍板）

须**同时**满足，才允许将 `SLIM_VETO_HARD_BLOCK` 从 `0` → `1`：

1. **全体对照样本**：带完整 PIT 标签的 Veto 决策 ≥ **80** 笔（建议滚动 2–4 周）；其中 `decision∈{veto,size_down}` 的干预决策 ≥ **30** 笔。  
2. **纸面期望**：若执行 veto/size_down 后的期望 ≥ 基线全样本，且 4h 与 8h 至少一侧同向不差。  
3. **误杀率** ≤ 25%（抽检理由码胡扯 ≤ 10%）。  
4. **否决子集**反事实期望 &lt; 0（拦截方向正确）。  

未达标：**开关保持 `0`**，继续 Phase0/1 shadow 记账。达标后打开硬拦时，可再启用「MAIN 只 `size_down`、ALT 硬 `veto`」作为**可选**执行策略（非默认即拦）。

---

## 7. 分阶段落地

| 阶段 | 行为 | 成功标准 | 建议时长 |
|------|------|----------|----------|
| **Phase0 / Phase1 Shadow（默认）** | 始终算 `pass\|veto\|size_down` 并落库/日志（含 `would_veto`、`would_size_down`）；TG/UI 可标「若启用将…」；**`SLIM_VETO_HARD_BLOCK=0`，不改变实盘下单**；超时 fail-open | 字段齐全；解析失败率 &lt; 5%；P95 &lt; 3s；不影响下单；全体对照样本向 §6.4 累积 | 直至 §6.4 达标（通常 ≥2–4 周） |
| **Phase2 硬拦（开关打开后）** | `SLIM_VETO_HARD_BLOCK=1`：`size_down` 生效；高置信 `veto` 可拦（可选：先 ALT 硬 veto，MAIN 只 size_down） | 实盘期望/胜率/回撤不差于基线；误杀可控；无 SL 路径零放行 | §6.4 达标后常驻；恶化则拨回 `0` |

**环境变量（实现时，名称预留）**

| 变量 | 默认 | 含义 |
|------|------|------|
| `VETO_ENABLED` | `1`（接入后） | 是否跑 Slim Veto 计算与落库；`0` 则整层跳过 |
| `VETO_MODE` | `shadow` | `log`\|`shadow`\|`live`；默认 shadow（与硬拦开关解耦：`live` 仍须 `HARD_BLOCK=1` 才真拦） |
| **`SLIM_VETO_HARD_BLOCK`** | **`0`** | **硬拦总闸**：`0`=只记账不改实盘（拍板默认）；`1`=允许按 decision 改仓/拒单（须先过 §6.4） |
| `VETO_PEER_N` | `30` | 同类摘要窗口 |
| `VETO_SIZE_DOWN_MULT` | `0.5` | 减仓系数（硬拦开启后才作用于下单） |
| `VETO_FAIL_OPEN` | `1` | 超时是否放行；**默认与 shadow 一致 fail-open**；硬拦开启后可再对 ALT 设 fail-closed |
| `VETO_ALLOW_MAIN_HARD_VETO` | `0` | 硬拦开启后：MAIN 是否允许硬 `veto`；默认否（MAIN 建议只 `size_down`） |
| `VETO_LIVE_TIERS` | `ALT` | 硬拦开启后优先对哪些 tier 真拦 |

---

## 8. 已拍板（2026-10-28）

1. **默认 shadow + 硬拦开关**：`SLIM_VETO_HARD_BLOCK=0`（默认）。先不硬拦；始终算 `pass|veto|size_down` 并落库（含 `would_veto` / `would_size_down`），**不改变实盘下单**。  
2. **用全体数据验证**：对照「若执行 veto 后的纸面期望 / 胜率 / 回撤」vs 基线全样本；误杀率；达 §6.4 最低笔数与门槛后，才允许拨到 `1`。  
3. **硬拦开启后的可选分级**（不是现在就拦）：MAIN 可仍只 `size_down`（`VETO_ALLOW_MAIN_HARD_VETO=0`）；ALT 允许硬 `veto`（`VETO_LIVE_TIERS=ALT`）。  
4. **超时**：默认与 shadow 一致 **fail-open**（不影响下单）；仅硬拦开启后再按 T1 fail-open / ALT fail-closed 细分。

---

## 9. 相关文件索引（真实路径）

| 文档 / 代码 | 路径 |
|-------------|------|
| 本文 | `discord-collector/oi_mornitor/docs/oi-agent-veto-spec.md` |
| 信号与 settle / 共振 cron | `oi_mornitor/docs/signal-logic.md` |
| 回测 vs Live | `oi_mornitor/docs/backtest-vs-live.md` |
| 文档索引 | `oi_mornitor/docs/README.md` |
| OI 综合 | `oi_mornitor/OI_MONITOR.md` |
| 快照桥 | `oi_mornitor/ai_judge_bridge.py` |
| PIT MFE/MAE | `oi_mornitor/btc_1h_backtest.py` · `ai_btc_backtest_jobs.py` |
| 硬门禁 | `ezcoin-adapter/gates.yaml` · `gates.py` · `judge.py` |
| 实践步骤 | `ezcoin-adapter/PRACTICE-STEPS.md` · `ezcoin-adapter/README.md` |
| 全量壳 | `~/frontend/code/1.operations/TradingAgents` |
| 下单 / TP·SL | `discord-collector/src/bitget-order-from-signal.js` · `bitget-tpsl-guard.js` |
| 推送门控 | `pattern_emit_gate.py` · `pattern_push_gate.py` |

---

## 10. 刻意先不做

- 用更强模型每笔重新「发现」多空并覆盖因子  
- 实时跑满 TradingAgents 多轮辩论  
- 周度 Agent 无人确认热更新 `gates.yaml`  
- 把形态列表 3h settle 当作 Veto 主 KPI  
- 本规格阶段改 Bitget 实盘代码（先文档 + 日志设计）
- 在未达 §6.4 前把 `SLIM_VETO_HARD_BLOCK` 设为 `1`
