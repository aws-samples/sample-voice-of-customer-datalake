"""The Bedrock list prices the cost estimate uses, dated (docs/multi-workspace.md, "Cost per workspace").

One ``PriceList``: when it was read (``as_of``), where (``source_url``, the public Amazon Bedrock pricing page), on
what basis (``basis``: the region and tier), and the prices, keyed by the model id as sent (the ``bedrock_usage``
line's ``model_id``, shared/usage_meter.py), then by service tier, in USD per million tokens (``Decimal``, never a
float). A figure comes only from that page, read on ``as_of``; never from memory. A model whose figures could not be
read is in ``unpriced`` with the reason: its tokens are still counted, and its cost is ``None`` (the day it is used in
is then incomplete), never a guess.

As of 2026-11-14 the page could not be fetched from the build session (the fetch was refused), so every allowlisted
model is unpriced for that reason and every estimate is ``None`` until the page is read and the figures recorded
here with its date.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from types import MappingProxyType
from typing import Final

from shared.model_config import ALLOWED_MODEL_IDS

#: Tokens per priced unit: every price here is per million tokens (a page figure per 1,000 is recorded x 1,000).
TOKENS_PER_UNIT: Final = Decimal(1_000_000)
#: The usage line's token fields, by the price that applies to each.
TOKEN_FIELDS: Final = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens')


@dataclass(frozen=True)
class TokenPrices:
    """One model's prices on one tier, in USD per million tokens."""

    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write: Decimal

    def per_field(self) -> dict[str, Decimal]:
        """The price of each of the usage line's token fields."""
        return dict(zip(TOKEN_FIELDS, (self.input, self.output, self.cache_read, self.cache_write), strict=True))


@dataclass(frozen=True)
class PriceList:
    """The prices read from ``source_url`` on ``as_of``, on ``basis``; ``unpriced``: model id to why it has none."""

    as_of: str
    source_url: str
    basis: str
    prices: Mapping[str, Mapping[str, TokenPrices]] = field(default_factory=dict)
    unpriced: Mapping[str, str] = field(default_factory=dict)


_UNFETCHED: Final = 'the pricing page could not be fetched on 2026-11-14 (the fetch was refused in the build session)'

PRICE_LIST: Final = PriceList(
    as_of='2026-11-14',
    source_url='https://aws.amazon.com/bedrock/pricing/',
    basis='US East (N. Virginia), standard on-demand tier, USD per million tokens',
    prices=MappingProxyType({}),
    unpriced=MappingProxyType(dict.fromkeys(sorted(ALLOWED_MODEL_IDS), _UNFETCHED)),
)


def estimated_usd(model_id: str, service_tier: str, tokens: Mapping[str, int],
                  price_list: PriceList = PRICE_LIST) -> Decimal | None:
    """The list-price cost of ``tokens`` (the usage line's token fields; a missing one is 0) of ``model_id`` on
    ``service_tier``, in USD; ``None`` for a model or tier the list has no price for."""
    prices = price_list.prices.get(model_id, {}).get(service_tier)
    if prices is None:
        return None
    return sum((Decimal(tokens.get(name, 0)) * price / TOKENS_PER_UNIT for name, price in prices.per_field().items()),
               Decimal(0))
