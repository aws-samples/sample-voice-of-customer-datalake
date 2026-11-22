"""A trial workspace's shape and whether it is paused (7.71.00; its writes: shared/trials.py, docs/multi-workspace.md
"Trial workspaces"): the create's ``trial`` validated (``parse_trial``) and the map it is stored as (``new_trial``), and
what the routes that turn something back on ask before they do.

A trial is the ``trial`` map on the workspace's ``META`` row in voc-workspaces. Its expiry (voc-trial-expiry,
shared/trial_pause.py) sets ``trial.paused_at`` first, then turns the workspace's plugins and live forms off; until a
platform admin extends or converts the trial, nothing turns them back on:

* a plugin's enable (``PUT /me/workspaces/current/plugins/{id}``, shared/workspace_plugin_settings.py) commits only
  while ``paused_at`` is absent (a condition in its own transaction, so a pause landing meanwhile still wins);
* a form put live (``POST /feedback-forms`` or ``PUT /feedback-forms/{id}`` with ``enabled: true`` in a workspace,
  lambda/api/feedback_form_handler.py) commits only while ``paused_at`` is absent too (a ConditionCheck of ``META`` in
  the save's own transaction, shared/ws_repo.py ``unpaused_in``).

Both answer 409 with ``TRIAL_PAUSED`` and the code ``trial_paused``. Everything else (reads, edits, the export, a form
turned off, a plugin turned off) works as in any workspace. This module imports none of the trial's writers, so the
request paths (and shared/platform_workspaces.py, which the writers import) take it alone.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from shared.dynamo_values import plain, text_field
from shared.exceptions import ValidationError
from shared.request_body import reject_unknown_fields
from shared.workspace_ids import ws_key

#: The map's attribute on ``META`` and on the listing row.
TRIAL: Final = 'trial'
#: Set by the pause, removed by an extension or a conversion.
PAUSED_AT: Final = 'paused_at'
CONVERTED_AT: Final = 'converted_at'
#: What the pause turned off: ``{plugins: [ids], forms: [ids]}``.
PAUSED: Final = 'paused'
TRIAL_PAUSED: Final = ('This trial workspace is paused: a platform admin extends or converts it to turn its plugins and '
                       'forms back on. Nothing was deleted, and reads and the export still work')
TRIAL_PAUSED_CODE: Final = 'trial_paused'
TRIAL_DAYS: Final = (14, 30, 60)
DEFAULT_TRIAL_DAYS: Final = 30
#: The starter pack's forms: app template ids (frontend …/templates), at most this many.
MAX_PACK_FORMS: Final = 10
_TEMPLATE_ID: Final = re.compile(r'[a-z0-9][a-z0-9_-]{0,39}')
TRIAL_CREATED: Final = 'trial_created'


def is_paused(trial: object) -> bool:
    """Whether ``trial`` (the stored map, or anything else) is paused and not converted."""
    return (isinstance(trial, Mapping) and isinstance(trial.get(PAUSED_AT), str)
            and not isinstance(trial.get(CONVERTED_AT), str))


def stored_trial(table: Any, ws: str) -> dict[str, Any] | None:
    """The ``trial`` map of workspace ``ws``'s ``META`` (one strongly consistent GetItem of that attribute), or None
    for a workspace that is no trial."""
    found = table.get_item(Key={'pk': ws_key(ws), 'sk': 'META'}, ConsistentRead=True,
                           ProjectionExpression='#trial', ExpressionAttributeNames={'#trial': TRIAL}).get('Item')
    trial = found.get(TRIAL) if isinstance(found, Mapping) else None
    return dict(trial) if isinstance(trial, Mapping) else None


@dataclass(frozen=True)
class NewTrial:
    """A validated ``trial`` of a create request."""

    days: int
    pack: dict[str, Any]


def _days(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value not in TRIAL_DAYS:
        raise ValidationError(f'{field} must be 14, 30 or 60')
    return value


def _pack(value: object) -> dict[str, Any]:
    """The starter pack as asked (``{forms, categories, playbooks}``, each optional); a 400 that says what to fix."""
    if value is None:
        value = {}
    if not isinstance(value, Mapping):
        raise ValidationError('trial.pack must be an object')
    reject_unknown_fields(value, ('forms', 'categories', 'playbooks'))
    forms = value.get('forms', [])
    if (not isinstance(forms, list) or len(forms) > MAX_PACK_FORMS or len(set(map(str, forms))) != len(forms)
            or not all(isinstance(form, str) and _TEMPLATE_ID.fullmatch(form) for form in forms)):
        raise ValidationError(f'trial.pack.forms must be at most {MAX_PACK_FORMS} different template ids')
    flags = {flag: value.get(flag, False) for flag in ('categories', 'playbooks')}
    if not all(isinstance(flag, bool) for flag in flags.values()):
        raise ValidationError('trial.pack.categories and trial.pack.playbooks must be true or false')
    return {'forms': list(forms), **flags}


def parse_trial(value: object) -> NewTrial | None:
    """A create's optional ``trial`` (``{days?, pack?}``; ``days`` 30 when absent), or None when there is none."""
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValidationError('trial must be an object')
    reject_unknown_fields(value, ('days', 'pack'))
    return NewTrial(days=_days(value.get('days', DEFAULT_TRIAL_DAYS), 'trial.days'), pack=_pack(value.get('pack')))


def parse_extension(body: Mapping[str, Any]) -> int:
    """An extension's ``{days}`` (14, 30 or 60), or a 400."""
    reject_unknown_fields(body, ('days',))
    return _days(body.get('days'), 'days')


def at_second(moment: datetime) -> str:
    """``moment`` in UTC, to the second, as ISO 8601."""
    return moment.astimezone(UTC).replace(microsecond=0).isoformat()


def new_trial(trial: NewTrial, creator: str, now: datetime) -> dict[str, Any]:
    """The map a new trial is created with (see the module docstring)."""
    return {'rev': 1, 'days': trial.days, 'created_at': at_second(now), 'created_by': creator,
            'expires_at': at_second(now + timedelta(days=trial.days)), 'pack': trial.pack, 'extended': []}


def paused_lists(trial: Mapping[str, Any]) -> dict[str, list[str]]:
    paused = trial.get(PAUSED)
    found = paused if isinstance(paused, Mapping) else {}
    return {kind: [item for item in found.get(kind) or [] if isinstance(item, str)] for kind in ('plugins', 'forms')}


def trial_summary(trial: object) -> dict[str, Any] | None:
    """What every member reads of a trial (``GET /me/workspaces/current``) and the platform console lists of it (``GET
    /platform/workspaces``, from the listing row's copy): when it ends, whether and since when it is
    paused (and how many plugins and forms the pause turned off), whether it was converted; never who did what."""
    if not isinstance(trial, Mapping):
        return None
    lists = paused_lists(trial)
    paused = is_paused(trial)
    return {'days': plain(trial.get('days')), 'expires_at': text_field(trial, 'expires_at'),
            PAUSED_AT: text_field(trial, PAUSED_AT) if paused else None, CONVERTED_AT: text_field(trial, CONVERTED_AT),
            PAUSED: {kind: len(items) for kind, items in lists.items()} if paused else None}
