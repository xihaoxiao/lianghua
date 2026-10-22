"""测试实时行情的多源降级与降级标注

背景（真实故障）：
    GitHub Actions runner（境外 IP）上 akshare 的东财接口被限流，
    实时行情返回空/非 JSON，导致盘中推送静默退化成"盘后"推送，
    用户在 13:15 收到的却是盘后数据。

覆盖场景：
    - 东财源可用时直接使用
    - 东财源失败时自动降级到新浪源（这是修复的核心）
    - 新浪源的代码前缀（sh600000）被正确剥掉
    - 新浪源的成交量单位（股）被换算成"手"（与缓存日线一致）
    - 全部源失败时返回空字典（不抛异常）
    - 降级时推送标题/正文显式标注，不装作盘中推送
"""

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from classic_ta.common import stock_pool
from classic_ta.common.message_builder import build_beta_push_message, build_push_message
from classic_ta.common.stock_pool import (
    _get_spot_df,
    _get_spot_df_em,
    _get_spot_df_sina,
    _normalize_spot_code,
    get_realtime_quotes,
)

# ──────────────────────────────────────────────────────────
#  样本数据
# ──────────────────────────────────────────────────────────

EM_DF = pd.DataFrame(
    {
        "代码": ["600000", "000001"],
        "名称": ["浦发银行", "平安银行"],
        "最新价": [9.63, 11.31],
        "今开": [9.66, 11.41],
        "最高": [9.70, 11.42],
        "最低": [9.55, 11.26],
        "昨收": [9.66, 11.41],
        "成交量": [410000.43, 1053674.72],      # 东财单位：手
        "成交额": [394714699.0, 1192231536.0],
        "涨跌幅": [-0.31, -0.88],
        "换手率": [0.14, 0.55],
        "量比": [1.02, 0.98],
    }
)

SINA_DF = pd.DataFrame(
    {
        "代码": ["sh600000", "sz000001"],      # 新浪带市场前缀
        "名称": ["浦发银行", "平安银行"],
        "最新价": [9.63, 11.31],
        "今开": [9.66, 11.41],
        "最高": [9.70, 11.42],
        "最低": [9.55, 11.26],
        "昨收": [9.66, 11.41],
        "成交量": [41000043.0, 105367472.0],    # 新浪单位：股
        "成交额": [394714699.0, 1192231536.0],
        "涨跌幅": [-0.31, -0.88],
        "换手率": [0.14, 0.55],
        "量比": [1.02, 0.98],
    }
)


def _pad(df, code_col, prefix, total=120):
    """补齐到生产量级（>100 行），真实接口只会返回 5000+ 行。

    prefix 决定代码形态：东财是 6 位裸代码，新浪是 8 位带前缀。
    """
    extra_rows = []
    for i in range(total - len(df)):
        extra_rows.append({
            code_col: f"{prefix}{i:04d}",
            "名称": f"测试股{i}",
            "最新价": 10.0, "今开": 10.0, "最高": 10.5, "最低": 9.5, "昨收": 10.0,
            "成交量": 1000.0, "成交额": 10000.0, "涨跌幅": 0.0,
            "换手率": 0.1, "量比": 1.0,
        })
    return pd.concat([df, pd.DataFrame(extra_rows)], ignore_index=True)


@pytest.fixture
def fake_akshare(monkeypatch):
    """伪造 akshare 模块：可控制东财/新浪两个源各自的成败。"""
    import types

    state = {"em_ok": True, "sina_ok": True, "em_calls": 0, "sina_calls": 0}

    def spot_em():
        state["em_calls"] += 1
        if not state["em_ok"]:
            raise RuntimeError("Expecting value: line 1 column 1 (char 0)")
        return _pad(EM_DF.copy(), "代码", "61")

    def spot_sina():
        state["sina_calls"] += 1
        if not state["sina_ok"]:
            raise RuntimeError("新浪源也不可用")
        return _pad(SINA_DF.copy(), "代码", "sh61")

    module = types.ModuleType("akshare")
    module.stock_zh_a_spot_em = spot_em
    module.stock_zh_a_spot = spot_sina
    monkeypatch.setitem(sys.modules, "akshare", module)
    return state


# ──────────────────────────────────────────────────────────
#  代码归一化
# ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("sh600000", "600000"),
    ("sz000001", "000001"),
    ("bj920000", "920000"),
    ("600000", "600000"),
])
def test_normalize_spot_code(raw, expected):
    assert _normalize_spot_code(raw) == expected


# ──────────────────────────────────────────────────────────
#  数据源降级链
# ──────────────────────────────────────────────────────────

def test_em_source_used_when_available(fake_akshare):
    df = _get_spot_df()
    assert df is not None
    assert fake_akshare["em_calls"] == 1
    assert fake_akshare["sina_calls"] == 0


def test_falls_back_to_sina_when_em_fails(fake_akshare):
    """核心场景：东财被限流时必须自动切到新浪，而不是返回空。"""
    fake_akshare["em_ok"] = False

    df = _get_spot_df()
    assert df is not None, "东财失败时应降级到新浪源"
    assert fake_akshare["em_calls"] == 1
    assert fake_akshare["sina_calls"] == 1
    assert len(df) == 120


def test_returns_none_when_all_sources_fail(fake_akshare):
    fake_akshare["em_ok"] = False
    fake_akshare["sina_ok"] = False

    assert _get_spot_df() is None
    assert _get_spot_df_em() is None
    assert _get_spot_df_sina() is None


def test_sina_source_strips_market_prefix(fake_akshare):
    fake_akshare["em_ok"] = False

    df = _get_spot_df_sina()
    assert list(df["代码"][:2]) == ["600000", "000001"]


def test_sina_source_converts_volume_shares_to_lots(fake_akshare):
    """新浪成交量单位是「股」，缓存日线用「手」，必须换算（否则量能差 100 倍）。"""
    fake_akshare["em_ok"] = False

    df = _get_spot_df_sina()
    assert df["成交量"].iloc[0] == pytest.approx(410000.43)
    assert df["成交量"].iloc[1] == pytest.approx(1053674.72)


def test_volume_units_match_between_sources(fake_akshare):
    """两个源的成交量换算后必须一致，否则盘中 K 线量能会错。"""
    em = _get_spot_df_em()
    fake_akshare["em_ok"] = False
    sina = _get_spot_df_sina()

    assert em["成交量"].iloc[0] == pytest.approx(sina["成交量"].iloc[0])
    assert em["成交额"].iloc[0] == pytest.approx(sina["成交额"].iloc[0])


# ──────────────────────────────────────────────────────────
#  实时行情
# ──────────────────────────────────────────────────────────

def test_get_realtime_quotes_uses_sina_fallback(fake_akshare):
    fake_akshare["em_ok"] = False

    quotes = get_realtime_quotes()
    assert len(quotes) == 120
    assert "600000.SH" in quotes
    assert "000001.SZ" in quotes

    q = quotes["600000.SH"]
    assert q["Close"] == pytest.approx(9.63)
    assert q["Open"] == pytest.approx(9.66)
    assert q["High"] == pytest.approx(9.70)
    assert q["Low"] == pytest.approx(9.55)
    assert q["PrevClose"] == pytest.approx(9.66)
    # 成交量已从「股」换算成「手」
    assert q["Volume"] == pytest.approx(410000.43)


def test_get_realtime_quotes_empty_when_all_fail(fake_akshare):
    fake_akshare["em_ok"] = False
    fake_akshare["sina_ok"] = False

    assert get_realtime_quotes() == {}


def test_prefilter_uses_sina_fallback(fake_akshare):
    fake_akshare["em_ok"] = False

    df = stock_pool.batch_prefilter_stocks()
    assert df is not None, "预筛选也必须能降级，否则会退化成全市场扫描"
    assert len(df) == 120
    assert list(df["ts_code"][:2]) == ["600000.SH", "000001.SZ"]


# ──────────────────────────────────────────────────────────
#  降级标注
# ──────────────────────────────────────────────────────────

def test_degraded_push_message_is_marked():
    title, desp = build_push_message(None, [], [], {}, is_intraday=False, degraded=True)

    assert "降级" in title
    assert "实时行情" in desp
    assert "勿当作盘中实时信号" in desp


def test_normal_push_message_not_marked():
    title, desp = build_push_message(None, [], [], {}, is_intraday=True, degraded=False)

    assert "降级" not in title
    assert "盘中实时" in title


def test_beta_degraded_push_message_is_marked():
    title, _ = build_beta_push_message(None, [], [], {}, is_intraday=False, degraded=True)
    assert "降级" in title
