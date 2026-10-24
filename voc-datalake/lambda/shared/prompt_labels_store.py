"""``load_prompt_labels``: the category config and source profiles a prompt's labels come from.

Kept apart from ``shared.prompt_labels`` (pure) because ``shared.api`` imports ``shared.feedback``,
which formats prompts with those labels. Best effort and never raises (``shared.prompt_labels``).
"""
from __future__ import annotations

import os
from typing import Any

from shared.api import get_raw_categories_config
from shared.aws import get_dynamodb_resource
from shared.logging import logger
from shared.prompt_labels import PromptLabels
from shared.source_profiles import load_source_profiles

__all__ = ['load_prompt_labels']


def _aggregates_table(aggregates_table: Any) -> Any:
    if aggregates_table is not None:
        return aggregates_table
    table_name = os.environ.get('AGGREGATES_TABLE', '')
    return get_dynamodb_resource().Table(table_name) if table_name else None


def load_prompt_labels(aggregates_table: Any = None) -> PromptLabels:
    """The labels from ``aggregates_table`` (else ``AGGREGATES_TABLE``); humanised ids when unreadable. Never raises.

    Two item reads at most: the category config (5-minute cache) and the source profiles row.
    """
    try:
        table = _aggregates_table(aggregates_table)
        if table is None:
            return PromptLabels()
        return PromptLabels(categories=tuple(get_raw_categories_config(table) or ()),
                            profiles=tuple(load_source_profiles(table)))
    except Exception:
        # A label lookup must never fail a generation: the humanised ids are still names.
        logger.exception('Prompt labels unavailable; using humanised ids')
        return PromptLabels()
