# OI 信号回测结果

区间 2026-07-01 ~ 2026-10-01（实际用到 7–9 月完整月度 zip；10 月 vision 包尚未发布，404 已忽略）。
品种 BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, AVAXUSDT, LINKUSDT；周期 15m, 1h, 4h，另拉 1d 做共振过滤。
数据源：`data.binance.vision` USDT-M 永续月度 K 线（`vision_um`），无需密钥。

**口径**：等额保证金；BTC/ETH/SOL 100x，其余 20x；单边 taker 0.05% + 滑点 0.02%；出场按周期（15m 持 16 根 / 1h 12 根 / 4h 6 根，SL=1.2/1.5/2.0 ATR）。`avg_pnl_pct` 是保证金收益率（含杠杆与双边手续费），不是价格涨跌幅。`max_dd` 是把每笔保证金盈亏累加后的回撤，样本多时数值会很大，只作相对比较。

**读数提醒**：当前把几乎所有检测事件都开仓，未按 A/B/C 过滤，所以总体接近随机（胜率 36.6% vs 36.1%），费用在高杠杆下很重。V/OI 加分组与未加分组胜率接近（36.75% vs 36.58%），本窗口不能证明加分有效。分数分桶也尚未单调：65+ 样本少且更差，权重需要再标定。相对较好的口袋（小样本，仅供后续筛选）：4h 二次探底、4h `vp_match_long`、4h `vp_pullback_long`、4h MACD 顶背离、1h 布林+EMA 射击之星。

## 总体 vs 随机入场

| set | n | win_rate | avg_r | avg_pnl_pct | max_dd |
| --- | --- | --- | --- | --- | --- |
| signals | 34808 | 36.62 | -0.10 | -7.97 | -278093.62 |
| random | 34808 | 36.05 | -0.11 | -7.23 | -251771.23 |
| v_oi | 7026 | 36.75 | -0.11 | -8.57 | -60397.08 |
| plain | 27782 | 36.58 | -0.09 | -7.81 | -217974.05 |

## 按分数分桶

| bucket | n | win_rate | avg_r | avg_pnl_pct | max_dd |
| --- | --- | --- | --- | --- | --- |
| 0-40 | 32879 | 36.66 | -0.10 | -7.96 | -262601.63 |
| 40-50 | 1432 | 36.38 | -0.11 | -6.93 | -10137.09 |
| 50-65 | 406 | 36.45 | -0.13 | -12.24 | -5179.97 |
| 65+ | 91 | 26.37 | -0.28 | -9.18 | -1134.13 |

## 按 kind / 周期 / 分组

| kind | tf | group | n | win_rate | avg_r | avg_pnl_pct | max_dd |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bb_ema144_hammer | 15m | plain | 203 | 30.05 | -0.20 | -11.54 | -2551.30 |
| bb_ema144_hammer | 1h | plain | 32 | 40.62 | -0.12 | -2.36 | -313.68 |
| bb_ema144_hammer | 4h | plain | 4 | 0.00 | -0.60 | -75.16 | -300.64 |
| bb_ema_shooting_star | 15m | plain | 55 | 34.55 | -0.14 | -8.47 | -508.70 |
| bb_ema_shooting_star | 1h | plain | 16 | 56.25 | 0.32 | 12.89 | -191.46 |
| bottom_secondary_test | 15m | plain | 2847 | 40.43 | -0.02 | -6.39 | -18246.01 |
| bottom_secondary_test | 1h | plain | 632 | 41.93 | -0.06 | -7.40 | -4795.18 |
| bottom_secondary_test | 4h | plain | 98 | 60.20 | 0.25 | 50.20 | -743.95 |
| continuous_lower_wick | 15m | plain | 625 | 26.72 | -0.33 | -10.72 | -6760.13 |
| continuous_lower_wick | 15m | v_oi | 385 | 36.36 | -0.08 | -6.99 | -2794.19 |
| continuous_lower_wick | 1h | plain | 142 | 35.92 | -0.23 | -16.80 | -2618.28 |
| continuous_lower_wick | 1h | v_oi | 114 | 36.84 | -0.12 | -12.61 | -1798.75 |
| continuous_lower_wick | 4h | plain | 33 | 39.39 | -0.09 | -27.40 | -1163.62 |
| continuous_lower_wick | 4h | v_oi | 14 | 78.57 | 0.19 | 18.18 | -65.14 |
| continuous_upper_wick | 15m | plain | 726 | 32.92 | -0.13 | -7.75 | -5630.55 |
| continuous_upper_wick | 15m | v_oi | 355 | 32.39 | -0.18 | -7.83 | -2811.53 |
| continuous_upper_wick | 1h | plain | 181 | 36.46 | -0.22 | -25.60 | -4767.48 |
| continuous_upper_wick | 1h | v_oi | 96 | 44.79 | -0.05 | -14.44 | -1454.62 |
| continuous_upper_wick | 4h | plain | 44 | 56.82 | -0.06 | -22.64 | -1482.24 |
| continuous_upper_wick | 4h | v_oi | 9 | 55.56 | -0.06 | -16.50 | -246.98 |
| hammer | 15m | plain | 2593 | 40.46 | 0.01 | -4.65 | -12187.99 |
| hammer | 15m | v_oi | 1669 | 36.37 | -0.10 | -7.98 | -13530.20 |
| hammer | 1h | plain | 616 | 40.26 | -0.06 | -12.08 | -8249.35 |
| hammer | 1h | v_oi | 392 | 37.24 | -0.10 | -10.54 | -4220.58 |
| hammer | 4h | plain | 118 | 50.00 | 0.01 | -0.08 | -1436.92 |
| hammer | 4h | v_oi | 54 | 44.44 | -0.05 | -12.58 | -804.99 |
| hs_vegas_break | 15m | plain | 336 | 36.01 | -0.06 | -8.97 | -3087.27 |
| hs_vegas_break | 1h | plain | 78 | 43.59 | 0.05 | -0.59 | -693.00 |
| hs_vegas_break | 4h | plain | 3 | 66.67 | -0.03 | -5.56 | -16.69 |
| inv_hammer | 15m | plain | 821 | 39.95 | 0.03 | -3.50 | -3120.58 |
| inv_hammer | 15m | v_oi | 483 | 36.23 | -0.11 | -6.85 | -3496.81 |
| inv_hammer | 1h | plain | 174 | 41.95 | -0.02 | -9.43 | -1933.85 |
| inv_hammer | 1h | v_oi | 126 | 46.03 | -0.04 | -4.95 | -1205.55 |
| inv_hammer | 4h | plain | 40 | 40.00 | -0.05 | -3.71 | -667.74 |
| inv_hammer | 4h | v_oi | 19 | 42.11 | 0.05 | -0.62 | -295.15 |
| liquidity_sweep | 15m | plain | 93 | 34.41 | -0.07 | -7.91 | -918.37 |
| liquidity_sweep | 1h | plain | 84 | 41.67 | -0.01 | -12.39 | -1592.11 |
| liquidity_sweep | 4h | plain | 20 | 40.00 | -0.09 | -28.24 | -1124.73 |
| m_top_vegas_break | 15m | plain | 30 | 50.00 | 0.34 | -0.65 | -299.42 |
| m_top_vegas_break | 1h | plain | 22 | 36.36 | -0.16 | -20.76 | -456.66 |
| m_top_vegas_break | 4h | plain | 5 | 40.00 | 0.14 | -18.05 | -195.27 |
| macd_bear_div | 15m | plain | 360 | 34.44 | -0.13 | -7.93 | -2977.92 |
| macd_bear_div | 1h | plain | 94 | 43.62 | 0.07 | 3.46 | -452.09 |
| macd_bear_div | 4h | plain | 23 | 69.57 | 0.24 | 12.83 | -542.94 |
| macd_bull_div | 15m | plain | 330 | 39.39 | 0.01 | -4.77 | -1733.35 |
| macd_bull_div | 1h | plain | 90 | 52.22 | 0.16 | -1.00 | -612.74 |
| macd_bull_div | 4h | plain | 14 | 21.43 | -0.38 | -21.33 | -298.67 |
| shooting_star | 15m | plain | 4512 | 31.54 | -0.21 | -10.05 | -45481.78 |
| shooting_star | 15m | v_oi | 2631 | 35.77 | -0.13 | -7.17 | -18932.66 |
| shooting_star | 1h | plain | 1090 | 37.89 | -0.11 | -12.81 | -14379.50 |
| shooting_star | 1h | v_oi | 607 | 39.04 | -0.13 | -15.41 | -9366.96 |
| shooting_star | 4h | plain | 232 | 48.28 | -0.04 | -20.41 | -5762.20 |
| shooting_star | 4h | v_oi | 72 | 41.67 | -0.09 | -24.04 | -1846.74 |
| vp_div_bottom | 15m | plain | 1257 | 38.58 | -0.04 | -6.99 | -9104.40 |
| vp_div_bottom | 1h | plain | 210 | 41.90 | -0.02 | -7.99 | -1720.62 |
| vp_div_bottom | 4h | plain | 21 | 57.14 | 0.06 | 21.77 | -332.75 |
| vp_div_top | 15m | plain | 1301 | 33.90 | -0.11 | -6.37 | -8437.06 |
| vp_div_top | 1h | plain | 242 | 42.98 | -0.10 | -8.64 | -2100.68 |
| vp_div_top | 4h | plain | 41 | 41.46 | -0.10 | -35.47 | -1959.69 |
| vp_exhaust_bottom | 15m | plain | 364 | 38.46 | -0.05 | -4.88 | -1775.15 |
| vp_exhaust_bottom | 1h | plain | 75 | 33.33 | -0.20 | -16.32 | -1287.39 |
| vp_exhaust_bottom | 4h | plain | 6 | 33.33 | -0.49 | -64.03 | -384.18 |
| vp_exhaust_top | 15m | plain | 352 | 37.22 | -0.09 | -7.09 | -2498.21 |
| vp_exhaust_top | 1h | plain | 91 | 38.46 | -0.16 | -7.96 | -775.10 |
| vp_exhaust_top | 4h | plain | 9 | 66.67 | 0.16 | 5.70 | -472.61 |
| vp_match_long | 15m | plain | 2288 | 33.61 | -0.09 | -7.58 | -17341.92 |
| vp_match_long | 1h | plain | 615 | 43.25 | 0.14 | 0.86 | -2924.05 |
| vp_match_long | 4h | plain | 133 | 52.63 | 0.37 | 47.00 | -1588.66 |
| vp_match_short | 15m | plain | 2074 | 30.18 | -0.22 | -10.68 | -22249.93 |
| vp_match_short | 1h | plain | 447 | 36.69 | -0.12 | -13.45 | -6010.61 |
| vp_match_short | 4h | plain | 74 | 25.68 | -0.27 | -54.54 | -4036.22 |
| vp_pullback_long | 15m | plain | 285 | 41.05 | 0.04 | -4.07 | -1483.32 |
| vp_pullback_long | 1h | plain | 90 | 42.22 | -0.08 | -7.97 | -825.95 |
| vp_pullback_long | 4h | plain | 23 | 73.91 | 0.44 | 43.09 | -338.50 |
| vp_pullback_short | 15m | plain | 282 | 32.27 | -0.27 | -9.37 | -2736.88 |
| vp_pullback_short | 1h | plain | 72 | 29.17 | -0.20 | -9.97 | -751.74 |
| vp_pullback_short | 4h | plain | 14 | 21.43 | -0.47 | -79.39 | -1111.47 |

## 数据来源

```json
{
  "BTCUSDT:15m": "vision_um",
  "BTCUSDT:1h": "vision_um",
  "BTCUSDT:4h": "vision_um",
  "BTCUSDT:1d": "vision_um",
  "ETHUSDT:15m": "vision_um",
  "ETHUSDT:1h": "vision_um",
  "ETHUSDT:4h": "vision_um",
  "ETHUSDT:1d": "vision_um",
  "SOLUSDT:15m": "vision_um",
  "SOLUSDT:1h": "vision_um",
  "SOLUSDT:4h": "vision_um",
  "SOLUSDT:1d": "vision_um",
  "XRPUSDT:15m": "vision_um",
  "XRPUSDT:1h": "vision_um",
  "XRPUSDT:4h": "vision_um",
  "XRPUSDT:1d": "vision_um",
  "DOGEUSDT:15m": "vision_um",
  "DOGEUSDT:1h": "vision_um",
  "DOGEUSDT:4h": "vision_um",
  "DOGEUSDT:1d": "vision_um",
  "ADAUSDT:15m": "vision_um",
  "ADAUSDT:1h": "vision_um",
  "ADAUSDT:4h": "vision_um",
  "ADAUSDT:1d": "vision_um",
  "AVAXUSDT:15m": "vision_um",
  "AVAXUSDT:1h": "vision_um",
  "AVAXUSDT:4h": "vision_um",
  "AVAXUSDT:1d": "vision_um",
  "LINKUSDT:15m": "vision_um",
  "LINKUSDT:1h": "vision_um",
  "LINKUSDT:4h": "vision_um",
  "LINKUSDT:1d": "vision_um"
}
```
