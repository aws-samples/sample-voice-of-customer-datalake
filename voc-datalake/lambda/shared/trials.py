"""Trial workspaces (7.71.00; docs/multi-workspace.md, "Trial workspaces"): a workspace a platform admin creates at the
end of a workshop, which runs for 14, 30 or 60 days (``DEFAULT_TRIAL_DAYS``, 30) and then PAUSES. It never deletes
itself: it stays paused until a platform admin extends or converts it, its admins export it, or the data controller
asks for its hard delete (shared/workspace_deletes.py, only with ``-c workspaceHardDelete=true``).

The trial is ONE map, ``trial``, the same on the workspace's ``META`` row and on its listing row (``WORKSPACES`` /
``{name}#{ws}``, what the platform console lists); ``META`` is the one read:

    rev            one up with every write; each write is conditional on the one it read (``save_trial``)
    days           the length asked at creation (14, 30 or 60)
    created_at, created_by   when, and which platform admin (a sub)
    expires_at     when it pauses (UTC, to the second); an extension moves it
    pack           what the starter pack asked for, {forms: [template ids], categories, playbooks}: applied after the
                   creation by the SPA or scripts/trial-pack.mjs as ordinary creates through the existing routes, with
                   the admin's own credentials, each audited by its own route
    extended       [{at, by, days, expires_at, resumed?}], newest last, at most ``MAX_EXTENSIONS``
    paused_at      set by voc-trial-expiry when the trial paused (absent while it runs)
    paused         {plugins: [ids], forms: [ids]}: what the pause turned off, so an extension or a conversion turns
                   exactly that back on (shared/trial_pause.py)
    resuming_at    set by an extension or a conversion of a paused trial before it turns anything back on, removed
                   with the pause: the hourly pause leaves the trial alone meanwhile, for 15 minutes at most (a mark
                   left by a resume that failed goes stale, and the next tick pauses the trial again); the console
                   says so (``resume_incomplete``)
    converted_at, converted_by   a conversion: a regular workspace from then on (the expiry's tick passes it by)

No new workspace status (a paused trial is ``active``, so every reader, writer, the export and the hard delete treat it
as any workspace). Its audit rows, in ``AUDIT#WS#{ws}`` under the audit-row guard: ``trial_created`` (in the creation's
own transaction, shared/platform_workspaces.py), ``trial_extended``, ``trial_converted`` (here, before their writes)
and ``trial_paused`` (the job's). Nothing here deletes anything.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.audit_rows import put_new_audit_row
from shared.aws import CONDITION_FAILED, TRANSACTION_CONFLICT, cancellation_codes
from shared.dynamo_values import plain, text_field
from shared.exceptions import ConflictError, NotFoundError
from shared.platform_workspaces import LISTING_PK, listing_sort_key
from shared.timestamps import now_iso, parse_iso
from shared.trial_state import (
    CONVERTED_AT,
    PAUSED,
    PAUSED_AT,
    RESUMING_AT,
    TRIAL,
    TRIAL_PAUSED_CODE,
    at_second,
    is_paused,
    paused_lists,
)
from shared.workspace import ACTIVE, audit_key, audit_sort_key, consistent_row, is_workspace_id, ws_key

#: An extension's history is kept on the map, so it is bounded.
MAX_EXTENSIONS: Final = 50
TRIAL_EXTENDED: Final = 'trial_extended'
TRIAL_PAUSED_KIND: Final = TRIAL_PAUSED_CODE   # (the audit row's kind is the refusal's code)
TRIAL_CONVERTED: Final = 'trial_converted'
#: The one 404 of a trial route: a malformed or unknown id, a workspace that is not active, or one that is no trial.
TRIAL_NOT_FOUND: Final = 'Trial not found'
TRIAL_ALREADY_CONVERTED: Final = 'This trial was converted: it is a regular workspace now, with no end'
TRIAL_CHANGED: Final = 'The trial changed meanwhile: reload it and try again'
TOO_MANY_EXTENSIONS: Final = f'A trial is extended at most {MAX_EXTENSIONS} times: convert it instead'
#: What a trial route reads of ``META``.
META_ATTRIBUTES: Final = ('pk', 'sk', 'status', 'name', 'slug', TRIAL)


def expiry_of(trial: Mapping[str, Any]) -> datetime | None:
    """When ``trial`` pauses, or None for a map that names no time."""
    return parse_iso(trial.get('expires_at'))


def is_converted(trial: Mapping[str, Any]) -> bool:
    return isinstance(trial.get(CONVERTED_AT), str)


def trial_view(trial: object) -> dict[str, Any] | None:
    """The platform console's view of a stored ``trial`` (every field but ``rev`` and the resume's mark: a route
    answers it only once its own write removed the mark, so whether a resume was cut short is the listing's, shared/
    trial_state.py ``trial_summary``), or None for no trial."""
    if not isinstance(trial, Mapping):
        return None
    view = {field: text_field(trial, field) for field in ('created_at', 'created_by', 'expires_at', PAUSED_AT,
                                                     CONVERTED_AT, 'converted_by')}
    pack = trial.get('pack')
    extended = trial.get('extended')
    return {**view, 'days': plain(trial.get('days')), 'pack': plain(pack) if isinstance(pack, Mapping) else {},
            'extended': plain(extended) if isinstance(extended, list) else [],
            PAUSED: paused_lists(trial) if is_paused(trial) else None}


def read_meta(table: Any, ws: str) -> dict[str, Any]:
    """Workspace ``ws``'s ``META`` (``META_ATTRIBUTES``, strongly consistent), or {} when there is none."""
    return dict(consistent_row(table, ws_key(ws), 'META', META_ATTRIBUTES))


def trial_workspace(table: Any, ws: object) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """The workspace id, its ``META`` and its trial for a trial route; the one 404 ``TRIAL_NOT_FOUND`` otherwise (see
    its doc)."""
    if not isinstance(ws, str) or not is_workspace_id(ws):
        raise NotFoundError(TRIAL_NOT_FOUND)
    meta = read_meta(table, ws)
    trial = meta.get(TRIAL)
    if meta.get('status') != ACTIVE or not isinstance(trial, Mapping):
        raise NotFoundError(TRIAL_NOT_FOUND)
    return ws, meta, dict(trial)


def _rev(trial: Mapping[str, Any]) -> int:
    value = trial.get('rev')
    return int(value) if isinstance(value, int | Decimal) and not isinstance(value, bool) else 0


def save_trial(table: Any, ws: str, meta: Mapping[str, Any], trial: Mapping[str, Any]) -> dict[str, Any]:
    """Write ``trial`` (its ``rev`` one up from the one ``meta`` holds) on ``META`` and the listing row in ONE
    transaction: ``META``'s while its ``rev`` is still the one read, the listing row's while it still carries a trial
    (a rename moved it meanwhile). 409 ``TRIAL_CHANGED`` when either changed. Only ``trial`` is written, on both."""
    stored = meta.get(TRIAL)
    before = _rev(stored) if isinstance(stored, Mapping) else 0
    saved = {**trial, 'rev': before + 1}
    stored_name = meta.get('name')
    name = stored_name if isinstance(stored_name, str) else ''
    update = {'UpdateExpression': 'SET #trial = :trial', 'ExpressionAttributeNames': {'#trial': TRIAL}}
    items = [
        {'Update': {'TableName': table.name, 'Key': {'pk': ws_key(ws), 'sk': 'META'}, **update,
                    'ConditionExpression': '#trial.#rev = :rev',
                    'ExpressionAttributeNames': {'#trial': TRIAL, '#rev': 'rev'},
                    'ExpressionAttributeValues': {':trial': saved, ':rev': before}}},
        {'Update': {'TableName': table.name, 'Key': {'pk': LISTING_PK, 'sk': listing_sort_key(name, ws)}, **update,
                    'ConditionExpression': 'attribute_exists(#trial)', 'ExpressionAttributeValues': {':trial': saved}}},
    ]
    try:
        table.meta.client.transact_write_items(TransactItems=items)
    except ClientError as exc:
        codes = cancellation_codes(exc)
        if CONDITION_FAILED in codes or TRANSACTION_CONFLICT in codes:
            raise ConflictError(TRIAL_CHANGED, code='trial_changed') from exc
        raise
    return saved


def audit_trial(table: Any, ws: str, kind: str, actor: str, fields: Mapping[str, Any]) -> str:
    """A trial audit row (a new row only, the audit-row guard); its time."""
    at = now_iso()
    put_new_audit_row(table, {'pk': audit_key(ws), 'sk': audit_sort_key(at), 'kind': kind, 'actor': actor, 'at': at,
                              **fields})
    return at


#: Turns a paused trial's plugins and forms back on (shared/trial_pause.py ``resume``, bound by the handler):
#: ``(ws, trial, actor, reason)`` -> ``{plugins: n, forms: n, skipped: [{form_id, name, code}]}``.
Resume = Callable[[str, Mapping[str, Any], str, str], dict[str, Any]]


def _without_pause(trial: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in trial.items() if key not in (PAUSED_AT, PAUSED, RESUMING_AT)}


def _resumed(table: Any, ws: str, meta: Mapping[str, Any], trial: dict[str, Any], *, resume: Resume, actor: str,
             reason: str, now: datetime) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """A paused trial resumed: marked ``resuming_at`` (the request's time) first (``save_trial``), so the hourly
    pause, which leaves a trial being resumed alone while the mark is fresh (shared/trial_pause.py), cannot turn off
    what ``resume`` turns on before the caller's own write removes the pause; then ``resume``. The ``META`` and trial
    that write is conditional on, and what the resume did. A failure leaves the trial marked and still paused
    (``resume_incomplete``): the same request again finishes it, or the hourly pause pauses it again once the mark is
    stale."""
    marked = save_trial(table, ws, meta, {**trial, RESUMING_AT: at_second(now)})
    return {**meta, TRIAL: marked}, marked, resume(ws, marked, actor, reason)


def extend_trial(table: Any, ws: object, days: int, actor: str, *, resume: Resume, now: datetime) -> dict[str, Any]:
    """Extend the trial by ``days`` from its end, or from now when it already ended; the trial's view, with what this
    extension resumed (``resumed``, None for a trial that was not paused).

    In order: the ``trial_extended`` audit row; a paused trial marked ``resuming_at`` and its plugins and forms turned
    back on (``resume``); then the map (the new ``expires_at``, the history, the pause and the mark removed). The
    expiry's hourly tick reads the new end from the listing, so nothing is scheduled. 409 for a converted trial, past
    ``MAX_EXTENSIONS``, or a trial changed meanwhile; a failure after the audit row leaves the trial as it was or
    (partly) resumed but still marked paused, and the same extension again finishes it (its end counted from the same
    stored end)."""
    workspace, meta, trial = trial_workspace(table, ws)
    if is_converted(trial):
        raise ConflictError(TRIAL_ALREADY_CONVERTED, code='trial_converted')
    history = [entry for entry in trial.get('extended') or [] if isinstance(entry, Mapping)]
    if len(history) >= MAX_EXTENSIONS:
        raise ConflictError(TOO_MANY_EXTENSIONS, code='trial_extensions')
    ends = expiry_of(trial) or now
    expires_at = max(ends, now) + timedelta(days=days)
    paused = is_paused(trial)
    at = audit_trial(table, workspace, TRIAL_EXTENDED, actor, {'days': days, 'expires_at': at_second(expires_at),
                                                           'was_paused': paused, 'platform_admin': True})
    entry: dict[str, Any] = {'at': at, 'by': actor, 'days': days, 'expires_at': at_second(expires_at)}
    if paused:
        meta, trial, entry['resumed'] = _resumed(table, workspace, meta, trial, resume=resume, actor=actor,
                                                 reason=TRIAL_EXTENDED, now=now)
    saved = save_trial(table, workspace, meta, {**_without_pause(trial), 'expires_at': at_second(expires_at),
                                                'extended': [*history, entry]})
    return {**(trial_view(saved) or {}), 'resumed': entry.get('resumed')}


def convert_trial(table: Any, ws: object, actor: str, *, resume: Resume, now: datetime) -> dict[str, Any]:
    """Convert the trial into a regular workspace (no end any more); the trial's view, with what this conversion
    resumed (``resumed``, None for a trial that was not paused). A converted one is answered as it is (nothing
    written, nothing resumed). In order: the ``trial_converted`` audit row, a paused trial marked ``resuming_at`` and
    its plugins and forms turned back on, then the map (``converted_at``, ``converted_by``, the pause and the mark
    removed); the expiry's tick passes a converted trial by."""
    workspace, meta, trial = trial_workspace(table, ws)
    if is_converted(trial):
        return {**(trial_view(trial) or {}), 'resumed': None}
    paused = is_paused(trial)
    at = audit_trial(table, workspace, TRIAL_CONVERTED, actor, {'was_paused': paused, 'platform_admin': True})
    resumed: dict[str, Any] | None = None
    if paused:
        meta, trial, resumed = _resumed(table, workspace, meta, trial, resume=resume, actor=actor,
                                        reason=TRIAL_CONVERTED, now=now)
    converted: dict[str, Any] = {**_without_pause(trial), CONVERTED_AT: at, 'converted_by': actor}
    if resumed is not None:
        converted['resumed'] = resumed
    return {**(trial_view(save_trial(table, workspace, meta, converted)) or {}), 'resumed': resumed}
