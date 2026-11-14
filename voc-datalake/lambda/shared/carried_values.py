"""Checks of values carried between invocations (export hand-overs, Step Functions payloads): the workspace
export's run state (jobs/workspace_export/handler.py ``RunState``, conversations.py), the generation an unclaimable
export event names (shared/export_jobs.py ``awaits_generation``) and the feedback usage a research step hands the
next (research/research_step_handler.py). One place for "a count", "a flag", "a mapping or none" and "a key or
none", so every reader refuses the same shapes; each raises ValueError (only ValueError) naming the field."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeGuard

__all__ = ['count_of', 'flag_or', 'is_count', 'key_or_none', 'mapping_or_empty']


def flag_or(value: object, name: str, default: bool) -> bool:
    """``value`` when it is a bool; ``default`` when it is None (the one None rule: an absent field, or one carried
    as null, is the default); ValueError ``'{name} is not a flag'`` for anything else."""
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ValueError(f'{name} is not a flag')
    return value


def is_count(value: object) -> TypeGuard[int]:
    """Whether ``value`` is a non-negative int (never a bool, which Python counts as an int)."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def count_of(value: object, name: str) -> int:
    """``value`` when it is a count (``is_count``); ValueError ``'{name} is not a count'`` otherwise."""
    if not is_count(value):
        raise ValueError(f'{name} is not a count')
    return value


def mapping_or_empty(value: object, name: str) -> Mapping[str, Any]:
    """``value`` when it is a mapping, ``{}`` for None; ValueError ``'{name} is not a mapping'`` otherwise."""
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError(f'{name} is not a mapping')
    return value


def key_or_none(value: object, name: str, attributes: tuple[str, ...] = ('pk', 'sk')) -> dict[str, str] | None:
    """``value`` as a table key of exactly ``attributes``, each a non-empty string, or None; ValueError ``'{name} is
    not a key'`` for anything else."""
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != set(attributes) or not all(
            isinstance(value[attribute], str) and value[attribute] for attribute in attributes):
        raise ValueError(f'{name} is not a key')
    return {attribute: str(value[attribute]) for attribute in attributes}
