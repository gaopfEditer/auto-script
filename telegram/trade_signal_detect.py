"""从群消息文本中规则提取交易信号（币种 / 多空 / 入场 / 止盈止损）。

繁简归一：先把整段文本繁→简（T2S），再走统一正则。繁简关键字同时存在
（"入場/进場/進場/进场" → 一处"进场"），靠 T2S 收敛，避免双写。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, replace

# —— 繁→简字符表（按需小集合；覆盖常见交易关键字与方向/币名） ——
_T2S = str.maketrans({
    "場": "场", "進": "进", "佈": "布", "價": "价", "幣": "币", "點": "点",
    "倉": "仓", "槓": "杠", "桿": "杆", "損": "损", "盈": "盈",
    "數": "数", "據": "据", "訊": "讯", "單": "单", "車": "车",
    "發": "发", "車": "车", "頭": "头", "倉": "仓", "頂": "顶",
    "底": "底", "長": "长", "空": "空", "多": "多", "買": "买",
    "賣": "卖", "漲": "涨", "跌": "跌", "補": "补", "齊": "齐",
    "齊": "齐", "備": "备", "註": "注", "類": "类", "線": "线",
    "對": "对", "話": "话", "說": "说", "頁": "页", "標": "标",
    "籤": "签", "記": "记", "檔": "档", "權": "权", "區": "区",
    "塊": "块", "幣": "币", "匯": "汇", "總": "总", "開": "开",
    "關": "关", "時": "时", "間": "间", "週": "周", "報": "报",
    "見": "见", "覽": "览", "響": "响", "應": "应", "當": "当",
    "樣": "样", "檢": "检", "測": "测", "設": "设", "計": "计",
    "畫": "画", "畫": "画", "視": "视", "頻": "频", "變": "变",
    "顏": "颜", "色": "色", "邊": "边", "邊": "边", "畫": "画",
})


def _t2s(text: str) -> str:
    """繁→简归一（小集合字符表，未命中保持不变）。"""
    if not text:
        return text
    return text.translate(_T2S)

# 常见中文币名 → 展示符号（同步繁简）
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
    r"(?:做多|开多|多单|看多|逢低多|做多单|埋伏单方向多|埋伏单\s*方向\s*多|\blong\b|↗|🔼|📈|🟢|⬆|看涨|上行|涨)",
    re.I,
)
_DIR_SHORT = re.compile(
    r"(?:做空|开空|空单|看空|逢高空|做空单|埋伏单方向空|埋伏单\s*方向\s*空|\bshort\b|↘|🔽|📉|🔴|⬇|看跌|下行|跌)",
    re.I,
)
# 「#SYMBOL 后紧接单个 空/多」(允许中间夹 emoji/换行/空格)，用于识别 #IOST\n📉空 这种格式
_DIR_SHORT_LOOSE = re.compile(
    r"#[A-Za-z]{2,12}\s*(?:📉|🔽|↘|⬇)?\s*空",
)
_DIR_LONG_LOOSE = re.compile(
    r"#[A-Za-z]{2,12}\s*(?:📈|🔼|↗|⬆)?\s*多",
)
_MARKET_DIR_LONG = re.compile(r"市[价價]\s*多|市[价價]多", re.I)
_MARKET_DIR_SHORT = re.compile(r"市[价價]\s*空|市[价價]空", re.I)
_SYM_HASH = re.compile(r"#([A-Za-z]{2,12})(?![A-Za-z0-9])")
_MARKET_PRICE = re.compile(
    r"市[价價]\s*[多空]\s+([0-9]+(?:\.[0-9]+)?)",
    re.I,
)
_ENTRY_EN = re.compile(
    r"\bENTRY\b\s*[:：]?\s*(市[价價]|现价|[0-9]+(?:\.[0-9]+)?)",
    re.I,
)

_SYM_TICKER = re.compile(
    r"(?<![A-Za-z0-9])\$?([A-Za-z]{2,12})(?:/USDT|/USD|USDT|USD)?(?![A-Za-z0-9])",
)
_SYM_CN = re.compile("|".join(sorted(map(re.escape, _CN_COIN.keys()), key=len, reverse=True)))
_SYM_LABEL = re.compile(
    r"币[种種]\s*[:：]\s*\$?([A-Za-z]{2,12})(?:/USDT|/USD|USDT|USD)?",
    re.I,
)
_DIR_LINE = re.compile(r"方向\s*[:：]\s*([^\n]{1,40})", re.I)

_ENTRY = re.compile(
    r"(?:入场价格|入场点|进场点|入场|建仓|开仓|挂单|上车|进场)(?!点)\s*[:：]?\s*"
    r"([^\n，,；;]*?(?=\s*(?:ENTRY|EXIT|TP|SL|止盈|止损|止損|\n|$)|$))",
    re.I,
)
_ENTRY_POINT = re.compile(
    r"(?:📌\s*)?(?:进[场場][点點]|入[场場][点點])\s*[:：]?\s*([^\n]{1,40})",
    re.I,
)
# 专门处理「「进场」 ENTRY: 市价」这种格式（括号里嵌的关键字会被主正则误捕获）
_ENTRY_WITH_LABEL = re.compile(
    r"「[^」]*进场[^」]*」\s*ENTRY\s*[:：]?\s*(市[价價]|现价|[0-9]+(?:\.[0-9]+)?)",
    re.I,
)
_TP = re.compile(
    r"(?:止盈|目标)\s*[:：]\s*([^\n止損损]{1,40})"
    r"|(?:TP|take\s*profit)\s*[:：]?\s*([^\n止損损]{1,40})",
    re.I,
)
_RECAP_PROMO = re.compile(
    r"均止盈|连胜|連勝|累计发布|累計發佈|公开频道|公開頻道|会员群|會員群|"
    r"联系助理|聯繫助理|限时活动|限時活動|详情看置顶|詳情看置頂|"
    r"跟单完全不收费|跟單完全不收費|欢迎来内部|歡迎來內部|"
    r"稳定输出|穩定輸出|免费体验|免費體驗",
    re.I,
)
_RECAP_TP_HIT = re.compile(r"TP\s*\d?\s*[+＋]\s*\d", re.I)
_TP_PROFIT = re.compile(
    r"(?:✔\s*)?(?:获利目标|获利目標|獲利目标|獲利目標)\s*[:：]?\s*([^\n止損止损]{1,60})",
    re.I,
)
_SL = re.compile(
    r"(?:止损|止損|SL|stop\s*loss)\s*[:：]?\s*([^\n]{1,40})",
    re.I,
)
_SL_POS = re.compile(
    r"(?:❌\s*)?(?:止损位置|止損位置|止损点|止損點)\s*[:：]?\s*([^\n]{1,40})",
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
        # 约定标签，不是币种
        "PROM",
    }
)

_PROM_TAG = re.compile(r"(?<![A-Za-z0-9])#prom(?![A-Za-z0-9])", re.I)
_TP_LEVELS = re.compile(
    r"(?:tp\s*([123])|止盈\s*([123])|目标\s*([123]))\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)",
    re.I,
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
    is_prom: bool = False  # #prom 约定开仓标签
    source_text: str = ""
    msg_ids: list[int] = field(default_factory=list)

    @property
    def has_core(self) -> bool:
        return bool(self.symbol and self.direction)

    @property
    def has_prom_open(self) -> bool:
        """#prom + 方向即可视为开仓意图（币种可稍后补）。"""
        return bool(self.is_prom and self.direction)

    @property
    def has_tpsl(self) -> bool:
        return bool(self.take_profit or self.stop_loss)

    @property
    def has_numeric_tpsl(self) -> bool:
        return _has_numeric_price(self.take_profit) or _has_numeric_price(self.stop_loss)

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
            is_prom=self.is_prom or other.is_prom,
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
    lm = _SYM_LABEL.search(text)
    if lm:
        cand = _norm_sym(lm.group(1))
        if cand and cand not in _SYM_BLOCK and len(cand) >= 2:
            return cand
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
    dl = _DIR_LINE.search(text)
    if dl:
        chunk = dl.group(1) or ""
        if _DIR_SHORT.search(chunk) or "👇" in chunk:
            return "空"
        if _DIR_LONG.search(chunk) or "👆" in chunk:
            return "多"
    longs = list(_DIR_LONG.finditer(text))
    shorts = list(_DIR_SHORT.finditer(text))
    # loose 模式：#SYMBOL 后紧接 📉空/📈多 这类
    ml_loose = _DIR_LONG_LOOSE.search(text)
    if ml_loose:
        longs.append(ml_loose)
    ms_loose = _DIR_SHORT_LOOSE.search(text)
    if ms_loose:
        shorts.append(ms_loose)
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


def _has_numeric_price(s: str) -> bool:
    return bool(re.search(r"\d", s or ""))


def _normalize_sender_name(sender: str) -> str:
    s = (sender or "").strip()
    if not s or s.lower() in ("none", "null", "unknown", "nan"):
        return ""
    return s


def is_spam_or_recap_message(text: str) -> bool:
    """营销话术、历史战绩回顾等非开仓消息。"""
    t = _t2s(text or "")
    if not t.strip():
        return True
    if _RECAP_PROMO.search(t):
        return True
    tp_hits = len(_RECAP_TP_HIT.findall(t))
    has_entry = bool(_ENTRY_POINT.search(t) or _ENTRY.search(t) or _ENTRY_EN.search(t))
    if tp_hits >= 2 and not has_entry:
        return True
    if tp_hits >= 1 and re.search(r"[+＋]\s*\d+(?:\.\d+)?\s*%", t) and not has_entry:
        return True
    return False


def signal_skip_reason(
    sig: TradeSignal | None,
    text: str = "",
    *,
    sender: str = "",
) -> str | None:
    """不应推送时返回原因；可推送返回 None。无止盈止损的开仓信号仍可通过。"""
    if sig is None:
        return "无法解析为交易信号"
    src = text or sig.source_text or ""
    if is_spam_or_recap_message(src):
        return "营销/战绩回顾"
    who = _normalize_sender_name(sig.sender or sender)
    if not who:
        return f"发送者无效({(sender or sig.sender)!r})"
    sym = (sig.symbol or "").upper()
    if not sym or sym in _SYM_BLOCK or len(sym) < 2 or len(sym) > 12:
        return f"币种无效({sig.symbol!r})"
    if sig.is_prom and sig.direction:
        return None
    if sig.has_core:
        return None
    if (sig.entry or "").strip() or sig.has_tpsl:
        return None
    return "缺少币种/方向"


def is_actionable_trade_signal(sig: TradeSignal | None, text: str = "", *, sender: str = "") -> bool:
    return signal_skip_reason(sig, text, sender=sender) is None


def log_signal_skip(
    reason: str,
    *,
    chat_id: int,
    title: str = "",
    profile_name: str = "",
    sender: str = "",
    msg_id: int | None = None,
    body: str = "",
    preview: int = 160,
) -> None:
    """记录被跳过的消息来源，便于手动加 main 过滤或调整监听群。"""
    ch = (profile_name or title or str(chat_id)).strip()
    prev = (body or "").replace("\n", " ").strip()
    if len(prev) > preview:
        prev = prev[:preview] + "…"
    mid = f" msg_id={msg_id}" if msg_id is not None else ""
    print(
        f"[signal-skip] {reason} | chat={chat_id}「{ch}」sender={sender!r}{mid} | {prev}",
        flush=True,
    )


def _clean_field(v: str) -> str:
    s = (v or "").strip()
    s = s.replace("—", "-").replace("–", "-").replace("−", "-")
    s = re.sub(r"\s+", " ", s)
    s = re.split(r"[|｜]{2,}|\s{2,}", s)[0].strip()
    # 截断误吞的止损等后续字段
    s = re.split(r"(?:止损|止損|SL\b)", s, maxsplit=1, flags=re.I)[0].strip()
    # 截断 ENTRY/exit/entry 等英文后续标记（针对「📍 「進場」 ENTRY: 市價」这种）
    s = re.split(r"(?:\bENTRY\b|\bEXIT\b|\bTP\b|\bSL\b)", s, maxsplit=1, flags=re.I)[0].strip()
    return s[:80]


def _pick_tp_levels(text: str) -> str:
    """收集 tp1/tp2/tp3 或 止盈1/2/3，按档位排序后逗号拼接。"""
    found: dict[int, str] = {}
    for m in _TP_LEVELS.finditer(text or ""):
        level = m.group(1) or m.group(2) or m.group(3)
        price = (m.group(4) or "").strip()
        if not level or not price:
            continue
        found[int(level)] = price
    if not found:
        return ""
    return ",".join(found[k] for k in sorted(found.keys()))


def parse_trade_text(text: str, *, sender: str = "", msg_id: int | None = None) -> TradeSignal | None:
    """单条消息解析；无有效交易字段则返回 None。"""
    body = _t2s((text or "").strip())
    if not body:
        return None

    is_prom = bool(_PROM_TAG.search(body))
    sig = TradeSignal(
        symbol=_pick_symbol(body),
        direction=_pick_direction(body),
        sender=(sender or "").strip(),
        is_departure=bool(
            _FARE.search(body)
            or _MARKET_DIR_LONG.search(body)
            or _MARKET_DIR_SHORT.search(body)
            or is_prom
        ),
        is_prom=is_prom,
        source_text=body[:500],
        msg_ids=[int(msg_id)] if msg_id is not None else [],
    )
    # 优先级：进场点/📌 > 带标签 ENTRY > _ENTRY_EN > _MARKET_PRICE > 中文 _ENTRY
    em_point = _ENTRY_POINT.search(body)
    em_label = _ENTRY_WITH_LABEL.search(body)
    em_en = _ENTRY_EN.search(body)
    em = _ENTRY.search(body)
    if em_point:
        sig.entry = _clean_field(em_point.group(1))
    elif em_label:
        sig.entry = _clean_field(em_label.group(1))
    elif em_en and (not em or em_en.start() <= em.start()):
        sig.entry = _clean_field(em_en.group(1))
    elif em:
        sig.entry = _clean_field(em.group(1))
    else:
        mp = _MARKET_PRICE.search(body)
        if mp:
            sig.entry = _clean_field(mp.group(1))
        elif re.search(r"市[价價]\s*[多空]|市[价價][多空]", body):
            sig.entry = "市价"
        elif re.search(r"入场\s*[:：]?\s*现价|现价\s*入场|市价\s*开", body):
            sig.entry = "现价"

    levels = _pick_tp_levels(body)
    tm_profit = _TP_PROFIT.search(body)
    tm = _TP.search(body)
    if levels:
        # 若通用止盈行也有内容，合并去重
        base = _clean_field(tm.group(1)) if tm else ""
        if base and base not in levels:
            sig.take_profit = f"{levels},{base}" if not re.search(r"tp\s*[123]", base, re.I) else levels
        else:
            sig.take_profit = levels
    elif tm_profit:
        raw_tp = _clean_field(tm_profit.group(1))
        sig.take_profit = raw_tp.replace("-", "—") if "—" in (tm_profit.group(1) or "") else raw_tp
    elif tm:
        sig.take_profit = _clean_field(tm.group(1) or tm.group(2) or "")
    sm_pos = _SL_POS.search(body)
    sm = _SL.search(body)
    if sm_pos:
        sig.stop_loss = _clean_field(sm_pos.group(1))
    elif sm:
        sig.stop_loss = _clean_field(sm.group(1))
    pm = _POS.search(body)
    if pm:
        sig.position = _clean_field(pm.group(1))
    nm = _NOTE.search(body)
    if nm:
        sig.note = _clean_field(nm.group(1))

    if sig.has_core or sig.has_prom_open:
        return sig
    if sig.take_profit or sig.stop_loss or sig.entry:
        return sig
    if is_prom:
        return sig
    return None


def looks_like_trade_message(text: str) -> bool:
    """粗筛：是否值得进窗口分析。"""
    if is_spam_or_recap_message(text):
        return False
    t = _t2s(text or "")
    if _PROM_TAG.search(t):
        return True
    if _SYM_HASH.search(t):
        return True
    if _MARKET_DIR_LONG.search(t) or _MARKET_DIR_SHORT.search(t):
        return True
    if _DIR_LONG.search(t) or _DIR_SHORT.search(t):
        return True
    if _DIR_LONG_LOOSE.search(t) or _DIR_SHORT_LOOSE.search(t):
        return True
    if _TP.search(t) or _TP_PROFIT.search(t) or _SL.search(t) or _SL_POS.search(t):
        return True
    if _ENTRY.search(t) or _ENTRY_POINT.search(t) or _FARE.search(t):
        return True
    if _SYM_LABEL.search(t) or _DIR_LINE.search(t):
        return True
    if _TP_LEVELS.search(t):
        return True
    return False


def has_prom_tag(text: str) -> bool:
    return bool(_PROM_TAG.search(_t2s(text or "")))


_USERNAME_IN_PARENS = re.compile(
    r"\s*[\(（]@?[A-Za-z][A-Za-z0-9_]{4,31}[\)）]"
)


def strip_username_in_parens(text: str) -> str:
    """去掉名称后的 (@username) / (username) 括号标记。"""
    if not text:
        return ""
    t = _USERNAME_IN_PARENS.sub("", text)
    t = re.sub(r"【([^】]*?)】", lambda m: f"【{m.group(1).strip()}】", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"[ \t]+\n", "\n", t)
    return t.strip()


def format_signal_push(sig: TradeSignal, *, phase: str = "full") -> str:
    """
    phase:
      - initial: 先发信号（可无止盈止损）
      - update: 补发止盈止损
      - full: 一次发全
    格式示例：
      【币圈所长】
      ETH 做空
      入场：2505-2515
      止盈：2495, 2485, 2470, 2455
      止损：2525
      备注：15m 突破站稳
    """
    who = strip_username_in_parens(_normalize_sender_name(sig.sender) or "未知")
    if who.startswith("【") and who.endswith("】"):
        header = who
    else:
        header = f"【{who}】"

    arrow = "📈" if sig.direction == "多" else "📉" if sig.direction == "空" else ""
    dir_cn = sig.direction if sig.direction in ("多", "空") else ""
    sym_dir = f"{sig.symbol or '?'} {dir_cn}".strip()
    if arrow and sym_dir:
        sym_dir = f"{arrow} {sym_dir}"

    lines = [header]
    if sym_dir:
        lines.append(sym_dir)

    if sig.is_prom:
        lines.append("#prom")

    if sig.entry:
        lines.append(f"入场：{sig.entry}")
    elif phase == "initial" and not sig.has_tpsl:
        lines.append("入场：现价")

    if phase in ("full", "update") or sig.has_tpsl:
        if sig.take_profit:
            lines.append(f"止盈：{sig.take_profit}")
        if sig.stop_loss:
            lines.append(f"止损：{sig.stop_loss}")

    if sig.position:
        lines.append(f"仓位：{sig.position}")
    if sig.note and phase != "update":
        lines.append(f"备注：{sig.note}")

    if phase == "update":
        lines.append("（补充止盈/止损）")

    return "\n".join(lines)


def push_bypass_markers() -> list[str]:
    """正文含这些标记时跳过去重（测试），默认【周一今日测试】。"""
    raw = os.environ.get("TELEGRAM_PUSH_BYPASS_MARKERS", "【周一今日测试】")
    return [m.strip() for m in raw.replace("|", ",").split(",") if m.strip()]


def is_push_bypass_message(text: str) -> bool:
    hay = text or ""
    return any(m in hay for m in push_bypass_markers())
