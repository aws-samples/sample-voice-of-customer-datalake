"""Whether the deployment's projects have switched to working in a workspace (docs/multi-workspace.md, the project
plan's 3h; since 7.100.00, slice 3h-S0, the switch's upgrade check).

The switch (3h) lets projects work in a workspace. Before it may happen, the deployment's operator runs its upgrade
check (scripts/projects/switch_projects.py, with the operator's own credentials); a check that passed, with
``--apply``, writes the switch row: ``SWITCH_KEY`` in voc-projects, a partition of its own (``PROJECTS_SWITCH``; its
sort key starts with ``MIGRATION#``, as the backfill's own rows do). The row names the backfill marker it was checked
against (``marker_at``, the marker's ``completed_at``), the check's version (``check``) and who applied it
(``applied_by``: an account and role, or a user's ARN).

``projects_switched`` is the one reader, fail-closed: True only while the row is complete (``switch_row_complete``),
the marker is complete (shared/review_registries.py ``marker_complete``) and the row names that marker
(``switch_row_current``), both read strongly consistent. Any doubt is False. So an ``--unmark``, the marker's reset on
a rollback below 7.48.00, a restore that brings back no marker or another one, and a re-backfill all switch the
projects off until the check runs again (a restore to after the switch brings the row and its marker back together,
and stays switched on). Nothing
calls it yet: the switch's later slices read it before they let a project work in a workspace.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.project_keys import REVIEW_REGISTRIES_MARKER_KEY
from shared.review_registries import FIRST_RELEASE, MARKER_TIME, marker_complete, release_of

#: What the operator's scripts import (switch_projects.py, backfill_review_registries.py), and the reader.
__all__ = ['MARKER_AT', 'SWITCH_KEY', 'projects_switched', 'switch_row', 'switch_row_complete', 'switch_row_current']

#: The switch row's key in voc-projects: a partition of its own, never a project's, a registry's or a workspace's.
SWITCH_PK: Final = 'PROJECTS_SWITCH'
SWITCH_SK: Final = 'MIGRATION#projects-switch'
SWITCH_KEY: Final = {'pk': SWITCH_PK, 'sk': SWITCH_SK}
#: The check's version: a later slice that tightens the check bumps it, and the reader requires at least this one.
CHECK_VERSION: Final = 1
#: What the row says: when the check passed, the oldest writer's release then, the live projects it looked up in
#: ``PROJECT_IDS``, the steps it took, the marker it was checked against, the check's version and who applied it. The
#: row's attributes are exactly these.
SWITCHED_AT: Final = 'switched_at'
RELEASE: Final = 'release'
PROJECTS_CHECKED: Final = 'projects_checked'
STEPS: Final = 'steps'
MARKER_AT: Final = 'marker_at'
CHECK: Final = 'check'
APPLIED_BY: Final = 'applied_by'
SWITCH_ATTRIBUTES: Final = ('pk', 'sk', SWITCHED_AT, RELEASE, PROJECTS_CHECKED, STEPS, MARKER_AT, CHECK, APPLIED_BY)


def switch_row(at: str, release: str, projects_checked: int, steps: int, marker_at: str,
               applied_by: str) -> dict[str, Any]:
    """The row a passed check writes (scripts/projects/switch_projects.py), at ``CHECK_VERSION``."""
    return {**SWITCH_KEY, SWITCHED_AT: at, RELEASE: release, PROJECTS_CHECKED: projects_checked, STEPS: steps,
            MARKER_AT: marker_at, CHECK: CHECK_VERSION, APPLIED_BY: applied_by}


def _count(value: object) -> int | None:
    """A stored whole number of 0 or more (DynamoDB answers numbers as Decimal); None for anything else."""
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        return None
    if isinstance(value, Decimal) and value != value.to_integral_value():
        return None
    return int(value) if value >= 0 else None


def _is_time(value: object) -> bool:
    """An ISO-8601 time with its offset, as ``now_iso`` and the backfill write it."""
    if not isinstance(value, str) or not value:
        return False
    try:
        return datetime.fromisoformat(value).tzinfo is not None
    except ValueError:
        return False


def switch_row_complete(row: object) -> bool:
    """Whether a switch row says it all: its key and exactly ``SWITCH_ATTRIBUTES``; two times with their offset; a
    release of ``FIRST_RELEASE`` or later; the projects checked (0 or more) and the steps (1 or more); a check of
    ``CHECK_VERSION`` or later; and who applied it."""
    if not isinstance(row, Mapping) or row.get('pk') != SWITCH_PK or row.get('sk') != SWITCH_SK:
        return False
    if set(row) != set(SWITCH_ATTRIBUTES):
        return False  # a field missing, or one no check writes
    release = release_of(row.get(RELEASE))
    steps, check = _count(row.get(STEPS)), _count(row.get(CHECK))
    applied_by = row.get(APPLIED_BY)
    return (_is_time(row.get(SWITCHED_AT)) and _is_time(row.get(MARKER_AT))
            and release is not None and release >= FIRST_RELEASE
            and _count(row.get(PROJECTS_CHECKED)) is not None and steps is not None and steps >= 1
            and check is not None and check >= CHECK_VERSION and isinstance(applied_by, str) and bool(applied_by))


def switch_row_current(row: object, marker: object) -> bool:
    """Whether the row is complete, the marker is complete, and the row names that marker (an older marker's row, after
    a re-backfill, is not current)."""
    return (switch_row_complete(row) and isinstance(marker, Mapping) and marker_complete(marker)
            and isinstance(row, Mapping) and row.get(MARKER_AT) == marker.get(MARKER_TIME))


def _item(projects_table: Any, key: Mapping[str, str]) -> object:
    return projects_table.get_item(Key=dict(key), ConsistentRead=True).get('Item')


def projects_switched(projects_table: Any) -> bool:
    """Whether the deployment's projects have switched: the switch row current for the backfill's marker
    (``switch_row_current``), each read strongly consistent. Any doubt (a row missing, malformed or stale, a read that
    fails) is False."""
    try:
        row = _item(projects_table, SWITCH_KEY)
        if not switch_row_complete(row):
            return False
        marker = _item(projects_table, REVIEW_REGISTRIES_MARKER_KEY)
    except (ClientError, BotoCoreError):
        return False
    return switch_row_current(row, marker)
