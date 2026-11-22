"""The leadership view's rows and its time-saved baselines (7.70.00, idea 8; docs/leadership-view.md).

Two kinds of row, both in voc-aggregates, both per scope (the deployment's, and each workspace's under ``WS#{ws}#``):

* the rollup (gold, rebuildable): ``ADOPTION#ROLLUP`` / ``{YYYY-MM-DD}``, ``WS#{ws}#ADOPTION#ROLLUP`` / ``{YYYY-MM-DD}``
  in a workspace (``rollup_partition``): one whole item per scope and day, written by voc-adoption-rollup
  (lambda/jobs/adoption_rollup/handler.py) from the scope's projects and holding every month it covers, so a rerun of
  the same day overwrites the same item and the newest item is always a complete picture. Counts and day histograms
  only, never a person, a name or a text; the items expire after ``ROLLUP_TTL_DAYS``. The hard delete sweeps a
  workspace's with its settings (jobs/workspace_delete/sweeps.py), and the export leaves them out (derived);
* the baselines (``SETTINGS#adoption`` / ``config``, ``WS#{ws}#SETTINGS#adoption`` in a workspace, through
  shared/workspace_config.py): the hours a person takes to make each kind of artifact by hand, which the time-saved
  estimate multiplies by the AI-made artifacts; ``{baselines, note, updated_by: {sub, kind}, updated_at, reason}`` (D4).
  No row: the defaults below, labelled as defaults. Only the scope's admins change them, never a delegated caller
  (shared/adoption_routes.py).

The estimate is never presented as a measurement (TENETS.md tenet 1; owner decision 11): every answer carrying hours
says it is an estimate and names its baselines and assumptions (shared/adoption_view.py).
"""
from __future__ import annotations

import math
from collections.abc import Mapping
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Final

from shared.exceptions import ValidationError
from shared.request_body import require_known_change

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['ADOPTION_KIND', 'ARTIFACT_TYPES', 'DEPLOYMENT_KEY', 'REASON', 'ROLLUP_TTL_DAYS', 'baselines_of',
           'config_view', 'merged_config', 'rollup_partition', 'stored_fields', 'validate_changes']

#: The rollup's family in a workspace's keys (``WS#{ws}#ADOPTION#ROLLUP``) and the deployment's partition.
ADOPTION_FAMILY: Final = 'ADOPTION'
_ROLLUP_PART: Final = 'ROLLUP'
DEPLOYMENT_ROLLUP_PARTITION: Final = f'{ADOPTION_FAMILY}#{_ROLLUP_PART}'
#: How long a day's rollup item is kept (only the newest is read; the rest are an "as of" trail).
ROLLUP_TTL_DAYS: Final = 35

#: The settings kind (``WS#{ws}#SETTINGS#adoption``) and the deployment's row.
ADOPTION_KIND: Final = 'adoption'
DEPLOYMENT_KEY: Final = {'pk': 'SETTINGS#adoption', 'sk': 'config'}
#: Why the row was written (TENETS.md D4).
REASON: Final = 'adoption_baselines'

#: The artifacts the estimate counts, in methodology order (shared/methodology.py ``STEPS``).
ARTIFACT_TYPES: Final = ('personas', 'research', 'prfaq', 'prd', 'prototype')
#: Hours a person takes to make one by hand, until an admin sets their own: a starting point, labelled as a default
#: wherever it is shown, never a measurement.
DEFAULT_BASELINE_HOURS: Final[Mapping[str, float]] = {
    'personas': 1.5, 'research': 6.0, 'prfaq': 4.0, 'prd': 8.0, 'prototype': 16.0,
}
MAX_BASELINE_HOURS: Final = 200
MAX_NOTE_CHARS: Final = 500
_FIELDS: Final = ('baselines', 'note')


def rollup_partition(scope: WorkspaceScope | None) -> str:
    """The scope's rollup partition: ``ADOPTION#ROLLUP``, or ``WS#{ws}#ADOPTION#ROLLUP`` in a workspace."""
    return DEPLOYMENT_ROLLUP_PARTITION if scope is None else scope.key(ADOPTION_FAMILY, _ROLLUP_PART)


def _hours(name: str, value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
        raise ValidationError(f'baselines.{name} must be a number of hours')
    hours = float(value)
    if not math.isfinite(hours) or not 0 <= hours <= MAX_BASELINE_HOURS:
        raise ValidationError(f'baselines.{name} must be between 0 and {MAX_BASELINE_HOURS} hours')
    return round(hours, 2)


def validate_changes(body: Mapping[str, Any]) -> dict[str, Any]:
    """The fields a ``PUT /settings/adoption`` changes: ``baselines`` (a map of some of ``ARTIFACT_TYPES`` to hours,
    0 to ``MAX_BASELINE_HOURS``; a type set to null goes back to its default) and ``note`` (the admin's own words on
    where the numbers come from, at most ``MAX_NOTE_CHARS``; null or empty clears it). 400 on anything else."""
    require_known_change(dict(body), _FIELDS)
    changes: dict[str, Any] = {}
    if 'baselines' in body:
        given = body['baselines']
        if not isinstance(given, Mapping) or not given:
            raise ValidationError(f"baselines must map at least one of: {', '.join(ARTIFACT_TYPES)} to hours")
        unknown = sorted(str(name) for name in given if name not in ARTIFACT_TYPES)
        if unknown:
            raise ValidationError(f"Unknown artifact type(s): {', '.join(unknown)}")
        changes['baselines'] = {name: None if value is None else _hours(name, value) for name, value in given.items()}
    if 'note' in body:
        note = body['note']
        if note is not None and not isinstance(note, str):
            raise ValidationError('note must be text, or null')
        text = (note or '').strip()
        if len(text) > MAX_NOTE_CHARS:
            raise ValidationError(f'note must be at most {MAX_NOTE_CHARS} characters')
        changes['note'] = text or None
    return changes


def _stored_hours(row: Mapping[str, Any]) -> dict[str, float]:
    """The hours a stored row sets, by type (a value that is not a number in range is ignored: its default holds)."""
    stored = row.get('baselines')
    if not isinstance(stored, Mapping):
        return {}
    kept: dict[str, float] = {}
    for name in ARTIFACT_TYPES:
        try:
            kept[name] = _hours(name, stored.get(name))
        except ValidationError:
            continue
    return kept


def merged_config(row: Mapping[str, Any], changes: Mapping[str, Any]) -> dict[str, Any]:
    """The row's own hours and note with ``changes`` applied (a type set to null is dropped: its default holds)."""
    hours = _stored_hours(row)
    for name, value in (changes.get('baselines') or {}).items():
        if value is None:
            hours.pop(name, None)
        else:
            hours[name] = value
    note = changes['note'] if 'note' in changes else row.get('note')
    return {'baselines': hours, 'note': note if isinstance(note, str) and note else None}


def stored_fields(merged: Mapping[str, Any]) -> dict[str, Any]:
    """``merged_config``'s answer as DynamoDB stores it (hours as Decimal)."""
    return {'baselines': {name: Decimal(str(value)) for name, value in merged['baselines'].items()},
            'note': merged['note']}


def baselines_of(row: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Per artifact type: the hours the estimate uses and whether they are the admin's (``saved``) or the default."""
    own = _stored_hours(row)
    return {name: {'hours': own.get(name, DEFAULT_BASELINE_HOURS[name]), 'saved': name in own}
            for name in ARTIFACT_TYPES}


def config_view(row: Mapping[str, Any]) -> dict[str, Any]:
    """The scope's baselines as the routes answer them (no row: every default)."""
    note = row.get('note')
    updated_at = row.get('updated_at')
    return {'baselines': baselines_of(row), 'defaults': dict(DEFAULT_BASELINE_HOURS),
            'note': note if isinstance(note, str) and note else None,
            'updated_at': updated_at if isinstance(updated_at, str) else None,
            'max_hours': MAX_BASELINE_HOURS, 'max_note_chars': MAX_NOTE_CHARS}
