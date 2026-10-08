"""Typed reads of loosely shaped records (DynamoDB rows, crewmate results, events).

``value.get(key) if isinstance(value.get(key), dict) else {}`` is the house idiom for
"this field, if it is really a mapping". A type checker cannot narrow a repeated call,
so the idiom lives here once, with a return type the callers can rely on. The value is
returned as-is (same object) when it has the right shape, else a fresh empty one.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def dict_field(source: Mapping[str, Any], key: str) -> dict[str, Any]:
    """``source[key]`` when it is a dict, else ``{}``."""
    value = source.get(key)
    return value if isinstance(value, dict) else {}


def list_field(source: Mapping[str, Any], key: str) -> list[Any]:
    """``source[key]`` when it is a list, else ``[]``."""
    value = source.get(key)
    return value if isinstance(value, list) else []
