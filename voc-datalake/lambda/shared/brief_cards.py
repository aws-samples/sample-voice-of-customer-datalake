"""The card contract shared by the morning brief and every card provider.

A provider is a plain function ``(BriefContext) -> list[BriefCard]``. Facts
(counts, deltas, ids) are computed in code; a provider never calls a model —
the brief worker writes the words for the cards it keeps. Providers must be
best-effort: the worker drops a provider that raises and keeps the rest.

Card ids are stable for the same fact on the same day (``card_id``), so the
per-user card state (seen / dismissed / acted) survives a refresh.
"""
from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from shared.category_access import CategoryScope

Severity = Literal['info', 'warn', 'alert']
CardLayer = Literal['org', 'personal']

SEVERITIES: tuple[Severity, ...] = ('info', 'warn', 'alert')
MAX_ACTIONS = 3
MAX_EVIDENCE_IDS = 10


@dataclass(frozen=True)
class BriefContext:
    """What a provider may read. ``scope`` is the reader group's category scope."""

    feedback_table: Any
    aggregates_table: Any
    scope: CategoryScope
    now: datetime
    language: str = 'en'
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CardAction:
    """A button: opens the assistant with ``prompt`` prefilled (never auto-sent)."""

    label: str
    prompt: str


@dataclass(frozen=True)
class BriefCard:
    id: str
    kind: str
    layer: CardLayer
    severity: Severity
    title: str
    facts: dict[str, Any] = field(default_factory=dict)
    body: str = ''
    actions: tuple[CardAction, ...] = ()
    feedback_ids: tuple[str, ...] = ()
    urls: tuple[str, ...] = ()

    def to_item(self) -> dict[str, Any]:
        """The stored / wire shape (DynamoDB-safe: no floats are added here)."""
        return {
            'id': self.id,
            'kind': self.kind,
            'layer': self.layer,
            'severity': self.severity,
            'title': self.title,
            'facts': dict(self.facts),
            'body': self.body,
            'actions': [{'label': a.label, 'prompt': a.prompt} for a in self.actions[:MAX_ACTIONS]],
            'feedback_ids': list(self.feedback_ids[:MAX_EVIDENCE_IDS]),
            'urls': list(self.urls[:MAX_EVIDENCE_IDS]),
        }


CardProvider = Callable[[BriefContext], list[BriefCard]]


def card_id(kind: str, day: str, *parts: str) -> str:
    """``{kind}_{16 hex}`` — the same fact on the same day keeps the same id."""
    digest = hashlib.sha256('\x1f'.join((kind, day, *parts)).encode('utf-8')).hexdigest()[:16]
    return f'{kind}_{digest}'
