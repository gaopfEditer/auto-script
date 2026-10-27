"""ezcoin-adapter 硬门禁 + 5 席 LLM 裁决桥接（方案1 第二审判）。

约定（adapter 侧需对齐，路径见 OI_EZCOIN_ADAPTER_JUDGE_PATH）:
  POST {base}{path}
  body: { "snapshot": { ... } }
  200 JSON: { "gate_result": "pass"|"reject", "action": "LONG"|"SHORT"|"WATCH"|"NO_TRADE", ... }
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from oi_mornitor.config import (
    OI_EZCOIN_ADAPTER_BASE_URL,
    OI_EZCOIN_ADAPTER_JUDGE_PATH,
    OI_EZCOIN_ADAPTER_TIMEOUT_SEC,
)
from oi_mornitor.mcap_tier import resolve_mcap_tier
from oi_mornitor.symbol_aliases import human_base_asset, normalize_usdt_symbol

logger = logging.getLogger(__name__)


@dataclass
class AdapterJudgeResult:
    ok: bool
    gate_result: str = "unavailable"
    action: str = ""
    confidence: float | None = None
    rationale: str = ""
    error: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "gate_result": self.gate_result,
            "action": self.action,
            "confidence": self.confidence,
            "rationale": self.rationale,
            "error": self.error,
        }


def _side_hint_from_alert(alert: dict[str, Any]) -> str:
    side = str(alert.get("side") or "").lower()
    if side in ("bull", "long"):
        return "long"
    if side in ("bear", "short"):
        return "short"
    return ""


def build_ezcoin_snapshot(
    alert: dict[str, Any],
    *,
    radar_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """把形态/OI/共振因子打包为 adapter 可消费的 snapshot（不含密钥）。"""
    sym = normalize_usdt_symbol(str(alert.get("symbol") or ""))
    base = human_base_asset(sym) or sym
    iv = str(alert.get("interval") or "").strip()
    entry = alert.get("price") or alert.get("close") or alert.get("entry_hint")
    snap: dict[str, Any] = {
        "symbol": sym,
        "base": base,
        "interval": iv,
        "side_hint": _side_hint_from_alert(alert),
        "kind": str(alert.get("kind") or alert.get("signal_kind") or ""),
        "type_label": str(
            alert.get("type_label") or alert.get("pattern_label") or alert.get("signal_text") or ""
        ),
        "alert_type": str(alert.get("type") or ""),
        "mcap_tier": resolve_mcap_tier(sym),
        "entry": entry,
        "kline_close_time": alert.get("kline_close_time") or alert.get("time"),
        "confluence": alert.get("confluence"),
        "vol_ratio": alert.get("vol_ratio"),
        "trend_pct": alert.get("trend_pct"),
        "invalid_level": alert.get("invalid_level") or alert.get("invalidLevel"),
        "ema144": alert.get("ema144"),
        "capital_flow": alert.get("capitalFlow"),
    }
    if isinstance(radar_snapshot, dict):
        hot = radar_snapshot.get("hot_tickers") or []
        if isinstance(hot, list):
            row = next(
                (
                    x
                    for x in hot
                    if isinstance(x, dict)
                    and normalize_usdt_symbol(str(x.get("symbol") or "")) == sym
                ),
                None,
            )
            if row:
                snap["oi_hot"] = {
                    "type": row.get("type"),
                    "pct_5m": row.get("pct_5m"),
                    "pct_15m": row.get("pct_15m"),
                    "delta_5m_usd": row.get("delta_5m_usd"),
                    "oi_tier": row.get("oi_tier"),
                }
        meta = radar_snapshot.get("meta")
        if isinstance(meta, dict):
            snap["market_meta"] = {
                "risk_regime": meta.get("risk_regime"),
                "long_short_bias": meta.get("long_short_bias"),
            }
    return snap


def call_adapter_judge(
    snapshot: dict[str, Any],
    *,
    base_url: str | None = None,
    path: str | None = None,
    timeout_sec: float | None = None,
) -> AdapterJudgeResult:
    """调用 ezcoin-adapter；网络/解析失败时 gate=unavailable，不假装过审。"""
    base = (base_url or OI_EZCOIN_ADAPTER_BASE_URL).rstrip("/")
    judge_path = path or OI_EZCOIN_ADAPTER_JUDGE_PATH
    if not judge_path.startswith("/"):
        judge_path = f"/{judge_path}"
    url = f"{base}{judge_path}"
    timeout = float(timeout_sec if timeout_sec is not None else OI_EZCOIN_ADAPTER_TIMEOUT_SEC)
    body = json.dumps({"snapshot": snapshot}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw_text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        logger.warning("ezcoin adapter HTTP %s: %s", exc.code, url)
        return AdapterJudgeResult(ok=False, gate_result="unavailable", error=f"http_{exc.code}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("ezcoin adapter 不可达 %s: %s", url, exc)
        return AdapterJudgeResult(ok=False, gate_result="unavailable", error=str(exc))

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        return AdapterJudgeResult(ok=False, gate_result="unavailable", error="invalid_json")

    if not isinstance(payload, dict):
        return AdapterJudgeResult(ok=False, gate_result="unavailable", error="invalid_body")

    gate = str(
        payload.get("gate_result") or payload.get("gate") or payload.get("gateStatus") or ""
    ).strip().lower()
    if not gate and payload.get("ok") is False:
        gate = "reject"
    if not gate:
        gate = "unavailable"

    action = str(payload.get("action") or payload.get("decision") or "").strip().upper()
    conf = payload.get("confidence")
    try:
        confidence = float(conf) if conf is not None else None
    except (TypeError, ValueError):
        confidence = None
    rationale = str(payload.get("rationale") or payload.get("reason") or "").strip()
    return AdapterJudgeResult(
        ok=gate == "pass" and bool(action),
        gate_result=gate,
        action=action,
        confidence=confidence,
        rationale=rationale,
        raw=payload,
    )


def build_btc_probe_snapshot() -> dict[str, Any]:
    """AI 回测探针用最小 BTC 快照（不依赖实时扫描）。"""
    return {
        "symbol": "BTCUSDT",
        "base": "BTC",
        "interval": "15m",
        "side_hint": "long",
        "kind": "probe",
        "type_label": "AI回测探针",
        "alert_type": "ai_judge_probe",
        "mcap_tier": "t1",
        "entry": None,
        "probe": True,
        "ts": int(time.time() * 1000),
    }
