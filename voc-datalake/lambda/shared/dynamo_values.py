"""DynamoDB values as JSON-safe Python.

``plain`` turns what boto3 reads (Decimal numbers, string/number sets) into
values ``json.dumps`` and the Lambda runtime accept: a whole Decimal becomes an
int, any other a float; a set becomes a sorted list; every mapping key a str.
``shared.api.decimal_default`` (Decimal → always float) is a different rule on
purpose and stays separate.

The small readers below take one stored (or JSON) value as its type, or a neutral value when it is not: a count, a
text, a trimmed text, a non-empty text, a mapping, a list of strings, a pattern's match.
"""
import re
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


def json_count(value: object) -> int:
    """A count as JSON holds it: a non-negative int (never a bool); 0 for anything else."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def as_text(item: Mapping[str, Any], field: str) -> str:
    """A stored item's string attribute; '' when it is missing or not a string."""
    value = item.get(field)
    return value if isinstance(value, str) else ''


def mapping_or_empty(value: object) -> Mapping[str, Any]:
    """A stored value as a mapping; {} when it is not one."""
    return value if isinstance(value, Mapping) else {}


def string_list(value: object) -> list[str]:
    """A stored list's string members, in order; [] when it is not a list."""
    return [member for member in value if isinstance(member, str)] if isinstance(value, list) else []


def matches_text(value: object, pattern: re.Pattern[str]) -> bool:
    """Whether a stored value is a string that ``pattern`` matches at its start (``re.match``)."""
    return isinstance(value, str) and pattern.match(value) is not None


def text_or_none(value: object) -> str | None:
    """A stored value as a non-empty string; None when it is missing, empty or not a string."""
    return value if isinstance(value, str) and value else None


def trimmed_text(item: Mapping[str, Any], field: str) -> str:
    """A mapping's string ``field``, trimmed; '' when it is missing or not a string."""
    value = item.get(field)
    return value.strip() if isinstance(value, str) else ''


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
