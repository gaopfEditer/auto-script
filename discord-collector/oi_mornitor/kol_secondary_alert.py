"""KOL 二次预警：关注名单 → watchlist → 形态/放量/EMA144 → webhook 或 dry-run 落盘。

与 OI 热钱推送隔离；形态固定 inverted_hammer / engulfing / shooting_star（无 hammer）。
关注名单在 UI 落地前种子自 backtest_three_way 临时 allowlist（Discord 高产 + channel_profiles.send）。
"""
from __future__ import annotations

import asyncio
import json
import re
import logging
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from oi_mornitor.backtest_three_way import load_temp_kol_allowlist
from oi_mornitor.config import FAPI_BASE_URL
from oi_mornitor.env_parse import env_float, env_int, env_str
from oi_mornitor.oi_entry_filter import bars_from_ohlcv_rows, scan_patterns_on_bar
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol

logger = logging.getLogger(__name__)

_PKG = Path(__file__).resolve().parent
_DEFAULT_DATA = _PKG / "data" / "kol_secondary"
_HOME_DATA = Path.home() / ".grokbot" / "kol-secondary"

PATTERN_ZH = {
    "inverted_hammer": "倒锤子",
    "engulfing": "吞没",
    "shooting_star": "射击之星",
}

# Discord 高产频道展示名（临时种子，与 backtest_three_way 注释对齐）
_DISCORD_DISPLAY: dict[str, str] = {
    "1444962439471955989": "三马哥合约",
    "1444963506431463474": "山寨之王",
    "1444963405185159238": "币圈所长",
    "1444962376066793513": "舒琴行情分析",
    "1444963929393729686": "比特币峰哥",
    "1444963474718462085": "比特币军长",
    "1444962339743989843": "大镖客",
    "1444963372134301827": "seven",
    "1444963689194192947": "颜驰-vip",
}


def data_dir() -> Path:
    raw = env_str("KOL_SECONDARY_DATA_DIR", "")
    if raw:
        p = Path(raw).expanduser()
    else:
        p = _DEFAULT_DATA
    p.mkdir(parents=True, exist_ok=True)
    return p


def load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("读 %s 失败: %s", path, exc)
        return default


def save_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _channel_profiles_path() -> Path | None:
    auto_script = _PKG.parent.parent
    p = auto_script / "telegram" / "channel_profiles.json"
    return p if p.is_file() else None


def channel_display_name(channel_id: str) -> str:
    cid = str(channel_id)
    if cid in _DISCORD_DISPLAY:
        return _DISCORD_DISPLAY[cid]
    profiles = _channel_profiles_path()
    if profiles:
        try:
            data = json.loads(profiles.read_text(encoding="utf-8"))
            entry = data.get(cid)
            if isinstance(entry, dict) and entry.get("name"):
                return str(entry["name"])
        except (OSError, json.JSONDecodeError):
            pass
    return cid


def seed_followed_kols(*, force: bool = False) -> list[dict[str, Any]]:
    """从临时 Discord 高产 + channel_profiles.send 种子关注名单。"""
    path = data_dir() / "followed_kols.json"
    existing = load_json(path, None)
    if existing is not None and not force:
        if isinstance(existing, list):
            return existing
        if isinstance(existing, dict) and isinstance(existing.get("kols"), list):
            return existing["kols"]

    allow = load_temp_kol_allowlist()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    kols: list[dict[str, Any]] = []
    seen: set[str] = set()
    for cid in allow.get("channel_ids") or []:
        cid = str(cid)
        if cid in seen:
            continue
        seen.add(cid)
        kols.append(
            {
                "channel_id": cid,
                "display_name": channel_display_name(cid),
                "active": True,
                "followed_at": now,
                "temporary_seed": True,
            }
        )
    payload = {
        "temporary": True,
        "note": allow.get("note")
        or "临时名单：Discord 高产频道 + telegram channel_profiles.send；非最终资深 KOL",
        "seeded_at": now,
        "kols": kols,
    }
    save_json(path, payload)
    # 兼容扁平 list 读取
    save_json(data_dir() / "followed_kols.flat.json", kols)
    return kols


def active_followed_ids(kols: Sequence[Mapping[str, Any]] | None = None) -> set[str]:
    if kols is None:
        raw = load_json(data_dir() / "followed_kols.json", {})
        if isinstance(raw, list):
            kols = raw
        else:
            kols = (raw or {}).get("kols") or []
    out: set[str] = set()
    for k in kols:
        if not isinstance(k, Mapping):
            continue
        if k.get("active") is False:
            continue
        cid = str(k.get("channel_id") or "").strip()
        if cid:
            out.add(cid)
    return out


def leader_bases() -> set[str]:
    raw = env_str("KOL_LEADER_SYMBOLS", "BTC,ETH,QQQ")
    return {p.strip().upper() for p in raw.split(",") if p.strip()}


_SYM_RE = re.compile(r"^[A-Z0-9]{2,20}USDT$")


def normalize_watch_symbol(symbol: str) -> str:
    """BTC/ETH/QQQ → *USDT；已有 USDT 后缀则走 normalize_usdt_symbol。

    拒绝明显脏串（多币拼接等），避免扫描无效合约浪费时间。
    """
    s = str(symbol or "").strip().upper().replace("-", "").replace("_", "")
    if not s:
        return ""
    out = normalize_usdt_symbol(s)
    if not out or not _SYM_RE.match(out):
        return ""
    # 极端脏串：base 过长（如 BTCSOLETHCRCL）
    base = out[:-4]
    if len(base) > 12:
        return ""
    return out


def is_leader_symbol(symbol: str) -> bool:
    sym = normalize_watch_symbol(symbol)
    if not sym:
        return False
    base = human_base_asset(sym)
    return base.upper() in leader_bases()


def follow_patterns() -> frozenset[str]:
    raw = env_str("KOL_FOLLOW_PATTERNS", "inverted_hammer,engulfing,shooting_star")
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    # 硬过滤：禁止 hammer / 大锤子
    banned = {"hammer", "大锤子"}
    return frozenset(p for p in parts if p not in banned)


def mysql_cfg() -> dict[str, str]:
    # Prefer discord-collector/.env already loaded into process; else defaults
    return {
        "host": env_str("KOL_MYSQL_HOST", env_str("MYSQL_HOST", "127.0.0.1")),
        "user": env_str("KOL_MYSQL_USER", env_str("MYSQL_USER", "root")),
        "password": env_str("KOL_MYSQL_PASSWORD", env_str("MYSQL_PASSWORD", "123456")),
        "db": env_str("KOL_MYSQL_DB", env_str("MYSQL_DATABASE", "discord_collector")),
        "port": env_str("KOL_MYSQL_PORT", env_str("MYSQL_PORT", "3306")),
    }


def pull_recent_cards(*, after_id: int = 0, limit: int = 200, bootstrap_recent: bool = False) -> list[dict[str, Any]]:
    """拉取 id > after_id 且 symbol 非空的信号卡。

    bootstrap_recent=True 且 after_id==0 时，取最近 limit 条（避免 ASC 全表最旧段）。
    """
    cfg = mysql_cfg()
    limit = max(1, min(int(limit), 1000))
    after_id = max(0, int(after_id))
    bootstrap = bootstrap_recent and after_id <= 0
    try:
        import pymysql

        conn = pymysql.connect(
            host=cfg["host"],
            user=cfg["user"],
            password=cfg["password"],
            database=cfg["db"],
            port=int(cfg["port"] or 3306),
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
        )
        try:
            with conn.cursor() as cur:
                if bootstrap:
                    cur.execute(
                        """
                        SELECT id, channel_id, symbol, source_type,
                               COALESCE(signal_at, created_at) AS event_at,
                               LEFT(raw_content, 2000) AS raw_text
                        FROM discord_signal_cards
                        WHERE symbol IS NOT NULL AND symbol <> ''
                        ORDER BY id DESC
                        LIMIT %s
                        """,
                        (limit,),
                    )
                    rows = list(reversed(cur.fetchall()))
                else:
                    cur.execute(
                        """
                        SELECT id, channel_id, symbol, source_type,
                               COALESCE(signal_at, created_at) AS event_at,
                               LEFT(raw_content, 2000) AS raw_text
                        FROM discord_signal_cards
                        WHERE symbol IS NOT NULL AND symbol <> ''
                          AND id > %s
                        ORDER BY id ASC
                        LIMIT %s
                        """,
                        (after_id, limit),
                    )
                    rows = cur.fetchall()
        finally:
            conn.close()
        out: list[dict[str, Any]] = []
        for r in rows:
            event_at = r["event_at"]
            if hasattr(event_at, "isoformat"):
                mentioned = event_at.isoformat()
                if hasattr(event_at, "timestamp"):
                    ts_ms = int(event_at.replace(tzinfo=timezone.utc).timestamp() * 1000)
                else:
                    ts_ms = 0
            else:
                mentioned = str(event_at)
                ts_ms = 0
            out.append(
                {
                    "id": int(r["id"]),
                    "channel_id": str(r["channel_id"]),
                    "symbol": str(r["symbol"]),
                    "source_type": str(r.get("source_type") or ""),
                    "mentioned_at": mentioned,
                    "ts_ms": ts_ms,
                    "raw_text": str(r.get("raw_text") or ""),
                }
            )
        return out
    except ImportError:
        pass
    except Exception as exc:
        logger.warning("pymysql 拉取失败，改用 mysql cli: %s", exc)

    if bootstrap:
        sql = (
            "SELECT id, channel_id, symbol, source_type, "
            "COALESCE(signal_at, created_at) AS event_at, "
            "UNIX_TIMESTAMP(COALESCE(signal_at, created_at))*1000 AS ts_ms, "
            "REPLACE(REPLACE(REPLACE(LEFT(raw_content,2000),'\\t',' '),'\\n',' '),'\\r',' ') AS raw_text "
            "FROM discord_signal_cards "
            "WHERE symbol IS NOT NULL AND symbol<>'' "
            "ORDER BY id DESC "
            f"LIMIT {limit}"
        )
    else:
        sql = (
            "SELECT id, channel_id, symbol, source_type, "
            "COALESCE(signal_at, created_at) AS event_at, "
            "UNIX_TIMESTAMP(COALESCE(signal_at, created_at))*1000 AS ts_ms, "
            "REPLACE(REPLACE(REPLACE(LEFT(raw_content,2000),'\\t',' '),'\\n',' '),'\\r',' ') AS raw_text "
            "FROM discord_signal_cards "
            f"WHERE symbol IS NOT NULL AND symbol<>'' AND id > {after_id} "
            "ORDER BY id ASC "
            f"LIMIT {limit}"
        )
    cmd = [
        "mysql",
        f"-u{cfg['user']}",
        f"-p{cfg['password']}",
        f"-h{cfg['host']}",
        f"-P{cfg['port']}",
        cfg["db"],
        "-N",
        "-B",
        "-e",
        sql,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        logger.error("mysql cli failed: %s", (proc.stderr or "")[:500])
        return []
    out = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        try:
            cid_id = int(parts[0])
            ts_ms = int(float(parts[5]))
        except ValueError:
            continue
        out.append(
            {
                "id": cid_id,
                "channel_id": parts[1],
                "symbol": parts[2],
                "source_type": parts[3],
                "mentioned_at": parts[4],
                "ts_ms": ts_ms,
                "raw_text": parts[6] if len(parts) > 6 else "",
            }
        )
    if bootstrap:
        out.reverse()
    return out


def load_watchlist() -> dict[str, Any]:
    raw = load_json(data_dir() / "watchlist.json", {"symbols": {}})
    if isinstance(raw, list):
        # legacy list form
        symbols = {}
        for item in raw:
            if isinstance(item, dict) and item.get("symbol"):
                symbols[str(item["symbol"]).upper()] = item
        return {"symbols": symbols}
    if "symbols" not in raw:
        raw["symbols"] = {}
    return raw


def save_watchlist(wl: dict[str, Any]) -> None:
    save_json(data_dir() / "watchlist.json", wl)


def mention_max_age_hours() -> float:
    return env_float("KOL_MENTION_MAX_AGE_HOURS", 48.0, min_val=1.0, max_val=24 * 60)


def parse_mention_ms(value: Any) -> int | None:
    """mentioned_at → epoch ms；无时区按 UTC（与 pull_recent_cards 一致）。"""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    txt = str(value).strip().replace("T", " ").replace("Z", "+00:00")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S%z", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(txt, fmt)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    return None


def mention_date_label(value: Any) -> str:
    """M/D（Asia/Shanghai）。"""
    ms = parse_mention_ms(value)
    if ms is None:
        return ""
    from datetime import timedelta

    dt = datetime.fromtimestamp(ms / 1000, tz=timezone(timedelta(hours=8)))
    return f"{dt.month}/{dt.day}"


def mention_is_genuine(symbol: str, raw_text: str) -> bool:
    """原文须以整词 / $TICKER / #TICKER / TICKERUSDT 出现 base，防子串误匹配（如 UB ⊂ UBER）。
    raw_text 为空（旧数据）时不判伪。"""
    text = str(raw_text or "")
    if not text.strip():
        return True
    base = normalize_watch_symbol(symbol)
    if base.endswith("USDT"):
        base = base[:-4]
    if not base:
        return False
    pat = re.compile(
        r"(?<![A-Za-z0-9])[#$]?" + re.escape(base) + r"(?:[/\-_ ]?USDT(?:\.P)?)?(?![A-Za-z0-9])",
        re.IGNORECASE,
    )
    return bool(pat.search(text))


def fresh_sources(entry: Mapping[str, Any] | None, *, now_ms: int | None = None) -> list[dict[str, Any]]:
    """仅保留在 KOL_MENTION_MAX_AGE_HOURS 内的真实提及（按时间升序）。"""
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    cutoff = now - int(mention_max_age_hours() * 3600 * 1000)
    out = []
    for s in (entry or {}).get("sources") or []:
        if not isinstance(s, dict) or s.get("genuine") is False:
            continue
        ms = parse_mention_ms(s.get("mentioned_at"))
        if ms is not None and ms >= cutoff:
            out.append(s)
    out.sort(key=lambda x: parse_mention_ms(x.get("mentioned_at")) or 0)
    return out


def prune_stale_watchlist(wl: dict[str, Any], *, now_ms: int | None = None) -> int:
    """过期 KOL→币 链接移出 watchlist；龙头保留（龙头直通）。返回删除数。"""
    symbols: dict[str, Any] = wl.setdefault("symbols", {})
    removed = 0
    for sym in list(symbols):
        entry = symbols[sym] if isinstance(symbols[sym], dict) else {}
        fresh = fresh_sources(entry, now_ms=now_ms)
        leader = bool(entry.get("leader") or is_leader_symbol(sym))
        if not fresh and not leader:
            del symbols[sym]
            removed += 1
            continue
        if len(fresh) != len(entry.get("sources") or []):
            entry["sources"] = fresh
    return removed


def kol_label(entry: Mapping[str, Any] | None, symbol: str, *, now_ms: int | None = None) -> str:
    """仅列新鲜提及的 KOL：『Nine Call（10/19提及）』，多 KOL 用 / 连接；龙头无新鲜提及 → 龙头直通。"""
    fresh = fresh_sources(entry, now_ms=now_ms)
    latest: dict[str, str] = {}
    for s in fresh:
        latest[str(s.get("kol_name") or "未知")] = mention_date_label(s.get("mentioned_at"))
    names = sorted(latest, key=lambda n: -max(parse_mention_ms(x.get("mentioned_at")) or 0 for x in fresh if str(x.get("kol_name") or "未知") == n))[:3]
    parts = [f"{n}（{latest[n]}提及）" if latest[n] else n for n in names]
    leader = bool((entry or {}).get("leader") or is_leader_symbol(symbol))
    if leader:
        parts = ["龙头直通"] + parts
    return "/".join(parts)


def upsert_watchlist_from_card(
    wl: dict[str, Any],
    card: Mapping[str, Any],
    *,
    followed_ids: set[str],
    follow_all: bool = False,
) -> bool:
    """若频道已关注或龙头直通，写入/更新 watchlist。返回是否写入。"""
    sym = normalize_watch_symbol(str(card.get("symbol") or ""))
    if not sym:
        return False
    channel_id = str(card.get("channel_id") or "")
    leader = is_leader_symbol(sym)
    if not leader and not follow_all and channel_id not in followed_ids:
        return False
    raw_text = str(card.get("raw_text") or "")
    if not mention_is_genuine(sym, raw_text):
        logger.info("ticker 误匹配跳过 card=%s sym=%s", card.get("id"), sym)
        return False

    symbols: dict[str, Any] = wl.setdefault("symbols", {})
    entry = symbols.get(sym) or {
        "symbol": sym,
        "sources": [],
        "leader": leader,
        "first_seen_at": card.get("mentioned_at") or datetime.now(timezone.utc).isoformat(),
    }
    entry["leader"] = bool(entry.get("leader") or leader)
    entry["symbol"] = sym
    sources = entry.setdefault("sources", [])
    kol_name = channel_display_name(channel_id) if channel_id else "未知"
    if leader and channel_id not in followed_ids:
        # 龙头直通仍记录提及者
        pass
    src = {
        "kol_name": kol_name,
        "channel_id": channel_id,
        "mentioned_at": card.get("mentioned_at") or datetime.now(timezone.utc).isoformat(),
        "card_id": card.get("id"),
        "genuine": True,
        "snippet": raw_text[:120],
    }
    # dedupe same channel recent
    if not any(
        str(s.get("channel_id")) == channel_id and str(s.get("mentioned_at")) == str(src["mentioned_at"])
        for s in sources
        if isinstance(s, dict)
    ):
        sources.append(src)
        # keep last 20 sources
        entry["sources"] = sources[-20:]
    entry["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    symbols[sym] = entry
    return True


def load_cursor() -> dict[str, Any]:
    return load_json(data_dir() / "cursor.json", {"last_card_id": 0})


def save_cursor(cur: dict[str, Any]) -> None:
    save_json(data_dir() / "cursor.json", cur)


def load_seen() -> dict[str, Any]:
    return load_json(data_dir() / "seen_alerts.json", {"seen": {}})


def save_seen(state: dict[str, Any]) -> None:
    save_json(data_dir() / "seen_alerts.json", state)


def alert_key(symbol: str, tf: str, pattern: str, bar_ts: int | float) -> str:
    return f"{symbol}|{tf}|{pattern}|{int(bar_ts)}"


def _vol_sma(bars: Sequence[Mapping[str, Any]], end_idx: int, lookback: int) -> float:
    """end_idx 之前 lookback 根（不含 end_idx）的均量。"""
    start = max(0, end_idx - lookback)
    window = bars[start:end_idx]
    if not window:
        return 0.0
    return sum(float(b.get("volume") or 0) for b in window) / len(window)


def abnormal_volume(
    bars: Sequence[Mapping[str, Any]],
    index: int,
    *,
    lookback: int = 20,
    mult: float = 2.0,
) -> dict[str, Any]:
    """当根或前根相对均量异常放量。"""
    if index < 1 or index >= len(bars):
        return {"yes": False, "which": "none", "ratio": 0.0, "prior_ratio": 0.0, "current_ratio": 0.0}
    sma_cur = _vol_sma(bars, index, lookback)
    sma_prior = _vol_sma(bars, index - 1, lookback)
    cur_v = float(bars[index].get("volume") or 0)
    prior_v = float(bars[index - 1].get("volume") or 0)
    cur_ratio = (cur_v / sma_cur) if sma_cur > 0 else 0.0
    prior_ratio = (prior_v / sma_prior) if sma_prior > 0 else 0.0
    cur_abn = sma_cur > 0 and cur_ratio >= mult
    prior_abn = sma_prior > 0 and prior_ratio >= mult
    if cur_abn and prior_abn:
        which = "both"
    elif cur_abn:
        which = "current"
    elif prior_abn:
        which = "prior"
    else:
        which = "none"
    return {
        "yes": which != "none",
        "which": which,
        "ratio": round(max(cur_ratio, prior_ratio), 3),
        "current_ratio": round(cur_ratio, 3),
        "prior_ratio": round(prior_ratio, 3),
        "mult": mult,
        "lookback": lookback,
    }


def ema_series(closes: Sequence[float], period: int) -> list[float | None]:
    if period <= 0 or not closes:
        return [None] * len(closes)
    k = 2.0 / (period + 1)
    out: list[float | None] = [None] * len(closes)
    # seed with SMA of first period
    if len(closes) < period:
        return out
    seed = sum(closes[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, len(closes)):
        prev = closes[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def ema144_near_pct(*, leader: bool = False) -> float:
    """EMA144 门控阈值 %：KOL_EMA144_NEAR_PCT（兼容旧 KOL_EMA_NEAR_PCT），默认 1.5。
    龙头可单独 KOL_EMA144_NEAR_PCT_LEADER，未设则同规则。"""
    base = env_str("KOL_EMA144_NEAR_PCT", "") or env_str("KOL_EMA_NEAR_PCT", "") or "1.5"
    if leader:
        base = env_str("KOL_EMA144_NEAR_PCT_LEADER", "") or base
    try:
        v = float(base)
    except ValueError:
        v = 1.5
    return min(max(v, 0.05), 20.0)


def ema144_gate(bar: Mapping[str, Any], ema: float | None, *, near_pct: float) -> dict[str, Any]:
    """硬门控：形态柱 high-low 触及/穿越 EMA144，或收盘距 EMA144 ≤ near_pct%。"""
    if ema is None or ema <= 0:
        return {"pass": False, "touch": False, "distance_pct": None, "reason": "ema_unavailable"}
    hi = float(bar.get("high") or 0)
    lo = float(bar.get("low") or 0)
    close = float(bar.get("close") or 0)
    dist = (close / ema - 1.0) * 100.0
    touch = lo <= ema <= hi
    ok = touch or abs(dist) <= near_pct
    return {
        "pass": ok,
        "touch": touch,
        "distance_pct": round(dist, 3),
        "near_pct": near_pct,
        "reason": "touch" if touch else ("near" if ok else "far"),
    }


def build_alert_text(alert: Mapping[str, Any]) -> str:
    """最终可直接转发的中文一行文案。"""
    side = str(alert.get("side") or "").lower()
    side_zh = {"long": "多", "short": "空"}.get(side, "")
    pat = str(alert.get("pattern_zh") or alert.get("pattern") or "")
    if side_zh:
        pat = f"{pat}（{side_zh}）"
    e = alert.get("ema144") or {}
    d = e.get("distance_pct")
    if e.get("touch"):
        ema_s = f"触及EMA144（{abs(d):.1f}%）" if d is not None else "触及EMA144"
    else:
        ema_s = f"贴近EMA144（{abs(d):.1f}%）" if d is not None else "贴近EMA144"
    who = alert.get("kol_label") or alert.get("kol_name") or "未知"
    parts = [f"{who} · {alert.get('symbol')} · {pat}", ema_s]
    v = alert.get("abnormal_volume") or {}
    if v.get("yes"):
        parts.append(f"放量{float(v.get('ratio') or 0):.1f}x")
    return f"KOL二次预警｜{alert.get('tf') or '15m'}｜" + " · ".join(parts)


def append_filtered_log(rec: Mapping[str, Any]) -> None:
    path = data_dir() / "filtered.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(dict(rec), ensure_ascii=False) + "\n")


def ema144_position(
    bars: Sequence[Mapping[str, Any]],
    index: int,
    *,
    period: int = 144,
    near_pct: float = 1.5,
) -> dict[str, Any]:
    closes = [float(b.get("close") or 0) for b in bars]
    emas = ema_series(closes, period)
    if index < 0 or index >= len(bars) or emas[index] is None:
        return {"side": "未知", "distance_pct": None, "ema": None, "price": None}
    price = closes[index]
    ema = float(emas[index])  # type: ignore[arg-type]
    if ema <= 0:
        return {"side": "未知", "distance_pct": None, "ema": ema, "price": price}
    dist = (price / ema - 1.0) * 100.0
    if abs(dist) <= near_pct:
        side = "附近"
    elif dist > 0:
        side = "上方"
    else:
        side = "下方"
    return {
        "side": side,
        "distance_pct": round(dist, 3),
        "ema": round(ema, 6),
        "price": price,
        "near_pct": near_pct,
        "period": period,
    }


async def fetch_klines_async(symbol: str, interval: str, limit: int) -> list[list[Any]]:
    from oi_mornitor.http_session import make_http_session
    from oi_mornitor.pattern_monitor import fetch_pattern_klines
    from oi_mornitor.config import proxy_url

    # 国内直连交易所会被 RST；与 oi_mornitor 主进程一致走 HTTPS_PROXY
    px = proxy_url()
    session = make_http_session(trust_env=False, default_proxy=px)
    try:
        return await fetch_pattern_klines(
            session,
            base_url=FAPI_BASE_URL,
            symbol=symbol,
            interval=interval,
            limit=limit,
        )
    finally:
        if not session.closed:
            await session.close()


def fetch_klines_sync(symbol: str, interval: str, limit: int) -> list[list[Any]]:
    return asyncio.run(fetch_klines_async(symbol, interval, limit))


def evaluate_symbol(
    symbol: str,
    *,
    tf: str | None = None,
    patterns: frozenset[str] | None = None,
    entry: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """对 watchlist 币做形态+放量+EMA144；返回待告警列表（未做 dedupe）。"""
    tf = (tf or env_str("KOL_ALERT_TF", "15m")).lower()
    allow = patterns if patterns is not None else follow_patterns()
    # 禁止 hammer
    allow = frozenset(p for p in allow if p not in {"hammer", "大锤子"})
    vol_lb = env_int("KOL_VOL_LOOKBACK", 20, min_val=5, max_val=200)
    vol_mult = env_float("KOL_VOL_MULT", 2.0, min_val=0.5, max_val=20.0)
    ema_period = env_int("KOL_EMA_PERIOD", 144, min_val=5, max_val=500)
    near_pct = ema144_near_pct()
    limit = max(ema_period + vol_lb + 20, env_int("KOL_KLINE_LIMIT", 200, min_val=50, max_val=1500))

    try:
        rows = fetch_klines_sync(symbol, tf, limit)
    except Exception as exc:
        logger.warning("K线拉取失败 %s %s: %s", symbol, tf, exc)
        return []
    bars = bars_from_ohlcv_rows(rows)
    if len(bars) < max(30, ema_period // 2):
        return []

    # 默认只看已收盘最后一根（倒数第二：末根可能未收完）
    include_forming = env_str("KOL_ALERT_INCLUDE_FORMING", "0").strip() in ("1", "true", "yes")
    indices = []
    if len(bars) >= 2:
        indices.append(len(bars) - 2)
    if include_forming:
        indices.append(len(bars) - 1)
    # unique preserve order
    seen_i: set[int] = set()
    ordered: list[int] = []
    for i in indices:
        if i not in seen_i and i >= 1:
            seen_i.add(i)
            ordered.append(i)

    alerts: list[dict[str, Any]] = []
    sources = fresh_sources(entry)
    leader = bool((entry or {}).get("leader") or is_leader_symbol(symbol))
    if not sources and not leader:
        return []  # KOL 提及已过期 → 不列出、不告警
    primary_kol = kol_label(entry, symbol)
    last_mention = sources[-1].get("mentioned_at") if sources else None

    for idx in ordered:
        hits = scan_patterns_on_bar(bars, idx, allowed=allow)
        if not hits:
            continue
        vol = abnormal_volume(bars, idx, lookback=vol_lb, mult=vol_mult)
        g_pct = ema144_near_pct(leader=leader)
        ema = ema144_position(bars, idx, period=ema_period, near_pct=g_pct)
        gate = ema144_gate(bars[idx], ema.get("ema"), near_pct=g_pct)
        bar_ts = int(float(bars[idx].get("open_time") or 0))
        for hit in hits:
            kind = str(hit.get("kind") or "")
            if kind in {"hammer", "大锤子"}:
                continue
            if not gate["pass"]:
                try:
                    append_filtered_log({
                        "status": "filtered_far_from_ema",
                        "symbol": symbol, "tf": tf, "pattern": kind, "side": hit.get("side"),
                        "bar_ts": bar_ts, "leader": leader, "kol_name": primary_kol or "未知",
                        "ema144": ema.get("ema"), "distance_pct": gate["distance_pct"],
                        "near_pct": g_pct, "reason": gate["reason"],
                        "logged_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    })
                except Exception as exc:
                    logger.warning("filtered log fail: %s", exc)
                continue
            alert = (
                {
                    "type": "kol_secondary_alert",
                    "kol_name": primary_kol or "未知",
                    "symbol": symbol,
                    "pattern": kind,
                    "pattern_zh": PATTERN_ZH.get(kind, kind),
                    "side": hit.get("side"),
                    "abnormal_volume": {
                        "yes": vol["yes"],
                        "which": vol["which"],
                        "ratio": vol["ratio"],
                        "current_ratio": vol.get("current_ratio"),
                        "prior_ratio": vol.get("prior_ratio"),
                    },
                    "ema144": {
                        "side": ema["side"],
                        "distance_pct": gate["distance_pct"],
                        "touch": gate["touch"],
                        "near_pct": g_pct,
                        "value": ema.get("ema"),
                    },
                    "ema_gate": gate["reason"],
                    "tf": tf,
                    "bar_ts": bar_ts,
                    "leader": leader,
                    "kol_label": primary_kol,
                    "mentioned_at": last_mention,
                    "mention_max_age_hours": mention_max_age_hours(),
                    "sources": [{k: v for k, v in x.items() if k != "snippet"} for x in sources[-5:]],
                    "detected_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
            )
            alert["timeframe"] = tf
            alert["text"] = build_alert_text(alert)
            alerts.append(alert)
    return alerts


def append_alert_log(alert: Mapping[str, Any]) -> None:
    path = data_dir() / "alerts.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(dict(alert), ensure_ascii=False) + "\n")


def post_webhook(url: str, key: str, payload: dict[str, Any]) -> None:
    import urllib.error
    import urllib.request

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        r.read()


def webhook_endpoints() -> list[tuple[str, str]]:
    """主/备 Grok webhook（URL+KEY 与 URL_2+KEY_2）。"""
    out: list[tuple[str, str]] = []
    for url_key, sec_key in (
        ("KOL_GROK_WEBHOOK_URL", "KOL_GROK_WEBHOOK_KEY"),
        ("KOL_GROK_WEBHOOK_URL_2", "KOL_GROK_WEBHOOK_KEY_2"),
    ):
        u = env_str(url_key, "").strip()
        k = env_str(sec_key, "").strip()
        if u and k:
            out.append((u, k))
    return out


def post_webhooks(payload: dict[str, Any]) -> None:
    eps = webhook_endpoints()
    last_exc: Exception | None = None
    for url, key in eps:
        try:
            post_webhook(url, key, payload)
        except Exception as exc:
            last_exc = exc
            logger.warning("KOL webhook POST fail %s: %s", url[:48], exc)
    if last_exc and len(eps) == 1:
        raise last_exc


def load_lifecycle_state() -> dict[str, Any]:
    raw = load_json(data_dir() / "signal_lifecycle.json", {"signals": {}})
    if "signals" not in raw or not isinstance(raw.get("signals"), dict):
        raw["signals"] = {}
    return raw


def save_lifecycle_state(state: dict[str, Any]) -> None:
    save_json(data_dir() / "signal_lifecycle.json", state)


def lifecycle_terminal_keys(state: dict[str, Any] | None = None) -> set[str]:
    st = state if state is not None else load_lifecycle_state()
    from oi_mornitor.kol_signal_lifecycle import is_terminal_status

    out: set[str] = set()
    for key, rec in (st.get("signals") or {}).items():
        if isinstance(rec, dict) and is_terminal_status(str(rec.get("status") or "")):
            out.add(str(key))
    return out


def register_lifecycle_signal(alert: Mapping[str, Any], *, fired_at_ms: int | float | None = None) -> dict[str, Any]:
    from oi_mornitor.kol_signal_lifecycle import enrich_alert_lifecycle, new_lifecycle_record

    enriched = enrich_alert_lifecycle(alert, fired_at_ms=fired_at_ms)
    rec = new_lifecycle_record(enriched, fired_at_ms=fired_at_ms)
    st = load_lifecycle_state()
    signals: dict[str, Any] = st.setdefault("signals", {})
    signals[str(rec["dedupe_key"])] = rec
    save_lifecycle_state(st)
    return enriched


def advance_active_lifecycle(*, now_ms: int | float | None = None) -> list[dict[str, Any]]:
    """刷新所有未终态信号；返回本轮新产生的 lifecycle 事件（仅本地日志）。"""
    from oi_mornitor.kol_signal_lifecycle import (
        advance_lifecycle_record,
        bars_for_lifecycle,
        is_terminal_status,
    )

    st = load_lifecycle_state()
    signals: dict[str, Any] = st.setdefault("signals", {})
    events: list[dict[str, Any]] = []
    now = int(now_ms if now_ms is not None else time.time() * 1000)

    by_fetch: dict[tuple[str, str], list[str]] = {}
    for key, rec in list(signals.items()):
        if not isinstance(rec, dict) or is_terminal_status(str(rec.get("status") or "")):
            continue
        sym = str(rec.get("symbol") or "")
        tf = str(rec.get("tf") or env_str("KOL_ALERT_TF", "15m")).lower()
        by_fetch.setdefault((sym, tf), []).append(str(key))

    kline_cache: dict[tuple[str, str], list[dict[str, float]]] = {}
    ema_period = env_int("KOL_EMA_PERIOD", 144, min_val=5, max_val=500)
    vol_lb = env_int("KOL_VOL_LOOKBACK", 20, min_val=5, max_val=200)
    limit = max(ema_period + vol_lb + 20, env_int("KOL_KLINE_LIMIT", 200, min_val=50, max_val=1500))

    for (sym, tf), _keys in by_fetch.items():
        try:
            rows = fetch_klines_sync(sym, tf, limit)
            kline_cache[(sym, tf)] = bars_for_lifecycle(rows)
        except Exception as exc:
            logger.warning("lifecycle klines %s %s: %s", sym, tf, exc)

    changed = False
    for key, rec in list(signals.items()):
        if not isinstance(rec, dict) or is_terminal_status(str(rec.get("status") or "")):
            continue
        sym = str(rec.get("symbol") or "")
        tf = str(rec.get("tf") or "15m").lower()
        bars = kline_cache.get((sym, tf))
        if not bars:
            continue
        updated, ev = advance_lifecycle_record(rec, bars, now_ms=now)
        if updated != rec:
            signals[key] = updated
            changed = True
        if ev:
            events.append(ev)
            append_alert_log(ev)

    if changed:
        st["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        save_lifecycle_state(st)
    return events


def ingest_new_cards(
    *,
    follow_all: bool | None = None,
) -> dict[str, Any]:
    """轮询增量卡片 → 更新 watchlist + cursor。"""
    if follow_all is None:
        follow_all = env_str("KOL_FOLLOW_ALL_RECENT", "0").strip() in ("1", "true", "yes")
    kols = seed_followed_kols(force=False)
    followed = active_followed_ids(kols)
    cur = load_cursor()
    after = int(cur.get("last_card_id") or 0)
    # 首次：若 cursor=0，从最近 N 条回填，避免全表
    bootstrap = after <= 0
    cards = pull_recent_cards(
        after_id=after,
        limit=env_int("KOL_CARD_BATCH", 300, min_val=10, max_val=2000),
        bootstrap_recent=bootstrap,
    )
    wl = load_watchlist()
    pruned = prune_stale_watchlist(wl)
    added = 0
    max_id = after
    for card in cards:
        max_id = max(max_id, int(card["id"]))
        if upsert_watchlist_from_card(wl, card, followed_ids=followed, follow_all=follow_all):
            added += 1
    if max_id > after:
        cur["last_card_id"] = max_id
        cur["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        save_cursor(cur)
    if added or pruned:
        save_watchlist(wl)
    else:
        # still persist empty symbols structure on first run
        if not (data_dir() / "watchlist.json").is_file():
            save_watchlist(wl)
    return {
        "cards_seen": len(cards),
        "watch_upserts": added,
        "watch_size": len(wl.get("symbols") or {}),
        "last_card_id": cur.get("last_card_id"),
        "followed": len(followed),
        "pruned_stale": pruned,
    }


def _watch_scan_targets(symbols: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """优先龙头 + 最近更新；限制单轮扫描量。"""
    max_n = env_int("KOL_WATCH_SCAN_MAX", 30, min_val=5, max_val=200)
    items: list[tuple[str, dict[str, Any]]] = []
    for sym, entry in symbols.items():
        if isinstance(entry, dict):
            items.append((str(sym), entry))
    leaders = [(s, e) for s, e in items if e.get("leader") or is_leader_symbol(s)]
    others = [(s, e) for s, e in items if not (e.get("leader") or is_leader_symbol(s))]
    others.sort(key=lambda x: str(x[1].get("updated_at") or ""), reverse=True)
    ordered = leaders + others
    # dedupe
    seen: set[str] = set()
    out: list[tuple[str, dict[str, Any]]] = []
    for s, e in ordered:
        if s in seen:
            continue
        seen.add(s)
        out.append((s, e))
        if len(out) >= max_n:
            break
    return out


def scan_watchlist_alerts() -> list[dict[str, Any]]:
    wl = load_watchlist()
    if prune_stale_watchlist(wl):
        save_watchlist(wl)
    symbols = wl.get("symbols") or {}
    out: list[dict[str, Any]] = []
    for sym, entry in _watch_scan_targets(symbols if isinstance(symbols, dict) else {}):
        try:
            out.extend(evaluate_symbol(sym, entry=entry))
        except Exception as exc:
            logger.warning("evaluate %s failed: %s", sym, exc)
    return out


__all__ = [
    "fresh_sources",
    "kol_label",
    "mention_is_genuine",
    "prune_stale_watchlist",
    "build_alert_text",
    "ema144_gate",
    "ema144_near_pct",
    "PATTERN_ZH",
    "abnormal_volume",
    "active_followed_ids",
    "alert_key",
    "append_alert_log",
    "channel_display_name",
    "data_dir",
    "ema144_position",
    "evaluate_symbol",
    "follow_patterns",
    "ingest_new_cards",
    "is_leader_symbol",
    "load_cursor",
    "load_lifecycle_state",
    "load_seen",
    "load_watchlist",
    "lifecycle_terminal_keys",
    "normalize_watch_symbol",
    "advance_active_lifecycle",
    "post_webhook",
    "post_webhooks",
    "pull_recent_cards",
    "register_lifecycle_signal",
    "webhook_endpoints",
    "save_cursor",
    "save_seen",
    "save_watchlist",
    "scan_watchlist_alerts",
    "seed_followed_kols",
    "upsert_watchlist_from_card",
]
