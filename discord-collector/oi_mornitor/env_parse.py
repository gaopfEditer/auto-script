"""环境变量读取：空字符串与非法值回退到代码默认，避免 import 时崩溃或误用 0/NaN。"""
from __future__ import annotations

import os


def env_raw(key: str) -> str | None:
    v = os.environ.get(key)
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


def env_str(key: str, default: str) -> str:
    v = env_raw(key)
    return default if v is None else v


def env_int(
    key: str,
    default: int,
    *,
    min_val: int | None = None,
    max_val: int | None = None,
) -> int:
    v = env_raw(key)
    if v is None:
        n = default
    else:
        try:
            n = int(v)
        except ValueError:
            try:
                n = int(float(v))
            except ValueError:
                n = default
    if min_val is not None:
        n = max(min_val, n)
    if max_val is not None:
        n = min(max_val, n)
    return n


def env_float(
    key: str,
    default: float,
    *,
    min_val: float | None = None,
    max_val: float | None = None,
) -> float:
    v = env_raw(key)
    if v is None:
        n = default
    else:
        try:
            n = float(v)
        except ValueError:
            n = default
        if not (n == n):  # NaN
            n = default
    if min_val is not None:
        n = max(min_val, n)
    if max_val is not None:
        n = min(max_val, n)
    return n


def env_bool(key: str, default: bool) -> bool:
    v = env_raw(key)
    if v is None:
        return default
    low = v.lower()
    if low in ("1", "true", "yes", "on"):
        return True
    if low in ("0", "false", "no", "off"):
        return False
    return default


def env_bool_off(key: str, default_on: bool = True) -> bool:
    """默认开：仅 0/false/no 显式关闭。"""
    v = env_raw(key)
    if v is None:
        return default_on
    return v.lower() not in ("0", "false", "no", "off")
