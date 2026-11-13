# OI Monitor 币种筛选与共振门槛修复

**日期**: 2026-11-10  
**分支**: `cursor/fix-oi-push-symbol-filter-d293`  
**问题编号**: VVV非选定币种推送 + ETHUSD C档共振信号绕过B档门槛

## 修复摘要

本次修复解决了OI Monitor热门币种信息推送系统中的两个关键问题：

1. **币种筛选失效**：VVV等非用户选定币种仍能推送到MAIN群和形态群
2. **共振档位门槛绕过**：C档信号可能通过某些路径进入MAIN群，尽管配置了`OI_CONFLUENCE_PUSH_MIN_TIER=B`

## 修改文件列表

### 1. `oi_mornitor/candle_card_policy.py`

**问题**: 当`OI_MAIN_CARD_LONG_SYMBOLS`和`OI_MAIN_CARD_OTHER_SYMBOLS`都未配置时，`is_candle_card_push_symbol`返回`True`，放行所有币种。

**修复**: 改为回退到`MAIN_CARD_DEFAULT_SYMBOLS`作为默认白名单，而不是放行全市场。

```python
def is_candle_card_push_symbol(symbol: str) -> bool:
    """形态群 TG：优先用 LONG/OTHER 名单；未配置时回退到 MAIN_CARD_DEFAULT_SYMBOLS。"""
    n = normalize_focus_symbol(symbol)
    if not n:
        return False
    
    # 优先使用形态群专属名单
    if candle_card_watch_configured():
        return n in candle_card_watch_symbols()
    
    # 回退：未配置时使用 MAIN 群白名单（不放行全市场）
    from oi_mornitor.main_card_policy import is_main_card_symbol
    return is_main_card_symbol(n)
```

**影响**: 
- ✅ VVV未在`DEFAULT_SYMBOLS`中时将被拦截
- ✅ 形态群未配置专属名单时，自动复用MAIN群白名单
- ✅ 不改变已配置`LONG/OTHER`的用户行为

### 2. `oi_mornitor/notify_telegram.py`

#### 2.1 `send_main_card_telegram` 增加显式白名单检查

**问题**: MAIN群推送前虽然调用`is_main_card_mirror_eligible`检查，但镜像资格检查可能在某些边缘场景下不够严格。

**修复**: 在函数入口显式检查币种是否在`DEFAULT_SYMBOLS`中，早期返回。

```python
def send_main_card_telegram(alert: dict[str, Any]) -> bool:
    # 显式白名单检查（修复：防止非 DEFAULT_SYMBOLS 币种通过镜像路径进入 MAIN）
    sym = str(alert.get("symbol") or "")
    if not is_main_card_symbol(sym):
        return False
    # ... 后续逻辑
```

#### 2.2 `_mirror_to_main_card` 增加显式白名单检查

**修复**: 形态群镜像到MAIN前也进行显式币种检查。

```python
def _mirror_to_main_card(alert: dict[str, Any], text: str) -> bool:
    # 显式白名单检查（修复：镜像前确认币种在 DEFAULT_SYMBOLS 中）
    sym = str(alert.get("symbol") or "")
    if not is_main_card_symbol(sym):
        return False
    # ... 后续逻辑
```

#### 2.3 `send_ma144_main_card_telegram` 改进币种检查

**修复**: 将币种提取与检查分离，确保归一化后再检查。

```python
def send_ma144_main_card_telegram(alert: dict[str, Any]) -> bool:
    # 归一化币种别名后检查白名单
    sym = str(alert.get("symbol") or "")
    if not is_main_card_symbol(sym):
        return False
    # ... 后续逻辑
```

### 3. `oi_mornitor/pattern_emit_gate.py`

**问题**: 共振门控虽然已实现，但缺少详细日志，难以追踪C档信号是否被正确拦截。

**修复**: 在共振门控处增加详细日志，记录每次门控的结果。

```python
def telegram_push_allowed_or_record_observation(alert, peers=None) -> bool:
    # ... 基础门控
    attach_confluence_on_alert(alert, peers)
    
    # 增强日志：记录共振门控结果
    conf = alert.get("confluence", {})
    tier = conf.get("tier", "?")
    score = conf.get("score", "?")
    sym = alert.get("symbol", "?")
    iv = alert.get("interval", "?")
    
    if passes_confluence_tier_push_gate(alert):
        logger.info("✅ 共振门控通过: %s %s 档位=%s 分=%s", sym, iv, tier, score)
        return True
    
    logger.info("⏸️ 共振门控观察: %s %s 档位=%s 分=%s (未达推送门槛 %s)", 
                sym, iv, tier, score, confluence_push_min_tier())
    record_confluence_observation_only(alert)
    return False
```

**日志示例**:
```
✅ 共振门控通过: ETHUSDT 1h 档位=B 分=68
⏸️ 共振门控观察: ETHUSD 1h 档位=C 分=52 (未达推送门槛 B)
```

### 4. `oi_mornitor/main_card_policy.py`

**修复**: 在`is_main_card_symbol`文档字符串中明确说明自动处理USD/USDT别名。

```python
def is_main_card_symbol(symbol: str) -> bool:
    """MAIN 群仅推送 env `OI_MAIN_CARD_DEFAULT_SYMBOLS` 中的币种。
    
    自动处理 USD/USDT 别名，例如 ETHUSD → ETHUSDT。
    """
    n = normalize_focus_symbol(symbol)
    return bool(n) and n in _main_card_symbols()
```

## 回归测试要点

### 测试1: VVV筛除
- **前提**: `OI_MAIN_CARD_DEFAULT_SYMBOLS=BTCUSDT,ETHUSDT,QQQUSDT,SUIUSDT`
- **前提**: `OI_MAIN_CARD_LONG_SYMBOLS`和`OI_MAIN_CARD_OTHER_SYMBOLS`都为空或不含VVV
- **预期**: VVV的蜡烛/结构信号不会推送到形态群和MAIN群
- **验证**: 检查OI日志中无VVV相关的`📩 形态卡片`或`✅ 共振门控通过`记录

### 测试2: ETH通过币种筛选
- **前提**: `OI_MAIN_CARD_DEFAULT_SYMBOLS`包含`ETHUSDT`
- **输入**: ETHUSD或ETHUSDT的B档信号
- **预期**: 信号能推送到MAIN群
- **验证**: 日志中出现`✅ 共振门控通过: ETHUSDT 1h 档位=B 分=XX`

### 测试3: C档被B档门槛拦截
- **前提**: `OI_CONFLUENCE_PUSH_MIN_TIER=B`
- **输入**: ETHUSDT的C档信号（共振分<60）
- **预期**: 信号不推送，但写入观察记录
- **验证**: 日志中出现`⏸️ 共振门控观察: ETHUSDT 1h 档位=C 分=52 (未达推送门槛 B)`

### 测试4: USD/USDT别名归一化
- **前提**: `OI_MAIN_CARD_DEFAULT_SYMBOLS=BTCUSDT,ETHUSDT`
- **输入**: BTCUSD和BTCUSDT信号
- **预期**: 两者都被识别为BTCUSDT，都能通过白名单检查
- **验证**: 两种写法的信号都能正常推送

### 测试5: 形态群配置OTHER时的独立筛选
- **前提**: `OI_MAIN_CARD_OTHER_SYMBOLS=VVVUSDT`
- **输入**: VVV的蜡烛信号
- **预期**: 推送到形态群，但不镜像到MAIN（VVV不在DEFAULT中）
- **验证**: 形态群收到消息，MAIN群未收到

## 不改变的行为

1. **信号算法**: 不修改蜡烛形态、结构识别、共振计算逻辑
2. **杠杆/额度**: 不改变交易参数、TP/SL计算
3. **下单边界**: `channel_profiles`中的`placeAnOrder`和`send`配置不变
4. **服务稳定性**: 不重启Chrome/Hermes/collect:ui
5. **已有合理配置**: 保留所有显式配置的行为（如配置了OTHER则使用OTHER）

## 部署建议

### 环境变量配置检查

启动OI Monitor前，建议检查以下环境变量：

```bash
# MAIN群白名单（必须配置）
OI_MAIN_CARD_DEFAULT_SYMBOLS=BTCUSDT,ETHUSDT,QQQUSDT,SUIUSDT

# 形态群专属白名单（可选；为空时自动使用 DEFAULT_SYMBOLS）
OI_MAIN_CARD_LONG_SYMBOLS=
OI_MAIN_CARD_OTHER_SYMBOLS=

# 共振门槛（推荐B档）
OI_CONFLUENCE_PUSH_MIN_TIER=B

# MAIN群ID（必须配置）
MAIN_CARD_TELEGRAM_CHAT_ID=-1003860925903
```

### 日志监控要点

修复后新增的关键日志：

```
# 币种筛选日志（在 pattern_monitor.py）
📩 形态卡片 ETHUSDT 射击之星 1h @1699632000

# 共振门控日志（新增）
✅ 共振门控通过: ETHUSDT 1h 档位=B 分=68
⏸️ 共振门控观察: VVVUSDT 15m 档位=C 分=48 (未达推送门槛 B)
```

如果发现C档信号仍进入MAIN，请检查日志中是否有：
1. 对应信号的`⏸️ 共振门控观察`记录（说明门控生效）
2. 对应信号的`📩 形态卡片`但无共振门控日志（说明有路径绕过）

### 回滚方案

如发现异常，可回滚到修复前版本：

```bash
git checkout main
pnpm run oi:start
```

## 相关文档

- 详细调查报告: `INVESTIGATION_REPORT.md`
- OI文档: `discord-collector/oi_mornitor/docs/`
- 推送路由说明: `discord-collector/oi_mornitor/docs/tg-main-routing-brief.md`

## 作者

Cursor Agent - 2026-11-10
