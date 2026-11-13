# OI Monitor 热门币种推送筛选问题调查报告

**日期**: 2026-11-10  
**问题**: VVV等非选定币种仍推送MAIN群，C档共振信号未被B档门槛拦截

## 问题症状

1. **币种筛选失效**: VVV等不在用户选定币种(`BTCUSDT,ETHUSDT,QQQUSDT,SUIUSDT`)内的币种仍推送到MAIN群
2. **共振档位绕过**: ETHUSD共振23(C档)信号在2026-11-10 23:03进入MAIN群，但`OI_CONFLUENCE_PUSH_MIN_TIER=B`应该拦住C档
3. **别名问题**: ETHUSD可能未被正确归一化为ETHUSDT

## 根因分析

### 1. 币种筛选架构

代码中存在三层币种配置：

- `OI_MAIN_CARD_DEFAULT_SYMBOLS`: MAIN群白名单（默认`BTCUSDT,ETHUSDT,QQQUSDT,SOLUSDT,...`）
- `OI_MAIN_CARD_LONG_SYMBOLS`: 形态群长线币种白名单
- `OI_MAIN_CARD_OTHER_SYMBOLS`: 形态群其他币种白名单

#### 问题点1: 形态群筛选逻辑缺陷 (`candle_card_policy.py:60-66`)

```python
def is_candle_card_push_symbol(symbol: str) -> bool:
    """形态群 TG：配置了 LONG/OTHER 时仅推送并集内币种；未配置则保持原行为（不按名单挡）。"""
    if not candle_card_watch_configured():
        return True  # ⚠️ 未配置名单时放行所有币种
    n = normalize_focus_symbol(symbol)
    return bool(n) and n in candle_card_watch_symbols()
```

**缺陷**: 当`LONG_SYMBOLS`和`OTHER_SYMBOLS`都为空时，返回True，允许所有币种推送。这违反了用户"只推送已选币种"的预期。

#### 问题点2: MAIN群镜像未二次验证币种

在`pattern_monitor.py:1822-1827`中：

```python
if not ok and is_main_card_mirror_eligible(alert):
    try:
        ok = await send_main_card_telegram_async(alert)
```

`is_main_card_mirror_eligible`检查：
- 币种在`OI_MAIN_CARD_DEFAULT_SYMBOLS`中 ✓
- 周期/类型符合 ✓
- 但形态群推送失败后，MAIN群作为兜底，可能推送了用户不想要的币种

### 2. 共振档位门槛问题

#### 正常流程

`notify_telegram.py:439-443` 的`send_main_card_telegram`：

```python
def send_main_card_telegram(alert: dict[str, Any]) -> bool:
    if not MAIN_CARD_TELEGRAM_CHAT_ID or not is_main_push_enabled():
        return False
    if not is_main_card_mirror_eligible(alert):
        return False
    if not _confluence_gate_or_observation(alert):  # ← 共振门控
        return False
```

`pattern_emit_gate.py:74-88` 的共振门控：

```python
def telegram_push_allowed_or_record_observation(alert, peers=None) -> bool:
    if not passes_pattern_card_emit_gate(alert, peers):
        return False
    attach_confluence_on_alert(alert, peers)
    if passes_confluence_tier_push_gate(alert):  # ← 检查B档
        return True
    record_confluence_observation_only(alert)  # ← C档写入观察，不推送
    return False
```

#### 可能的绕过路径

1. **多个推送函数**：代码中有多个推送入口
   - `send_candle_card_telegram` - 形态群
   - `send_main_card_telegram` - MAIN群镜像
   - `send_ma144_main_card_telegram` - 144均线专用MAIN推送
   - `send_rev_vol_card_telegram` - 末端放量

2. **144均线路径**：`send_ma144_main_card_telegram` (line 426-443) 有独立白名单检查，但共振门控在同一位置

3. **结构卡片路径**：`send_structure_card_telegram` 不推MAIN，只推形态群

#### 需要验证的场景

ETHUSD C档信号可能通过以下路径进入MAIN：
- 路径A: ETH在DEFAULT中 → `is_main_card_mirror_eligible`=True → 调用`send_main_card_telegram` → 应该被共振门控拦住
- 路径B: 如果共振计算时机不对，可能在推送前未附加confluence字段

### 3. 币种别名归一化问题

`focus_symbols.py:24-33` 的归一化逻辑：

```python
def _normalize(sym: str) -> str:
    s = str(sym or "").strip().upper()
    if not s:
        return ""
    if s.endswith("USD") and not s.endswith("USDT") and not s.endswith("USDC"):
        s = f"{s}T"  # ETHUSD → ETHUSDT ✓
    if not s.endswith(("USDT", "USDC", "BUSD")) and s.isalpha():
        s = f"{s}USDT"
    return s
```

归一化逻辑正常，但**需要确保所有筛选点都调用了归一化**。

## 确认的Bug

1. ✅ **形态群未配置名单时放行所有币种** - `candle_card_policy.py:60-66`
2. ✅ **MAIN群白名单默认包含大量美股代币** - `.env.example:255,259`
   ```
   # OI_MAIN_CARD_DEFAULT_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,QQQUSDT,SUIUSDT
   # OI_MAIN_CARD_OTHER_SYMBOLS=XLMUSDT,VVVUSDT  ← VVV在此！
   ```
3. ⚠️ **C档绕过B档门槛** - 待runtime日志确认具体路径

## 推荐修复方案

### 修复1: 修改形态群筛选默认行为

**文件**: `discord-collector/oi_mornitor/candle_card_policy.py`

将未配置名单时的行为改为：**使用MAIN群白名单作为默认**，而不是放行所有币种。

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

### 修复2: 统一币种别名归一化

**文件**: `discord-collector/oi_mornitor/main_card_policy.py`

确保所有比较前都归一化：

```python
def is_main_card_symbol(symbol: str) -> bool:
    """MAIN 群仅推送 env `OI_MAIN_CARD_DEFAULT_SYMBOLS` 中的币种。
    
    自动处理 USD/USDT 别名，例如 ETHUSD → ETHUSDT。
    """
    n = normalize_focus_symbol(symbol)
    return bool(n) and n in _main_card_symbols()
```

### 修复3: 增强共振门控日志

**文件**: `discord-collector/oi_mornitor/pattern_emit_gate.py`

添加更详细的日志，便于追踪C档信号是否被正确拦截：

```python
def telegram_push_allowed_or_record_observation(
    alert: dict[str, Any],
    peers: list[dict[str, Any]] | None = None,
) -> bool:
    sym = alert.get("symbol", "?")
    iv = alert.get("interval", "?")
    
    if not passes_pattern_card_emit_gate(alert, peers):
        return False
    
    attach_confluence_on_alert(alert, peers)
    conf = alert.get("confluence", {})
    tier = conf.get("tier", "?")
    score = conf.get("score", "?")
    
    if passes_confluence_tier_push_gate(alert):
        logger.info("✅ 共振门控通过: %s %s 档位=%s 分=%s", sym, iv, tier, score)
        return True
    
    logger.info("⏸️ 共振门控观察: %s %s 档位=%s 分=%s (未达推送门槛)", sym, iv, tier, score)
    record_confluence_observation_only(alert)
    return False
```

### 修复4: MAIN群推送前强制检查白名单

**文件**: `discord-collector/oi_mornitor/notify_telegram.py`

在`send_main_card_telegram`顶部增加显式白名单检查：

```python
def send_main_card_telegram(alert: dict[str, Any]) -> bool:
    """仅推 MAIN 群（形态群未发或只满足 MAIN 量能口径时）。"""
    from oi_mornitor.main_card_policy import is_main_card_symbol
    
    # 显式白名单检查（早期返回）
    sym = str(alert.get("symbol") or "")
    if not is_main_card_symbol(sym):
        return False
    
    if not MAIN_CARD_TELEGRAM_CHAT_ID or not is_main_push_enabled():
        return False
    if not is_main_card_mirror_eligible(alert):
        return False
    if not _confluence_gate_or_observation(alert):
        return False
    # ... 后续逻辑
```

## 回归测试计划

1. **VVV筛除测试**
   - 从`OI_MAIN_CARD_OTHER_SYMBOLS`中移除VVV
   - 或不配置`LONG/OTHER`让其回退到`DEFAULT_SYMBOLS`
   - 验证VVV不再推送到任何群

2. **ETH通过测试**
   - 配置`OI_MAIN_CARD_DEFAULT_SYMBOLS=BTCUSDT,ETHUSDT`
   - 验证ETHUSD和ETHUSDT都能正确匹配
   - 验证ETH信号能推送（档位≥B时）

3. **C档拦截测试**
   - 等待或模拟一个C档信号
   - 检查日志中是否有"⏸️ 共振门控观察"
   - 验证MAIN群未收到推送

4. **USD/USDT别名测试**
   - 模拟BTCUSD和BTCUSDT信号
   - 验证两者都被识别为同一币种
   - 验证白名单中只需配置一种即可

## 后续优化建议

1. **配置验证工具**: 启动时打印币种白名单实际生效值
2. **推送路径追踪**: 每次推送记录完整路径（candle→main / ma144→main等）
3. **测试覆盖**: 为币种筛选和共振门控添加单元测试
4. **文档更新**: 在`tg-main-routing-brief.md`中明确说明筛选优先级

---

**调查人**: Cursor Agent  
**审核**: 待用户确认
