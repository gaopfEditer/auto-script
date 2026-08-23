"""从群消息文本中规则提取交易信号（币种 / 多空 / 入场 / 止盈止损）。"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace

# 常见中文币名 → 展示符号
_CN_COIN: dict[str, str] = {
    "比特币": "BTC",
    "大饼": "BTC",
    "以太": "ETH",
    "以太坊": "ETH",
    "狗狗": "DOGE",
    "狗狗币": "DOGE",
    "索拉纳": "SOL",
    "瑞波": "XRP",
}

_DIR_LONG = re.compile(
    r"(?:做多|开多|多单|看多|逢低多|做多单|\blong\b)",
    re.I,
)
_DIR_SHORT = re.compile(
    r"(?:做空|开空|空单|看空|逢高空|做空单|\bshort\b)",
    re.I,
)
_MARKET_DIR_LONG = re.compile(r"市[价價]\s*多|市[价價]多", re.I)
_MARKET_DIR_SHORT = re.compile(r"市[价價]\s*空|市[价價]空", re.I)
_SYM_HASH = re.compile(r"#([A-Za-z]{2,12})(?![A-Za-z0-9])")
_MARKET_PRICE = re.compile(
    r"市[价價]\s*[多空]\s+([0-9]+(?:\.[0-9]+)?)",
    re.I,
)

_SYM_TICKER = re.compile(
    r"(?<![A-Za-z0-9])\$?([A-Za-z]{2,12})(?:/USDT|/USD|USDT|USD)?(?![A-Za-z0-9])",
)
_SYM_CN = re.compile("|".join(sorted(map(re.escape, _CN_COIN.keys()), key=len, reverse=True)))

_ENTRY = re.compile(
    r"(?:入场|建仓|开仓|挂单|上车|进场)\s*[:：]?\s*([^\n，,；;]{1,40})",
    re.I,
)
_TP = re.compile(
    r"(?:止盈|目标|TP|take\s*profit)\s*[:：]?\s*([^\n]{1,60})",
    re.I,
)
_SL = re.compile(
    r"(?:止损|止損|SL|stop\s*loss)\s*[:：]?\s*([^\n]{1,40})",
    re.I,
)
_POS = re.compile(
    r"(?:仓位|倉位|杠杆|槓桿|倍数)\s*[:：]?\s*([^\n]{1,40})",
    re.I,
)
_NOTE = re.compile(
    r"(?:备注|備註|注意|提示)\s*[:：]?\s*([^\n]{1,80})",
)
_FARE = re.compile(r"(?:发车|發車|上车信号|开单)", re.I)

# 排除误伤的常见英文词
_SYM_BLOCK = frozenset(
    {
        "USDT",
        "USD",
        "LONG",
        "SHORT",
        "TP",
        "SL",
        "OK",
        "VIP",
        "CEO",
        "AI",
        "API",
        "HTTP",
        "HTTPS",
        "THE",
        "AND",
        "FOR",
        "YOU",
        "ALL",
        "NEW",
        "NOW",
        "BUY",
        "SELL",
        "OPEN",
        "CLOSE",
        "HIGH",
        "LOW",
        "ENTRY",
        "EXIT",
        "FROM",
        "THIS",
        "THAT",
        "WITH",
        "HAVE",
        "WILL",
        "JUST",
        "ONLY",
        "ALSO",
        "INTO",
        "OVER",
        "NEAR",
        "AREA",
        "ZONE",
        "SPOT",
        "SWAP",
        "PERP",
    }
)


@dataclass
class TradeSignal:
    symbol: str = ""
    direction: str = ""  # 多 | 空
    entry: str = ""
    take_profit: str = ""
    stop_loss: str = ""
    position: str = ""
    note: str = ""
    sender: str = ""
    is_departure: bool = False  # 发车/先信号
    source_text: str = ""
    msg_ids: list[int] = field(default_factory=list)

    @property
    def has_core(self) -> bool:
        return bool(self.symbol and self.direction)

    @property
    def has_tpsl(self) -> bool:
        return bool(self.take_profit or self.stop_loss)

    def merge_from(self, other: "TradeSignal") -> "TradeSignal":
        """用 other 补全空字段（保留已有）。"""
        return replace(
            self,
            symbol=self.symbol or other.symbol,
            direction=self.direction or other.direction,
            entry=self.entry or other.entry,
            take_profit=self.take_profit or other.take_profit,
            stop_loss=self.stop_loss or other.stop_loss,
            position=self.position or other.position,
            note=self.note or other.note,
            sender=self.sender or other.sender,
            is_departure=self.is_departure or other.is_departure,
            source_text=self.source_text or other.source_text,
            msg_ids=list(dict.fromkeys([*self.msg_ids, *other.msg_ids])),
        )


def _norm_sym(raw: str) -> str:
    s = (raw or "").strip().upper()
    if s.endswith("USDT"):
        s = s[:-4]
    if s.endswith("USD") and len(s) > 3:
        s = s[:-3]
    return s


def _pick_symbol(text: str) -> str:
    hm = _SYM_HASH.search(text)
    if hm:
        cand = _norm_sym(hm.group(1))
        if cand and cand not in _SYM_BLOCK and len(cand) >= 2:
            return cand
    cn = _SYM_CN.search(text)
    if cn:
        return _CN_COIN[cn.group(0)]
    best = ""
    for m in _SYM_TICKER.finditer(text):
        cand = _norm_sym(m.group(1))
        if not cand or cand in _SYM_BLOCK or len(cand) < 2:
            continue
        start, end = m.span(1)
        window = text[max(0, start - 8) : min(len(text), end + 12)]
        if _DIR_LONG.search(window) or _DIR_SHORT.search(window):
            return cand
        if not best:
            best = cand
    return best


def _pick_direction(text: str) -> str:
    longs = list(_DIR_LONG.finditer(text))
    shorts = list(_DIR_SHORT.finditer(text))
    ml = _MARKET_DIR_LONG.search(text)
    if ml:
        longs.append(ml)
    ms = _MARKET_DIR_SHORT.search(text)
    if ms:
        shorts.append(ms)
    if not longs and not shorts:
        return ""
    last_long = longs[-1].start() if longs else -1
    last_short = shorts[-1].start() if shorts else -1
    if last_short > last_long:
        return "空"
    if last_long >= 0:
        return "多"
    return ""


def _clean_field(v: str) -> str:
    s = (v or "").strip()
    s = re.sub(r"\s+", " ", s)
    s = re.split(r"[|｜]{2,}|\s{2,}", s)[0].strip()
    return s[:80]


def parse_trade_text(text: str, *, sender: str = "", msg_id: int | None = None) -> TradeSignal | None:
    """单条消息解析；无有效交易字段则返回 None。"""
    body = (text or "").strip()
    if not body:
        return None

    sig = TradeSignal(
        symbol=_pick_symbol(body),
        direction=_pick_direction(body),
        sender=(sender or "").strip(),
        is_departure=bool(
            _FARE.search(body)
            or _MARKET_DIR_LONG.search(body)
            or _MARKET_DIR_SHORT.search(body)
        ),
        source_text=body[:500],
        msg_ids=[int(msg_id)] if msg_id is not None else [],
    )
    em = _ENTRY.search(body)
    if em:
        sig.entry = _clean_field(em.group(1))
    else:
        mp = _MARKET_PRICE.search(body)
        if mp:
            sig.entry = _clean_field(mp.group(1))
        elif re.search(r"市[价價]\s*[多空]|市[价價][多空]", body):
            sig.entry = "市价"
        elif re.search(r"入场\s*[:：]?\s*现价|现价\s*入场|市价\s*开", body):
            sig.entry = "现价"

    tm = _TP.search(body)
    if tm:
        sig.take_profit = _clean_field(tm.group(1))
    sm = _SL.search(body)
    if sm:
        sig.stop_loss = _clean_field(sm.group(1))
    pm = _POS.search(body)
    if pm:
        sig.position = _clean_field(pm.group(1))
    nm = _NOTE.search(body)
    if nm:
        sig.note = _clean_field(nm.group(1))

    if sig.has_core:
        return sig
    if sig.take_profit or sig.stop_loss or sig.entry:
        return sig
    return None


def looks_like_trade_message(text: str) -> bool:
    """粗筛：是否值得进窗口分析。"""
    t = text or ""
    if _SYM_HASH.search(t):
        return True
    if _MARKET_DIR_LONG.search(t) or _MARKET_DIR_SHORT.search(t):
        return True
    if _DIR_LONG.search(t) or _DIR_SHORT.search(t):
        return True
    if _TP.search(t) or _SL.search(t) or _ENTRY.search(t) or _FARE.search(t):
        return True
    return False


def format_signal_push(sig: TradeSignal, *, phase: str = "full") -> str:
    """
    phase:
      - initial: 先发信号（可无止盈止损）
      - update: 补发止盈止损
      - full: 一次发全
    """
    who = (sig.sender or "未知").strip()
    if who.startswith("【") and who.endswith("】"):
        header = who
    else:
        header = f"【{who}】"

    lines = [header]
    arrow = "📈" if sig.direction == "多" else "📉" if sig.direction == "空" else "▪️"
    dir_cn = f"做{sig.direction}" if sig.direction in ("多", "空") else (sig.direction or "")
    lines.append(f"{arrow} {sig.symbol} {dir_cn}".strip())

    if sig.entry:
        lines.append(f"📈 入场：{sig.entry}")
    elif phase == "initial" and not sig.has_tpsl:
        lines.append("📈 入场：现价")

    if phase in ("full", "update") or sig.has_tpsl:
        if sig.take_profit:
            lines.append(f"💰 止盈：{sig.take_profit}")
        if sig.stop_loss:
            lines.append(f"❌ 止损：{sig.stop_loss}")

    if sig.position:
        lines.append(f"⚖️ 仓位：{sig.position}")
    if sig.note and phase != "update":
        lines.append(f"备注：{sig.note}")

    if phase == "update":
        lines.append("（补充止盈/止损）")

    return "\n".join(lines)
