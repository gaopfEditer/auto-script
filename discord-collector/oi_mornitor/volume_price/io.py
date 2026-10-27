"""K 线 CSV / DataFrame 加载与列规范化。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

_REQUIRED = ("ts", "symbol", "tf", "open", "high", "low", "close", "volume")
_OPTIONAL = ("oi",)


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    rename = {c: c.strip().lower() for c in df.columns}
    out = df.rename(columns=rename).copy()
    missing = [c for c in _REQUIRED if c not in out.columns]
    if missing:
        raise ValueError(f"缺少列: {missing}")
    if "oi" not in out.columns:
        out["oi"] = pd.NA
    for col in _REQUIRED + ("oi",):
        if col in ("ts", "symbol", "tf"):
            continue
        out[col] = pd.to_numeric(out[col], errors="coerce")
    out["symbol"] = out["symbol"].astype(str).str.upper()
    out["tf"] = out["tf"].astype(str).str.lower()
    out["ts"] = pd.to_numeric(out["ts"], errors="coerce").astype("Int64")
    out = out.dropna(subset=["ts", "open", "high", "low", "close", "volume"])
    out["ts"] = out["ts"].astype("int64")
    out = out.sort_values(["symbol", "tf", "ts"]).reset_index(drop=True)
    return out


def load_klines(source: str | Path | pd.DataFrame) -> pd.DataFrame:
    """读取 CSV 或规范化已有 DataFrame。"""
    if isinstance(source, pd.DataFrame):
        return _normalize_columns(source)
    path = Path(source)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    df = pd.read_csv(path)
    return _normalize_columns(df)


def split_by_tf(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    out: dict[str, pd.DataFrame] = {}
    for tf, chunk in df.groupby("tf", sort=False):
        out[str(tf)] = chunk.reset_index(drop=True)
    return out
