"""短线回测基础设施 V2。

第一阶段只修正执行与记账，不改信号规则，也不改出场状态机参数。
V1 代码与历史交易记录保留作基准。
"""

__all__ = ["run_on_frames_v2", "merge_symbol_results_v2", "run_backtest_engine_v2"]


def __getattr__(name: str):
    if name in ("run_on_frames_v2", "merge_symbol_results_v2"):
        from oi_mornitor.backtest_engine_v2.engine import merge_symbol_results_v2, run_on_frames_v2
        return run_on_frames_v2 if name == "run_on_frames_v2" else merge_symbol_results_v2
    if name == "run_backtest_engine_v2":
        from oi_mornitor.backtest_engine_v2.runner import run_backtest_engine_v2
        return run_backtest_engine_v2
    raise AttributeError(name)
