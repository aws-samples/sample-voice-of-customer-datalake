"""The Bedrock list prices the cost estimate uses, dated (docs/multi-workspace.md, "Cost per workspace").

One ``PriceList``: when it was read (``as_of``), where (``source_url``, the public Amazon Bedrock pricing page whose
figures the AWS Price List API publishes), on what basis (``basis``: how it was read, the inference profile and the
tier), and the prices, keyed by the model id as sent (the ``bedrock_usage`` line's ``model_id``,
shared/usage_meter.py), then by service tier, in USD per million tokens (``Decimal``, never a float). A figure comes
only from that source, read on ``as_of``; never from memory. A model whose figures were not read is in ``unpriced``
with the reason: its tokens are still counted, and its cost is ``None`` (the day it is used in is then incomplete),
never a guess.

Since 7.79.00 the three models whose figures were read on 2026-11-16 from the AWS Price List API (the engineering
agents' cost caps' read, engineering/runtime/caps.py ``DEFAULT_TOKEN_PRICES``, held equal by
shared/test/test_model_prices.py) are priced on the standard tier: Haiku 5.5, Sonnet 5.5 and Opus 5.5. The other
allowlisted models are unpriced until their figures are read and recorded here with the date. A deployment that
calls a model through another inference profile (an ``eu.`` id as sent in an EU deployment) has no price for it
either: its cost reads unpriced, never the global profile's figure.

The deployment's own models (``-c customModels``, shared/custom_models.py, 7.65.00) carry their price in the registry,
required at synth: ``price.in`` per million input tokens, ``price.out`` per million output tokens, on every tier (the
cache reads and writes at the input price, the registry naming no cache price). A custom model is never unpriced.
An imported one's figure is only an estimate (``is_estimate``, 7.66.00): Custom Model Import bills the Custom Model
Units of each copy for every 5-minute window it is active (and their storage by the month), not the token, so its
registry price is the operator's own conversion and its cost line is ``complete: false``.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from types import MappingProxyType
from typing import Final

from shared.custom_models import custom_model
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


#: Read on 2026-11-16 from the AWS Price List API (pricing:GetProducts, read only; service code
#: AmazonBedrockFoundationModels, regionCode us-west-2, the *_global_standard usage types for input, output, cache read
#: and cache write tokens; published 2026-11-09T22:43:12Z), USD per million tokens. LOCKSTEP with
#: engineering/runtime/caps.py DEFAULT_TOKEN_PRICES (the same read).
_READ_PRICES: Final = {
    'global.anthropic.claude-haiku-5-5': TokenPrices(Decimal('0.10'), Decimal('0.50'), Decimal('0.01'), Decimal('0.125')),
    'global.anthropic.claude-sonnet-5-5': TokenPrices(Decimal('2.00'), Decimal('10.00'), Decimal('0.10'),
                                                      Decimal('2.50')),
    'global.anthropic.claude-opus-5-5': TokenPrices(Decimal('4.00'), Decimal('20.00'), Decimal('0.20'), Decimal('5.00')),
}
#: The service tier the read figures are for (the ``bedrock_usage`` line's ``default``: no flex tier is sent).
_STANDARD_TIER: Final = 'default'
_NOT_READ: Final = 'its figures were not read from the AWS Price List API with the others on 2026-11-16'

PRICE_LIST: Final = PriceList(
    as_of='2026-11-16',
    source_url='https://aws.amazon.com/bedrock/pricing/',
    basis=('read from the AWS Price List API: the global (cross-region) inference profiles, standard tier '
           '(regionCode us-west-2, applied to the global profile from any source region), USD per million tokens'),
    prices=MappingProxyType({model_id: MappingProxyType({_STANDARD_TIER: prices})
                             for model_id, prices in _READ_PRICES.items()}),
    unpriced=MappingProxyType(dict.fromkeys(sorted(set(ALLOWED_MODEL_IDS) - set(_READ_PRICES)), _NOT_READ)),
)


def custom_prices(model_id: str) -> TokenPrices | None:
    """A custom model's registry price (the same on every tier), None for any other model."""
    custom = custom_model(model_id)
    if custom is None:
        return None
    return TokenPrices(input=custom.price_in, output=custom.price_out, cache_read=custom.price_in,
                       cache_write=custom.price_in)


def is_estimate(model_id: str) -> bool:
    """Whether ``model_id``'s figure is only the registry's estimate: an imported model's (Custom Model Import bills
    by the model's active copies, not the token: the module docstring)."""
    custom = custom_model(model_id)
    return custom is not None and custom.source == 'imported'


def estimated_usd(model_id: str, service_tier: str, tokens: Mapping[str, int],
                  price_list: PriceList = PRICE_LIST) -> Decimal | None:
    """The list-price cost of ``tokens`` (the usage line's token fields; a missing one is 0) of ``model_id`` on
    ``service_tier``, in USD; ``None`` for a model or tier the list has no price for. A custom model is priced from
    the registry (``custom_prices``)."""
    prices = price_list.prices.get(model_id, {}).get(service_tier) or custom_prices(model_id)
    if prices is None:
        return None
    return sum((Decimal(tokens.get(name, 0)) * price / TOKENS_PER_UNIT for name, price in prices.per_field().items()),
               Decimal(0))
