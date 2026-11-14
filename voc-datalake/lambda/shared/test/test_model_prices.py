"""shared/model_prices.py: the dated list prices of the cost estimate, and tokens to USD."""
from decimal import Decimal

import pytest

from shared.model_config import ALLOWED_MODELS
from shared.model_prices import PRICE_LIST, PriceList, TokenPrices, estimated_usd

UNPRICED = PRICE_LIST.unpriced
FICTIONAL = 'global.example.fictional-model'
LIST = PriceList(
    as_of='2026-01-01', source_url='https://example.com/prices', basis='a fictional basis',
    prices={FICTIONAL: {'default': TokenPrices(input=Decimal('3'), output=Decimal('15'),
                                               cache_read=Decimal('0.3'), cache_write=Decimal('3.75'))}},
)


@pytest.mark.parametrize('model_id', [m['id'] for m in ALLOWED_MODELS])
def test_every_allowed_model_is_priced_or_unpriced_with_a_reason(model_id):
    priced = model_id in PRICE_LIST.prices and PRICE_LIST.prices[model_id]
    reason = UNPRICED.get(model_id, '')
    assert bool(priced) != bool(reason.strip()), 'priced, or unpriced with a reason, never both or neither'


def test_the_list_is_dated_and_sourced():
    assert PRICE_LIST.as_of == '2026-11-14'
    assert PRICE_LIST.source_url == 'https://aws.amazon.com/bedrock/pricing/'
    assert 'US East' in PRICE_LIST.basis
    assert 'on-demand' in PRICE_LIST.basis


def test_every_price_is_a_non_negative_decimal():
    for tiers in PRICE_LIST.prices.values():
        for prices in tiers.values():
            assert all(isinstance(p, Decimal) and p >= 0 for p in prices.per_field().values())


def test_tokens_to_usd_per_million():
    tokens = {'input_tokens': 1_000_000, 'output_tokens': 200_000, 'cache_read_tokens': 500_000,
              'cache_write_tokens': 40_000}
    assert estimated_usd(FICTIONAL, 'default', tokens, LIST) == Decimal('3') + Decimal('3') + Decimal('0.15') + \
        Decimal('0.15')


def test_a_missing_token_field_counts_zero():
    assert estimated_usd(FICTIONAL, 'default', {'output_tokens': 1}, LIST) == Decimal('0.000015')


def test_an_unknown_model_or_tier_has_no_price():
    assert estimated_usd('global.example.unknown', 'default', {'input_tokens': 5}, LIST) is None
    assert estimated_usd(FICTIONAL, 'flex', {'input_tokens': 5}, LIST) is None


def test_an_unpriced_model_has_no_price_on_the_real_list():
    for model_id in UNPRICED:
        assert estimated_usd(model_id, 'default', {'input_tokens': 5}) is None
