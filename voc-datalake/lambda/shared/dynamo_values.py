"""DynamoDB values as JSON-safe Python.

``plain`` turns what boto3 reads (Decimal numbers, string/number sets) into
values ``json.dumps`` and the Lambda runtime accept: a whole Decimal becomes an
int, any other a float; a set becomes a sorted list; every mapping key a str.
``shared.api.decimal_default`` (Decimal → always float) is a different rule on
purpose and stays separate.
"""
from collections.abc import Mapping
from decimal import Decimal
from typing import Any


def _sorted_members(members: list[Any]) -> list[Any]:
    """A set's members in a stable order (natural order; insertion order when not comparable)."""
    try:
        return sorted(members)
    except TypeError:
        return members


def item_key(item: Mapping[str, Any]) -> dict[str, str]:
    """The ``{pk, sk}`` key of a stored item (as strings)."""
    return {'pk': str(item['pk']), 'sk': str(item['sk'])}


def as_count(value: object) -> int:
    """A stored counter as an int (DynamoDB hands back a Decimal); 0 for anything that is not a number."""
    return int(value) if isinstance(value, int | Decimal) and not isinstance(value, bool) else 0


def plain(value: Any) -> Any:
    """``value`` with every Decimal, set, tuple and mapping made JSON-safe, recursively."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, Mapping):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [plain(v) for v in value]
    if isinstance(value, set | frozenset):
        return _sorted_members([plain(v) for v in value])
    return value
