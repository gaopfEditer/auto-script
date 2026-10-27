"""解析卡片文本 / Discord Embed → 规范化信号。"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any


# Discord 信号频道 ID → 卡片作者（与 collector discord-signal-config 对齐）
SIGNAL_CHANNEL_AUTHORS: dict[str, str] = {
    "1444963372134301827": "seven",
    "1444963929393729686": "峰哥",
    "1444963689194192947": "颜驰",
    "1444967547169669160": "币安杀手",
    "1459861535815110810": "unknown-trader",
    "1444963506431463474": "山寨之王",
    "1444963405185159238": "币圈所长",
}


@dataclass
class ParsedCard:
    card_id: str
    symbol: str
    side: str  # LONG | SHORT
    entry_type: str  # market | limit
    entry_low: float | None = None
    entry_high: float | None = None
    tps: list[float] = field(default_factory=list)
    sl: float | None = None
    leverage: float | None = None
    title: str = ""
    source_label: str = ""
    note: str = ""
    raw_text: str = ""
    # Discord / 推送信封元数据（供沙盒表展示）
    author_name: str = ""
    author_id: str = ""
    signal_at: float | None = None  # unix 秒
    created_at: float | None = None
    updated_at: float | None = None
    channel_id: str = ""
    channel_name: str = ""
    guild_name: str = ""
    message_id: str = ""
    event: str = ""
    signal_phase: str = ""
    parser: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def resolve_signal_channel_author(
    channel_id: str = "",
    *,
    channel_name: str = "",
    source_label: str = "",
    author_name: str = "",
) -> str:
    """已知频道映射优先；否则用可读 channel_name / author_name。"""
    cid = str(channel_id or "").strip()
    if not cid:
        for blob in (channel_name, source_label):
            m = re.search(r"(\d{15,22})", str(blob or ""))
            if m:
                cid = m.group(1)
                break
    if cid and cid in SIGNAL_CHANNEL_AUTHORS:
        return SIGNAL_CHANNEL_AUTHORS[cid]
    for raw in (author_name, channel_name):
        name = str(raw or "").strip()
        if not name or re.fullmatch(r"\d{15,22}", name):
            continue
        if name.lower() == "discord":
            continue
        return name
    src = str(source_label or "").strip()
    if src:
        parts = re.split(r"\s*[·|]\s*", src)
        tail = parts[-1].strip() if parts else src
        if tail in SIGNAL_CHANNEL_AUTHORS:
            return SIGNAL_CHANNEL_AUTHORS[tail]
        if tail and not re.fullmatch(r"\d{15,22}", tail) and tail.lower() != "discord":
            return tail
    return ""


_ID_RE = re.compile(
    r"(?:^|\n)\s*(?:ID|Id|id)\s*[:：]?\s*([A-Za-z]{1,8}-?\d{1,})",
    re.MULTILINE,
)
_ID_TAIL_RE = re.compile(r"\b([A-Z]{1,4}-\d{1,})\b")
_LEV_RE = re.compile(
    r"(?:杠杆|倍數|倍数|槓桿|Leverage|leverage|Lev)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[xXｘ]?",
    re.I,
)
_SL_RE = re.compile(
    r"(?:止损|止損|SL|Sl|sl)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)",
    re.I,
)
_TP_RE = re.compile(
    r"(?:止盈|目标|目標|TP|Tp|tp|Targets?)\s*[:：]?\s*([0-9·./\s,~-]+)",
    re.I,
)
_ENTRY_RE = re.compile(
    r"(?:入场|入場|Entry|entry)\s*[:：]?\s*([^\n]+)",
    re.I,
)
_SIDE_LONG = re.compile(
    r"(做多|市价多|市長多|市價多|進多|进多|Long|LONG|long\s*setup|多)",
    re.I,
)
_SIDE_SHORT = re.compile(
    r"(做空|市价空|市價空|進空|进空|Short|SHORT|空)",
    re.I,
)
_MARKET = re.compile(r"(市价|市價|市价多|市价空|市價多|市價空|market)", re.I)
_SYM_HASH = re.compile(r"#([A-Za-z]{2,15})\b")
_SYM_PLAIN = re.compile(
    r"(?:币种|幣種|标的|Symbol|symbol)\s*[:：]?\s*#?([A-Za-z]{2,15})",
    re.I,
)
_NUMS = re.compile(r"([0-9]+(?:\.[0-9]+)?)")


def normalize_symbol(raw: str) -> str:
    s = (raw or "").strip().upper().lstrip("#")
    if not s:
        return ""
    if s.endswith("USDT") or s.endswith("USD"):
        return s if s.endswith("USDT") else f"{s}T"
    # 稳定币对：默认 U 本位永续
    return f"{s}USDT"


def _parse_nums(blob: str) -> list[float]:
    out: list[float] = []
    for m in _NUMS.finditer(blob or ""):
        try:
            v = float(m.group(1))
            if v > 0:
                out.append(v)
        except ValueError:
            continue
    return out


def _parse_entry(blob: str) -> tuple[str, float | None, float | None]:
    text = (blob or "").strip()
    if not text or _MARKET.search(text):
        return "market", None, None
    nums = _parse_nums(text)
    if not nums:
        return "market", None, None
    if len(nums) == 1:
        return "limit", nums[0], nums[0]
    lo, hi = min(nums[0], nums[1]), max(nums[0], nums[1])
    return "limit", lo, hi


def _guess_symbol(text: str, title: str = "") -> str:
    for blob in (title, text):
        m = _SYM_PLAIN.search(blob)
        if m:
            return normalize_symbol(m.group(1))
        m = _SYM_HASH.search(blob)
        if m:
            return normalize_symbol(m.group(1))
    # 「Long Setup · BTC」/ 首行币种
    for line in (title + "\n" + text).splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.search(
            r"(?:Setup|setup|波段|進多|进多|進空|进空)?\s*[·•|｜]?\s*#?([A-Z]{2,10})\b",
            line,
        )
        if m and m.group(1) not in ("LONG", "SHORT", "SETUP", "ID"):
            cand = m.group(1)
            if cand not in ("CN", "EN", "TW", "USDT"):
                return normalize_symbol(cand)
        # 单独一行 BTC / SOL
        if re.fullmatch(r"#?[A-Za-z]{2,15}", line):
            return normalize_symbol(line)
    return ""


def _guess_side(text: str, title: str = "") -> str | None:
    blob = f"{title}\n{text}"
    # 市价多/空优先
    if re.search(r"市[价價]\s*多|市價多|市价多", blob, re.I):
        return "LONG"
    if re.search(r"市[价價]\s*空|市價空|市价空", blob, re.I):
        return "SHORT"
    if _SIDE_SHORT.search(blob) and not re.search(r"做多|進多|进多|Long", blob, re.I):
        return "SHORT"
    if _SIDE_LONG.search(blob):
        return "LONG"
    if _SIDE_SHORT.search(blob):
        return "SHORT"
    return None


def _extract_id(text: str, explicit: str | None = None) -> str:
    if explicit and str(explicit).strip():
        return str(explicit).strip().upper()
    m = _ID_RE.search(text or "")
    if m:
        return m.group(1).upper()
    m = _ID_TAIL_RE.search(text or "")
    if m:
        return m.group(1).upper()
    return ""


def parse_card_text(
    text: str,
    *,
    card_id: str | None = None,
    title: str = "",
    source_label: str = "",
) -> ParsedCard | None:
    raw = (text or "").strip()
    if not raw and not title:
        return None
    blob = f"{title}\n{raw}".strip()
    cid = _extract_id(blob, card_id)
    if not cid:
        return None

    symbol = _guess_symbol(raw, title)
    side = _guess_side(raw, title)
    if not symbol or not side:
        return None

    entry_type, entry_low, entry_high = "limit", None, None
    em = _ENTRY_RE.search(blob)
    if em:
        entry_type, entry_low, entry_high = _parse_entry(em.group(1))
    elif _MARKET.search(blob):
        entry_type, entry_low, entry_high = "market", None, None

    tps: list[float] = []
    tm = _TP_RE.search(blob)
    if tm:
        tps = _parse_nums(tm.group(1))

    sl = None
    sm = _SL_RE.search(blob)
    if sm:
        try:
            sl = float(sm.group(1))
        except ValueError:
            sl = None

    lev = None
    lm = _LEV_RE.search(blob)
    if lm:
        try:
            lev = float(lm.group(1))
        except ValueError:
            lev = None

    if entry_type == "limit" and (entry_low is None or sl is None):
        # 无明确入场时，若写了市价家族语义
        if _MARKET.search(blob):
            entry_type = "market"

    if sl is None or (entry_type == "limit" and entry_low is None):
        # 最少要有止损；限价还要入场区。市价可无入场数字
        if entry_type != "market" or sl is None:
            # seven 繁体：可能只有 TP/SL 无数入场 → 市价
            if sl is not None and tps and entry_low is None:
                entry_type = "market"
            elif sl is None:
                return None

    return ParsedCard(
        card_id=cid,
        symbol=symbol,
        side=side,
        entry_type=entry_type,
        entry_low=entry_low,
        entry_high=entry_high if entry_high is not None else entry_low,
        tps=tps,
        sl=sl,
        leverage=lev,
        title=title or raw.splitlines()[0][:80],
        source_label=source_label,
        note="",
        raw_text=raw,
    )


def parse_card_embed(embed: dict[str, Any], *, card_id: str | None = None) -> ParsedCard | None:
    title = str(embed.get("title") or "")
    fields = embed.get("fields") or []
    kv: dict[str, str] = {}
    for f in fields:
        if not isinstance(f, dict):
            continue
        name = str(f.get("name") or "").strip()
        value = str(f.get("value") or "").strip()
        if name:
            kv[name] = value

    def _pick(*names: str) -> str:
        for n in names:
            for k, v in kv.items():
                if k.lower() == n.lower() or n in k:
                    return v
        return ""

    lines = [title]
    sym = _pick("币种", "幣種", "Symbol", "标的")
    side_v = _pick("方向", "Direction", "Side")
    entry_v = _pick("入场", "入場", "Entry")
    tp_v = _pick("止盈", "目标", "目標", "TP", "Targets")
    sl_v = _pick("止损", "止損", "SL")
    lev_v = _pick("杠杆", "槓桿", "倍数", "倍數", "Leverage")
    src_v = _pick("来源", "來源", "Source")
    id_v = _pick("ID", "Id", "卡片ID") or (card_id or "")

    if sym:
        lines.append(f"币种：{sym}")
    if side_v:
        lines.append(f"方向：{side_v}")
    if entry_v:
        lines.append(f"入场：{entry_v}")
    if lev_v:
        lines.append(f"杠杆：{lev_v}")
    if tp_v:
        lines.append(f"止盈：{tp_v}")
    if sl_v:
        lines.append(f"止损：{sl_v}")
    if id_v:
        lines.append(f"ID {id_v}")

    # description / footer 拼进去
    desc = str(embed.get("description") or "")
    if desc:
        lines.append(desc)
    footer = embed.get("footer")
    if isinstance(footer, dict) and footer.get("text"):
        lines.append(str(footer["text"]))

    return parse_card_text(
        "\n".join(lines),
        card_id=id_v or card_id,
        title=title,
        source_label=src_v,
    )


def _parse_ts(raw: Any) -> float | None:
    """ISO / unix 秒或毫秒 → unix 秒。"""
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)):
        v = float(raw)
        if v > 1e12:
            return v / 1000.0
        if v > 1e9:
            return v
        return v
    s = str(raw).strip()
    if not s:
        return None
    try:
        if s.isdigit() or (s.replace(".", "", 1).isdigit() and s.count(".") <= 1):
            return _parse_ts(float(s))
    except ValueError:
        pass
    try:
        from datetime import datetime

        # 支持 2026-07-26T14:00:00Z / 带空格本地串
        ss = s.replace("Z", "+00:00")
        if " " in ss and "T" not in ss:
            ss = ss.replace(" ", "T", 1)
        dt = datetime.fromisoformat(ss)
        return dt.timestamp()
    except Exception:
        return None


def _author_display(payload: dict[str, Any]) -> tuple[str, str]:
    """返回 (显示名, author_id)。"""
    author = payload.get("author")
    aid = ""
    name = ""
    if isinstance(author, dict):
        aid = str(author.get("author_id") or author.get("id") or "").strip()
        name = str(
            author.get("display")
            or author.get("global_name")
            or author.get("username")
            or author.get("name")
            or ""
        ).strip()
    if not name:
        name = str(
            payload.get("author_name")
            or payload.get("author_display")
            or payload.get("author_global_name")
            or payload.get("author_username")
            or payload.get("display")
            or payload.get("global_name")
            or payload.get("username")
            or ""
        ).strip()
    if not aid:
        aid = str(payload.get("author_id") or "").strip()
    return name, aid


def _channel_id(payload: dict[str, Any]) -> str:
    ch = payload.get("channel")
    if isinstance(ch, dict):
        cid = str(ch.get("id") or ch.get("channel_id") or "").strip()
        if cid:
            return cid
    return str(
        payload.get("channel_id") or payload.get("channelId") or ""
    ).strip()


def _channel_guild_names(payload: dict[str, Any]) -> tuple[str, str]:
    ch = payload.get("channel")
    gu = payload.get("guild") or payload.get("server")
    ch_name = ""
    gu_name = ""
    if isinstance(ch, dict):
        ch_name = str(ch.get("name") or "").strip()
    elif isinstance(ch, str):
        ch_name = ch.strip()
    if isinstance(gu, dict):
        gu_name = str(gu.get("name") or "").strip()
    elif isinstance(gu, str):
        gu_name = gu.strip()
    if not ch_name:
        ch_name = str(payload.get("channel_name") or "").strip()
    if not gu_name:
        gu_name = str(payload.get("guild_name") or payload.get("server_name") or "").strip()
    return ch_name, gu_name


def _side_from_direction(raw: Any) -> str | None:
    s = str(raw or "").strip()
    if not s:
        return None
    return _guess_side(s, "")


def _apply_envelope_meta(card: ParsedCard, payload: dict[str, Any]) -> ParsedCard:
    """把推送信封上的作者/时间/频道等写进 ParsedCard。"""
    author_name, author_id = _author_display(payload)
    if author_name:
        card.author_name = author_name
    if author_id:
        card.author_id = author_id
    cid = _channel_id(payload)
    if cid:
        card.channel_id = cid
    ch, gu = _channel_guild_names(payload)
    if ch:
        card.channel_name = ch
    if gu:
        card.guild_name = gu

    # 频道 ID → 品牌作者（如 1444963506431463474 → 山寨之王）
    mapped = resolve_signal_channel_author(
        card.channel_id,
        channel_name=card.channel_name,
        source_label=str(payload.get("source_label") or card.source_label or ""),
        author_name=card.author_name,
    )
    if mapped:
        card.author_name = mapped
        if not card.channel_name or re.fullmatch(r"\d{15,22}", card.channel_name):
            card.channel_name = mapped

    card.message_id = str(payload.get("message_id") or card.message_id or "").strip()
    card.event = str(payload.get("event") or card.event or "").strip()
    card.signal_phase = str(
        payload.get("signal_phase") or payload.get("phase") or card.signal_phase or ""
    ).strip()
    card.parser = str(payload.get("parser") or card.parser or "").strip()

    sig = _parse_ts(
        payload.get("signal_at")
        or payload.get("local_time")
        or payload.get("time")
    )
    if sig is not None:
        card.signal_at = sig
    created = _parse_ts(payload.get("created_at"))
    if created is not None:
        card.created_at = created
    updated = _parse_ts(payload.get("updated_at"))
    if updated is not None:
        card.updated_at = updated
    if card.signal_at is None and card.created_at is not None:
        card.signal_at = card.created_at

    src = str(
        payload.get("source_label")
        or payload.get("source")
        or (
            f"{gu} · {card.channel_name or ch}"
            if gu or card.channel_name or ch
            else ""
        )
        or card.source_label
    ).strip()
    # 把 "discord · 雪花ID" 规范成 "discord · 山寨之王"
    if card.author_name and re.search(r"\d{15,22}", src):
        src = re.sub(r"\d{15,22}", card.author_name, src, count=1)
    if src:
        card.source_label = src
    return card


def _try_parse_from_parsed_block(
    payload: dict[str, Any], *, card_id: str | None
) -> ParsedCard | None:
    """优先用顶层 symbol/direction + parsed / execution.planned 结构化字段。"""
    parsed = payload.get("parsed")
    if not isinstance(parsed, dict):
        parsed = {}
    else:
        parsed = dict(parsed)

    # 合并 execution（含 Discord collector 的 planned.*）
    execution = payload.get("execution")
    if isinstance(execution, dict):
        if execution.get("symbol") and not parsed.get("symbol"):
            parsed["symbol"] = execution.get("symbol")
        if execution.get("direction") and not parsed.get("direction"):
            parsed["direction"] = execution.get("direction")
        planned = execution.get("planned")
        if isinstance(planned, dict):
            if planned.get("entryPrice") is not None and parsed.get("entry") is None:
                parsed["entry"] = planned.get("entryPrice")
            if planned.get("stopLossPrice") is not None and parsed.get("sl") is None:
                parsed["sl"] = planned.get("stopLossPrice")
            tps_planned = planned.get("takeProfitPrices")
            if tps_planned is not None and not parsed.get("tps"):
                parsed["tps"] = tps_planned
        for k in ("entry", "entry_low", "entry_high", "sl", "tps", "leverage", "entry_type"):
            if k not in parsed and execution.get(k) is not None:
                parsed[k] = execution[k]

    sym = payload.get("symbol") or parsed.get("symbol")
    side = _side_from_direction(
        payload.get("direction")
        or payload.get("side")
        or parsed.get("side")
        or parsed.get("direction")
        or (execution.get("direction") if isinstance(execution, dict) else None)
    )
    text = str(
        payload.get("text")
        or payload.get("raw_content")
        or payload.get("content")
        or ""
    )
    cid = str(
        card_id
        or payload.get("card_id")
        or payload.get("uid")
        or payload.get("id")
        or ""
    ).strip()

    # 有结构化 symbol+side 时直接组；否则回落正文解析
    if sym and side:
        et = str(parsed.get("entry_type") or "").lower()
        lo = parsed.get("entry_low")
        hi = parsed.get("entry_high")
        if lo is None and parsed.get("entry") is not None:
            et2, lo, hi = _parse_entry(str(parsed.get("entry")))
            et = et or et2
        if not et:
            et = "market" if _MARKET.search(str(parsed.get("entry") or text)) else "limit"
        tps = parsed.get("tps") or []
        if isinstance(tps, str):
            tps = _parse_nums(tps)
        elif not isinstance(tps, list):
            tps = []
        else:
            # takeProfitPrices 可能是数字或字符串
            cleaned: list[float] = []
            for x in tps:
                try:
                    if isinstance(x, (int, float)):
                        v = float(x)
                    else:
                        nums = _parse_nums(str(x))
                        v = nums[0] if nums else 0.0
                    if v > 0:
                        cleaned.append(v)
                except (TypeError, ValueError):
                    continue
            tps = cleaned
        sl = parsed.get("sl")
        if sl is not None and not isinstance(sl, (int, float)):
            nums = _parse_nums(str(sl))
            sl = nums[0] if nums else None
        if sl is None and text:
            sm = _SL_RE.search(text)
            if sm:
                try:
                    sl = float(sm.group(1))
                except ValueError:
                    sl = None
        lev = parsed.get("leverage") or payload.get("leverage")
        try:
            card = ParsedCard(
                card_id=cid.upper() if cid else "",
                symbol=normalize_symbol(str(sym)),
                side=side,
                entry_type=et if et in ("market", "limit") else "limit",
                entry_low=float(lo) if lo is not None else None,
                entry_high=float(hi) if hi is not None else (float(lo) if lo is not None else None),
                tps=[float(x) for x in tps if float(x) > 0],
                sl=float(sl) if sl is not None else None,
                leverage=float(lev) if lev else None,
                title=str(payload.get("title") or "").strip(),
                source_label="",
                raw_text=text,
            )
        except (TypeError, ValueError):
            card = None
        if card and not card.card_id:
            from_text = parse_card_text(text, card_id=None)
            if from_text:
                card.card_id = from_text.card_id
                if card.sl is None:
                    card.sl = from_text.sl
                if not card.tps:
                    card.tps = from_text.tps
        if card and card.card_id:
            # 缺止损时按入场合成 ±3%，保证可接入监听
            if card.sl is None or card.sl <= 0:
                ref = card.entry_low or card.entry_high
                if ref and ref > 0:
                    pad = 0.03
                    card.sl = ref * (1 - pad) if card.side == "LONG" else ref * (1 + pad)
            if card.sl and card.sl > 0:
                if card.entry_type == "limit" and card.entry_low is None and card.tps:
                    card.entry_type = "market"
                return _apply_envelope_meta(card, payload)

    # 纯正文 / embed
    if payload.get("embed") and isinstance(payload["embed"], dict):
        card = parse_card_embed(payload["embed"], card_id=cid or None)
        if card:
            return _apply_envelope_meta(card, payload)
    if text:
        card = parse_card_text(
            text,
            card_id=cid or None,
            title=str(payload.get("title") or ""),
            source_label=str(payload.get("source_label") or payload.get("source") or ""),
        )
        if card:
            if sym:
                card.symbol = normalize_symbol(str(sym))
            if side:
                card.side = side
            return _apply_envelope_meta(card, payload)
    return None


def parse_card_message(payload: dict[str, Any] | str) -> ParsedCard | None:
    """接受完整推送 JSON 或纯文本。"""
    if isinstance(payload, str):
        return parse_card_text(payload)
    if not isinstance(payload, dict):
        return None

    # 透传 / 已规范化（含元数据）
    if payload.get("card_id") and payload.get("symbol") and payload.get("side"):
        try:
            tps = payload.get("tps") or []
            if isinstance(tps, str):
                tps = _parse_nums(tps)
            et = str(payload.get("entry_type") or "limit").lower()
            if et not in ("market", "limit"):
                et = "market" if _MARKET.search(str(payload.get("entry") or "")) else "limit"
            lo = payload.get("entry_low")
            hi = payload.get("entry_high")
            if lo is None and payload.get("entry") is not None:
                et2, lo, hi = _parse_entry(str(payload.get("entry")))
                et = et2
            side = str(payload["side"]).upper()
            if side not in ("LONG", "SHORT"):
                side = _side_from_direction(payload.get("direction") or side) or side
            sl_raw = payload.get("sl")
            if sl_raw is None and isinstance(payload.get("parsed"), dict):
                sl_raw = payload["parsed"].get("sl")
            if not tps and isinstance(payload.get("parsed"), dict):
                pt = payload["parsed"].get("tps") or []
                tps = _parse_nums(pt) if isinstance(pt, str) else list(pt)
            card = ParsedCard(
                card_id=str(payload["card_id"]).upper(),
                symbol=normalize_symbol(str(payload["symbol"])),
                side=side,
                entry_type=et,
                entry_low=float(lo) if lo is not None else None,
                entry_high=float(hi) if hi is not None else (float(lo) if lo is not None else None),
                tps=[float(x) for x in tps if float(x) > 0],
                sl=float(sl_raw) if sl_raw is not None else None,
                leverage=float(payload["leverage"]) if payload.get("leverage") else None,
                title=str(payload.get("title") or ""),
                source_label=str(payload.get("source_label") or payload.get("source") or ""),
                note=str(payload.get("note") or ""),
                raw_text=str(
                    payload.get("raw_text")
                    or payload.get("raw_content")
                    or payload.get("text")
                    or ""
                ),
                author_name=str(payload.get("author_name") or ""),
                author_id=str(payload.get("author_id") or ""),
                signal_at=_parse_ts(payload.get("signal_at")),
                created_at=_parse_ts(payload.get("created_at")),
                updated_at=_parse_ts(payload.get("updated_at")),
                channel_id=str(payload.get("channel_id") or ""),
                channel_name=str(payload.get("channel_name") or ""),
                guild_name=str(payload.get("guild_name") or ""),
                message_id=str(payload.get("message_id") or ""),
                event=str(payload.get("event") or ""),
                signal_phase=str(payload.get("signal_phase") or ""),
                parser=str(payload.get("parser") or ""),
            )
            card = _apply_envelope_meta(card, payload)
            if card.sl is not None:
                return card
        except (TypeError, ValueError, KeyError):
            pass

    cid = payload.get("card_id") or payload.get("uid") or payload.get("id") or payload.get("ID")
    card = _try_parse_from_parsed_block(payload, card_id=str(cid) if cid else None)
    if card:
        return card

    if payload.get("fields") and isinstance(payload.get("fields"), list):
        card = parse_card_embed(payload, card_id=str(cid) if cid else None)
        if card:
            return _apply_envelope_meta(card, payload)

    text = str(
        payload.get("text")
        or payload.get("raw_content")
        or payload.get("content")
        or payload.get("message")
        or ""
    )
    title = str(payload.get("title") or "")
    src = str(payload.get("source_label") or payload.get("source") or "")
    card = parse_card_text(text, card_id=str(cid) if cid else None, title=title, source_label=src)
    if card:
        return _apply_envelope_meta(card, payload)
    return None
