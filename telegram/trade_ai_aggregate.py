"""调用 Ollama 从滑动窗口消息中提取并聚合交易信息。"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any

from config import (
    get_ollama_generate_timeout_sec,
    get_ollama_generate_url,
    get_ollama_model,
    ollama_trade_aggregate_enabled,
)
from trade_context_buffer import WindowMessage

SYSTEM = """你是 Telegram 群聊交易信息整理器。输入为按时间排序的群消息（含闲聊）。
任务：忽略无关闲聊，把分散在多行里的**交易相关信息**按**币种**聚合成便于扫读的摘要。

需要提取的字段（有则填，无则空字符串）：
- symbol：如 ETH、BTC、SOL
- direction：多/空/未知
- entry：入场/建仓/市价/挂单
- exit：平仓/出局
- stop_loss：止损/芷損
- take_profit：止盈/芷楹/目标价
- adjust：仅调整止盈止损/芷楹/保本/减仓等（无新开仓）

规则：
- 同一币种多行碎片合并为一条 symbol 记录
- 纯闲聊、表情包、直播预告、晒单无关价位 → 不写入 symbols
- 若整段窗口无任何交易信息，hasTradeInfo=false

只输出一行合法 JSON，不要 markdown：
{"hasTradeInfo":true,"overview":"一句总览≤40字","symbols":[{"symbol":"ETH","direction":"空","entry":"2178市价","stop_loss":"2300","take_profit":"2018/1788","adjust":"","source_indexes":[1,3,5]}],"source_indexes":[1,3,5]}

hasTradeInfo=false 时：{"hasTradeInfo":false,"overview":"","symbols":[],"source_indexes":[]}"""


def _build_prompt(chat_title: str, messages: list[WindowMessage]) -> str:
    lines = [SYSTEM, "", f"【群聊】{chat_title or '未知'}", f"【共 {len(messages)} 条，编号从 1 开始】", ""]
    for i, m in enumerate(messages, start=1):
        lines.append(m.line_for_prompt(i))
    lines.append("")
    lines.append("只输出一个 JSON：")
    return "\n".join(lines)


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    t = (raw or "").strip()
    if not t:
        return None
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", t, re.I)
    if fence:
        t = fence.group(1).strip()
    brace = re.search(r"\{[\s\S]*\}", t)
    if brace:
        t = brace.group(0)
    try:
        o = json.loads(t)
        return o if isinstance(o, dict) else None
    except json.JSONDecodeError:
        return None


def _norm_symbol_row(row: Any) -> dict[str, Any]:
    if not isinstance(row, dict):
        return {}
    idx = row.get("source_indexes") or row.get("indexes") or []
    if not isinstance(idx, list):
        idx = []
    return {
        "symbol": str(row.get("symbol") or "").strip().upper(),
        "direction": str(row.get("direction") or "").strip(),
        "entry": str(row.get("entry") or "").strip(),
        "exit": str(row.get("exit") or "").strip(),
        "stop_loss": str(row.get("stop_loss") or row.get("stopLoss") or "").strip(),
        "take_profit": str(row.get("take_profit") or row.get("takeProfit") or "").strip(),
        "adjust": str(row.get("adjust") or "").strip(),
        "source_indexes": [int(x) for x in idx if str(x).isdigit()],
    }


def parse_aggregate_response(raw: str) -> dict[str, Any] | None:
    o = _extract_json_object(raw)
    if not o:
        return None
    has = o.get("hasTradeInfo") is True or o.get("hasTradeInfo") == "true"
    symbols_in = o.get("symbols")
    symbols: list[dict[str, Any]] = []
    if isinstance(symbols_in, list):
        for row in symbols_in:
            s = _norm_symbol_row(row)
            if s.get("symbol") or s.get("entry") or s.get("adjust"):
                symbols.append(s)
    src = o.get("source_indexes") or []
    if not isinstance(src, list):
        src = []
    source_indexes = [int(x) for x in src if str(x).isdigit()]
    overview = str(o.get("overview") or "").strip()
    return {
        "hasTradeInfo": bool(has and (symbols or overview)),
        "overview": overview,
        "symbols": symbols,
        "source_indexes": source_indexes,
    }


def format_aggregate_telegram(
    chat_title: str,
    result: dict[str, Any],
    messages: list[WindowMessage],
) -> str:
    overview = str(result.get("overview") or "").strip()
    symbols: list[dict[str, Any]] = result.get("symbols") or []
    lines: list[str] = []
    head = f"📊 {chat_title or '群聊'} · 交易摘要"
    if overview:
        head = f"{head}\n{overview}"
    lines.append(head)

    for s in symbols:
        sym = s.get("symbol") or "?"
        parts = [sym]
        if s.get("direction"):
            parts.append(str(s["direction"]))
        detail: list[str] = []
        if s.get("entry"):
            detail.append(f"入场 {s['entry']}")
        if s.get("stop_loss"):
            detail.append(f"止损 {s['stop_loss']}")
        if s.get("take_profit"):
            detail.append(f"止盈 {s['take_profit']}")
        if s.get("exit"):
            detail.append(f"出场 {s['exit']}")
        if s.get("adjust"):
            detail.append(f"调整 {s['adjust']}")
        line = " | ".join(parts)
        if detail:
            line = f"{line} — {' · '.join(detail)}"
        lines.append(line)

    idx_set: set[int] = set()
    for s in symbols:
        for i in s.get("source_indexes") or []:
            idx_set.add(int(i))
    for i in result.get("source_indexes") or []:
        idx_set.add(int(i))
    if idx_set and messages:
        refs = []
        for i in sorted(idx_set):
            if 1 <= i <= len(messages):
                refs.append(f"#{messages[i - 1].msg_id}")
        if refs:
            lines.append("—")
            lines.append("依据: " + ", ".join(refs[:12]))

    return "\n".join(lines)


def call_ollama_generate(prompt: str) -> str:
    if not ollama_trade_aggregate_enabled():
        raise RuntimeError("TELEGRAM_AI_TRADE_AGGREGATE 未启用")
    url = get_ollama_generate_url()
    model = get_ollama_model()
    body = json.dumps({"model": model, "prompt": prompt, "stream": False}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    timeout = get_ollama_generate_timeout_sec()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(str(data["error"]))
    return str(data.get("response") or "")


def aggregate_window_messages(
    chat_title: str,
    messages: list[WindowMessage],
) -> dict[str, Any] | None:
    if not messages:
        return None
    has_text = any((m.text or "").strip() for m in messages)
    if not has_text:
        return {"hasTradeInfo": False, "overview": "", "symbols": [], "source_indexes": []}
    prompt = _build_prompt(chat_title, messages)
    raw = call_ollama_generate(prompt)
    parsed = parse_aggregate_response(raw)
    if parsed is None:
        raise RuntimeError(f"Ollama JSON 解析失败: {raw[:200]!r}")
    return parsed
