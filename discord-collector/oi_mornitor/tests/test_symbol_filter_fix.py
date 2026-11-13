"""测试币种筛选修复：VVV被排除、ETH通过、USD/USDT归一化。"""
import os
import unittest
from unittest.mock import patch


class TestSymbolFilterFix(unittest.TestCase):
    """币种筛选修复回归测试。"""

    def test_candle_card_policy_未配置时回退到main白名单(self):
        """修复：未配置 LONG/OTHER 时应回退到 MAIN_CARD_DEFAULT_SYMBOLS，不放行全市场。"""
        with patch.dict(
            os.environ,
            {
                "OI_MAIN_CARD_DEFAULT_SYMBOLS": "BTCUSDT,ETHUSDT",
                "OI_MAIN_CARD_LONG_SYMBOLS": "",
                "OI_MAIN_CARD_OTHER_SYMBOLS": "",
            },
            clear=False,
        ):
            # 清除模块缓存
            import sys
            for key in list(sys.modules.keys()):
                if key.startswith("oi_mornitor"):
                    sys.modules.pop(key, None)
            
            from oi_mornitor.candle_card_policy import is_candle_card_push_symbol

            # BTC/ETH 在 DEFAULT 中，应通过
            self.assertTrue(is_candle_card_push_symbol("BTCUSDT"))
            self.assertTrue(is_candle_card_push_symbol("ETHUSDT"))
            
            # VVV 不在 DEFAULT 中，应被拦截（修复前会返回 True）
            self.assertFalse(is_candle_card_push_symbol("VVVUSDT"))

    def test_candle_card_policy_配置other时仅推送名单内(self):
        """配置 OTHER_SYMBOLS 时，仅推送名单内币种。"""
        with patch.dict(
            os.environ,
            {
                "OI_MAIN_CARD_DEFAULT_SYMBOLS": "BTCUSDT,ETHUSDT",
                "OI_MAIN_CARD_LONG_SYMBOLS": "",
                "OI_MAIN_CARD_OTHER_SYMBOLS": "VVVUSDT",
            },
            clear=False,
        ):
            import sys
            for key in list(sys.modules.keys()):
                if key.startswith("oi_mornitor"):
                    sys.modules.pop(key, None)
            
            from oi_mornitor.candle_card_policy import is_candle_card_push_symbol

            # VVV 在 OTHER 中，应通过形态群
            self.assertTrue(is_candle_card_push_symbol("VVVUSDT"))
            
            # BTC 不在 OTHER 中（但在 DEFAULT 中），应被形态群拦截
            self.assertFalse(is_candle_card_push_symbol("BTCUSDT"))

    def test_main_card_policy_usd_usdt_归一化(self):
        """测试 USD/USDT 别名归一化。"""
        with patch.dict(
            os.environ,
            {
                "OI_MAIN_CARD_DEFAULT_SYMBOLS": "BTCUSDT,ETHUSDT",
            },
            clear=False,
        ):
            import sys
            for key in list(sys.modules.keys()):
                if key.startswith("oi_mornitor"):
                    sys.modules.pop(key, None)
            
            from oi_mornitor.main_card_policy import is_main_card_symbol

            # USDT 后缀
            self.assertTrue(is_main_card_symbol("BTCUSDT"))
            self.assertTrue(is_main_card_symbol("ETHUSDT"))
            
            # USD 后缀应归一化为 USDT（修复：确保别名识别）
            self.assertTrue(is_main_card_symbol("BTCUSD"))
            self.assertTrue(is_main_card_symbol("ETHUSD"))
            
            # 非白名单币种
            self.assertFalse(is_main_card_symbol("VVVUSDT"))
            self.assertFalse(is_main_card_symbol("VVVUSD"))

    def test_main_card_policy_配置解析(self):
        """测试 MAIN_CARD_DEFAULT_SYMBOLS 配置解析。"""
        with patch.dict(
            os.environ,
            {
                "OI_MAIN_CARD_DEFAULT_SYMBOLS": "BTCUSDT,ETHUSDT,QQQUSDT,SUIUSDT",
            },
            clear=False,
        ):
            import sys
            for key in list(sys.modules.keys()):
                if key.startswith("oi_mornitor"):
                    sys.modules.pop(key, None)
            
            from oi_mornitor.main_card_policy import is_main_card_symbol

            # 用户配置的四币种
            self.assertTrue(is_main_card_symbol("BTCUSDT"))
            self.assertTrue(is_main_card_symbol("ETHUSDT"))
            self.assertTrue(is_main_card_symbol("QQQUSDT"))
            self.assertTrue(is_main_card_symbol("SUIUSDT"))
            
            # 非配置币种
            self.assertFalse(is_main_card_symbol("VVVUSDT"))
            self.assertFalse(is_main_card_symbol("SOLUSDT"))

    def test_focus_symbols_归一化(self):
        """测试 focus_symbols 的归一化逻辑。"""
        from oi_mornitor.focus_symbols import normalize_focus_symbol

        # USD → USDT
        self.assertEqual(normalize_focus_symbol("BTCUSD"), "BTCUSDT")
        self.assertEqual(normalize_focus_symbol("ETHUSD"), "ETHUSDT")
        
        # 已带 USDT
        self.assertEqual(normalize_focus_symbol("BTCUSDT"), "BTCUSDT")
        
        # 无后缀自动补 USDT
        self.assertEqual(normalize_focus_symbol("BTC"), "BTCUSDT")
        self.assertEqual(normalize_focus_symbol("ETH"), "ETHUSDT")
        
        # 大小写归一化
        self.assertEqual(normalize_focus_symbol("btcusdt"), "BTCUSDT")
        self.assertEqual(normalize_focus_symbol("ethusd"), "ETHUSDT")

    def test_confluence_tier_门槛(self):
        """测试共振档位门槛：B 档及以上通过，C 档被观察。"""
        from oi_mornitor.signal_confluence import passes_confluence_push_gate

        # A 档通过
        self.assertTrue(passes_confluence_push_gate({"tier": "A", "score": 85}))
        
        # B 档通过
        self.assertTrue(passes_confluence_push_gate({"tier": "B", "score": 65}))
        
        # C 档被拦截（修复：确保 C 档进入观察，不推送）
        self.assertFalse(passes_confluence_push_gate({"tier": "C", "score": 50}))
        
        # D 档被拦截
        self.assertFalse(passes_confluence_push_gate({"tier": "D", "score": 30}))

    def test_send_main_card_telegram_白名单检查(self):
        """测试 send_main_card_telegram 的显式白名单检查。"""
        with patch.dict(
            os.environ,
            {
                "OI_MAIN_CARD_DEFAULT_SYMBOLS": "BTCUSDT,ETHUSDT",
                "MAIN_CARD_TELEGRAM_CHAT_ID": "-1003860925903",
            },
            clear=False,
        ):
            import sys
            for key in list(sys.modules.keys()):
                if key.startswith("oi_mornitor"):
                    sys.modules.pop(key, None)
            
            from unittest.mock import MagicMock, patch as patch_func
            
            with patch_func("oi_mornitor.notify_telegram.is_main_push_enabled", return_value=True):
                with patch_func("oi_mornitor.notify_telegram.is_main_card_mirror_eligible", return_value=True):
                    with patch_func("oi_mornitor.notify_telegram._confluence_gate_or_observation", return_value=True):
                        with patch_func("oi_mornitor.notify_telegram._send_card_text_with_fallback", return_value=True):
                            with patch_func("oi_mornitor.notify_telegram._after_candle_card_pushed"):
                                from oi_mornitor.notify_telegram import send_main_card_telegram
                                
                                # ETH 在白名单中，应尝试推送
                                result = send_main_card_telegram({"symbol": "ETHUSDT"})
                                self.assertTrue(result)
                                
                                # VVV 不在白名单中，应在白名单检查时早期返回（修复验证）
                                result = send_main_card_telegram({"symbol": "VVVUSDT"})
                                self.assertFalse(result)


if __name__ == "__main__":
    unittest.main()
