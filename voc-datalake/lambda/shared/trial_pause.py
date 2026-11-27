"""A trial's pause and its resume (7.71.00; shared/trials.py, docs/multi-workspace.md "Trial workspaces").

Which trials are due, ``due_trials`` (voc-trial-expiry's hourly tick): one paged Query of the platform listing
(``WORKSPACES``, whose rows carry each trial's map, written in the same transaction as ``META``'s), keeping the trials
that are not converted, whose ``expires_at`` has passed, and that are not paused yet (or paused within the last
``REVISIT``, so a pause cut short is finished by the next tick, or carrying a stale ``resuming_at`` mark, see below). A
trial whose ``expires_at`` does not parse is never due: it is skipped and logged, and ``pause`` refuses it too
(``NO_EXPIRY``).

The pause, ``pause`` (once a trial is due), in this order:

1. ``trial.paused_at`` set first (``save_trial``, conditional on the ``rev`` read): from then on no plugin enable and no
   form put live can land (shared/trial_state.py);
2. what is on now: the plugins of the deployment's ceiling the workspace enabled (one GetItem each) and its live
   forms (one paged Query of its forms partition, the ``FORM#`` rows' ``enabled``);
3. those lists, joined to any an earlier attempt recorded (read through shared/trial_state.py ``paused_lists``), stored
   as ``trial.paused``, always, and conditional on the ``rev`` read: a retry after a partial pause still turns
   everything back on later, and an extension or a conversion that marked the trial meanwhile makes this write fail
   (409 ``trial_changed``) before anything is turned off;
4. the ``trial_paused`` audit row (actor ``trial-expiry``, kind ``schedule``, the lists);
5. each plugin turned off by the existing audited change (shared/workspace_plugin_settings.py ``set_trial_plugin``: its
   own ``plugin_disabled`` row, reason ``trial_paused``), and each form set ``enabled`` false (a conditional update of
   ``enabled``, its save counter one up so an editor's stale copy cannot turn it on again, ``updated_at`` and
   ``updated_by``). Each turn-off is one transaction with a check of ``META`` (shared/trial_state.py
   ``unchanged_check``): the workspace still active and the trial's ``rev`` still the one step 3 saved. A mark an
   extension or a conversion committed after step 3 moved it, so the first turn-off after it is refused and the pause
   stops there (409 ``trial_changed``), turning nothing more off and undoing nothing the extension turned on (7.71.04:
   7.71.03 read the ``rev`` again before each turn-off, one GetItem each, and a mark committed between that read and
   the turn-off was not seen). A refused plugin's ``plugin_disabled`` row is still written, first, as for every
   plugin change. A refusal because the workspace stopped being active meanwhile (its deletion began) is told apart
   by one read of ``META`` (7.104.00, Q6): the pause stops there too, with nothing more to do, and answers
   ``not_active`` with what it turned off, never ``trial_changed``.

No form is put live once step 1 committed (the publish's own transaction checks ``paused_at``), so the forms read in
step 2 are all there are. A trial an extension or a conversion is resuming (``resuming_at``, shared/trials.py) is not
due while the mark is fresh (``RESUMING_FRESH``): its resume is not undone. An older mark is a resume that failed and
was not repeated. It makes the trial due again only once the trial's end has passed (``expires_at``, as for any trial:
an extension whose resume failed never wrote its new end, so a paused trial's end is still the one that paused it);
its pause then turns off what that resume turned on and removes the mark in step 3's write.

Nothing is deleted but the plugins' own ``PLUGIN#{plugin}`` / ``WS#{ws}`` rows, which ARE the existing disable (a
present row means enabled; the ingestors' tick fans out over them). No form, response, feedback item, project, file or
audit row is touched, and the workspace stays ``active``: reads and the export keep working.

The resume, ``resume`` (an extension or a conversion, the workspaces API, a platform admin): each plugin of
``trial.paused`` the deployment still offers turned back on (``plugin_enabled``, the platform admin's, reason the
route's) and each form of it set ``enabled`` true while it is still there, still off and still publishable: a form
whose theme is unreadable or whose texts show a placeholder as written (an edit while it was paused) stays off, and
the answer names it (``skipped``, its id, its name and the publish rule's code) for its editors to fix and publish.
The extend and convert routes answer it (``resumed``), and the console shows it. An imported form is never live, so it
is never paused, and a form someone deleted meanwhile stays deleted.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from botocore.exceptions import ClientError

from shared import forms_v2 as fv2
from shared.aws import CONDITION_FAILED, cancellation_codes, is_conditional_check_failure
from shared.dynamo_paging import iter_query
from shared.exceptions import ConflictError, ValidationError
from shared.logging import logger
from shared.onboarding import forms_partition
from shared.platform_workspaces import LISTING_PK
from shared.timestamps import now_iso, parse_iso
from shared.trial_state import (
    PAUSED,
    PAUSED_AT,
    RESUMING_AT,
    TRIAL,
    at_second,
    is_paused,
    paused_lists,
    resume_incomplete,
)
from shared.trials import (
    TRIAL_CHANGED,
    TRIAL_PAUSED_KIND,
    audit_trial,
    expiry_of,
    is_converted,
    read_meta,
    save_trial,
)
from shared.workspace import ACTIVE
from shared.workspace_ids import is_workspace_id
from shared.workspace_plugin_settings import set_trial_plugin, workspace_ceiling, workspace_plugins
from shared.ws_repo import WorkspaceScope, WorkspaceTable, scope_from_message

#: The expiry job's actor in what it writes (its audit rows, a form's ``updated_by``).
EXPIRY_ACTOR: Final = 'trial-expiry'
EXPIRY_ACTOR_KIND: Final = 'schedule'
_FORM_PREFIX: Final = 'FORM#'
#: The job's answers, one per case (lambda/jobs/trial_expiry/handler.py logs them).
PAUSED_NOW: Final = 'paused'
NOT_A_TRIAL: Final = 'not_a_trial'
NOT_ACTIVE: Final = 'not_active'
CONVERTED: Final = 'converted'
NOT_DUE: Final = 'not_due'
ALREADY_PAUSED: Final = 'already_paused'
NO_EXPIRY: Final = 'no_expiry'
#: How long after its pause a trial is still visited by the hourly tick (a pause cut short is finished; a finished one
#: is answered ``ALREADY_PAUSED`` and writes nothing).
REVISIT: Final = timedelta(days=1)
#: How long a ``resuming_at`` mark holds the pause off: an extension or a conversion is one API request (29 s at most),
#: so a mark older than this is a resume that failed, and the trial is paused again.
RESUMING_FRESH: Final = timedelta(minutes=15)


@dataclass(frozen=True)
class PauseTables:
    """What a pause or a resume reads and writes: voc-workspaces (the trial, the plugin rows, the audit rows), the
    workspace's view of voc-aggregates (its forms) and the deployment's plugins (the ceiling)."""

    workspaces: Any
    forms: Callable[[WorkspaceScope], WorkspaceTable]
    ceiling: Sequence[str]


def workspace_scope(ws: str) -> WorkspaceScope:
    """The scope of the workspace whose ``META`` the caller just read (the job's schedule names it; a platform admin's
    route reads it by its id, decision 2): the trial's own rows, never a request's body."""
    return scope_from_message({'workspace_id': ws})


def live_forms(forms: WorkspaceTable, scope: WorkspaceScope) -> list[str]:
    """The ids of the workspace's forms that are live (``enabled`` true), in sort-key order."""
    rows = forms.iter_query('pk', forms_partition(scope), sort_condition='begins_with(#sk, :form)',
                            ProjectionExpression='#sk, #enabled', ConsistentRead=True,
                            ExpressionAttributeNames={'#sk': 'sk', '#enabled': 'enabled'},
                            ExpressionAttributeValues={':form': _FORM_PREFIX})
    return [str(row['sk']).removeprefix(_FORM_PREFIX) for row in rows
            if row.get('enabled') is True and isinstance(row.get('sk'), str) and row['sk'].startswith(_FORM_PREFIX)]


def _listing_trials(table: Any) -> Iterator[tuple[object, Mapping[str, Any]]]:
    """Every ``(workspace_id, trial)`` of the platform listing's rows that carry a trial (paged, strongly consistent)."""
    rows = iter_query(table, {
        'KeyConditionExpression': 'pk = :pk', 'FilterExpression': 'attribute_exists(#trial)',
        'ProjectionExpression': 'workspace_id, #trial', 'ExpressionAttributeNames': {'#trial': TRIAL},
        'ExpressionAttributeValues': {':pk': LISTING_PK}, 'ConsistentRead': True,
    })
    for row in rows:
        trial = row.get(TRIAL)
        if isinstance(trial, Mapping):
            yield row.get('workspace_id'), trial


def _resuming(trial: Mapping[str, Any], now: datetime) -> bool:
    """Whether an extension or a conversion is resuming ``trial`` now: its ``resuming_at`` mark is less than
    ``RESUMING_FRESH`` old (a mark that does not parse holds nothing off)."""
    marked = parse_iso(trial.get(RESUMING_AT))
    return marked is not None and now - marked < RESUMING_FRESH


def _visited(trial: Mapping[str, Any], now: datetime) -> bool:
    """Whether the hourly tick visits a trial whose end passed: not paused yet, paused within ``REVISIT``, or left
    marked by a resume that failed (a stale mark)."""
    if not is_paused(trial):
        return True
    paused_at = parse_iso(trial.get(PAUSED_AT))
    recently = paused_at is not None and now - paused_at < REVISIT
    return recently or (resume_incomplete(trial) and not _resuming(trial, now))


def due_trials(table: Any, now: datetime) -> list[str]:
    """The ids of the trials to pause now (see the module docstring), read from the platform listing of voc-workspaces
    (``table``)."""
    due: list[str] = []
    for ws, trial in _listing_trials(table):
        if not is_workspace_id(ws) or is_converted(trial):
            continue
        expiry = expiry_of(trial)
        if expiry is None:
            logger.warning('Trial with no readable expires_at: not paused', extra={'workspace_id': ws})
            continue
        if expiry <= now and _visited(trial, now):
            due.append(str(ws))
    return due


def set_form_live(view: WorkspaceTable, scope: WorkspaceScope, form_id: str, live: bool, actor: str, at: str, *,
                  unchanged: tuple[Any, object] | None = None) -> bool:
    """``enabled`` set to ``live`` on the form while it exists and is the other way; its save counter one up,
    ``updated_at`` and ``updated_by``. True when it changed, False when there was nothing to change.

    ``unchanged`` (a pause's turn-off, 7.71.04): ``(voc-workspaces, the rev the pause saved)``, the update then one
    transaction with the check that the trial is still at that rev (shared/ws_repo.py ``unchanged_in``); when that
    check refuses, the cancelled transaction's error propagates (``_turn_off`` stops the pause)."""
    key = {'pk': forms_partition(scope), 'sk': f'{_FORM_PREFIX}{form_id}'}
    update = {
        'UpdateExpression': ('SET #enabled = :to, #writes = if_not_exists(#writes, :zero) + :one, '
                             '#updated_at = :at, #updated_by = :actor'),
        'ConditionExpression': 'attribute_exists(#sk) AND #enabled = :from',
        'ExpressionAttributeNames': {'#enabled': 'enabled', '#writes': 'write_count', '#updated_at': 'updated_at',
                                     '#updated_by': 'updated_by', '#sk': 'sk'},
        'ExpressionAttributeValues': {':to': live, ':from': not live, ':zero': 0, ':one': 1, ':at': at,
                                      ':actor': actor},
    }
    try:
        if unchanged is None:
            view.update_item(key, **update, ReturnValues='NONE')
        else:
            view.transact_write_items([{'Update': {'Key': key, **update}}], unchanged_in=unchanged)
    except ClientError as exc:
        # The form's own condition alone (gone, or already the other way): nothing to change.
        if is_conditional_check_failure(exc) or cancellation_codes(exc) == [CONDITION_FAILED, None]:
            return False
        raise
    return True


def _union(first: Iterable[str], second: Iterable[str]) -> list[str]:
    return list(dict.fromkeys([*first, *second]))


def _enabled_plugins(tables: PauseTables, ws: str) -> list[str]:
    return [entry['id'] for entry in workspace_plugins(tables.workspaces, ws, tables.ceiling) if entry['enabled']]


def _due(ws: str, meta: Mapping[str, Any], trial: object, now: datetime) -> str | None:
    """Why there is nothing to pause, or None when the trial is due."""
    if not isinstance(trial, Mapping):
        return NOT_A_TRIAL
    if meta.get('status') != ACTIVE:
        return NOT_ACTIVE
    if is_converted(trial):
        return CONVERTED
    expiry = expiry_of(trial)
    if expiry is None:
        # A trial whose end does not parse is never paused: its plugins and forms stay on until a platform admin
        # fixes it (an extension writes a new end).
        logger.warning('Trial with no readable expires_at: not paused', extra={'workspace_id': ws})
        return NO_EXPIRY
    if expiry > now or _resuming(trial, now):
        # An extension moved the end since the listing was read, or one (or a conversion) is turning the trial back on.
        return NOT_DUE
    return None


@dataclass(frozen=True)
class _TurnedOff:
    """What a pause's turn-offs did: how many plugins and forms changed, and whether the workspace was still active
    (False: one turn-off found it no longer was, and the rest were not tried)."""

    plugins: int
    forms: int
    active: bool = True


def _turn_off(tables: PauseTables, ws: str, forms: WorkspaceTable, saved: Mapping[str, Any], at: str) -> _TurnedOff:
    """Each plugin, then each form, of the lists the pause saved on the trial (``saved``) turned off, each in one
    transaction whose last entry checks that the trial is still at ``saved``'s ``rev`` and the workspace still active
    (7.71.04). A turn-off that check refuses stops the pause, nothing more turned off: 409 ``trial_changed`` (Q3,
    7.71.03), or (7.104.00, Q6), when ``META`` then says the workspace is no longer active, what was turned off until
    then, ``active`` False."""
    actor = {'actor': EXPIRY_ACTOR, 'actor_kind': EXPIRY_ACTOR_KIND}
    scope = workspace_scope(ws)
    lists = paused_lists(saved)
    rev = saved.get('rev')
    unchanged = (tables.workspaces, rev)
    plugins_off = forms_off = 0
    try:
        for plugin in lists['plugins']:
            plugins_off += set_trial_plugin(tables.workspaces, ws, plugin, False, actor, TRIAL_PAUSED_KIND, rev=rev)
        for form_id in lists['forms']:
            forms_off += set_form_live(forms, scope, form_id, False, EXPIRY_ACTOR, at, unchanged=unchanged)
    except ClientError as exc:
        if cancellation_codes(exc)[-1:] != [CONDITION_FAILED]:
            raise
        if read_meta(tables.workspaces, ws).get('status') != ACTIVE:
            logger.info('Trial pause stopped: the workspace is no longer active', extra={'workspace_id': ws})
            return _TurnedOff(plugins_off, forms_off, active=False)
        raise ConflictError(TRIAL_CHANGED, code='trial_changed') from exc
    return _TurnedOff(plugins_off, forms_off)


def pause(tables: PauseTables, ws: str, now: datetime) -> dict[str, Any]:
    """Pause trial ``ws`` if it is due (see the module docstring); what was done, ``outcome`` saying which case."""
    meta = read_meta(tables.workspaces, ws)
    trial = meta.get('trial')
    reason = _due(ws, meta, trial, now)
    if reason is not None or not isinstance(trial, Mapping):
        return {'outcome': reason or NOT_A_TRIAL}
    # Due with a mark left: a stale one (a resume that failed); this pause turns off what it turned on and removes it.
    stale = resume_incomplete(trial)
    trial = {key: value for key, value in trial.items() if key != RESUMING_AT}
    was_paused = is_paused(trial)
    if not was_paused:
        trial = save_trial(tables.workspaces, ws, meta, {**trial, PAUSED_AT: at_second(now)})
        meta = {**meta, 'trial': trial}
    scope = workspace_scope(ws)
    forms = tables.forms(scope)
    recorded = paused_lists(trial)
    still_on, still_live = _enabled_plugins(tables, ws), live_forms(forms, scope)
    if was_paused and not stale and not still_on and not still_live:
        # A run again of a pause that finished (a retried invoke): nothing is on, so nothing is written.
        return {'outcome': ALREADY_PAUSED}
    plugins = _union(recorded['plugins'], still_on)
    live = _union(recorded['forms'], still_live)
    # Always, and conditional on the rev read (Q1, 7.71.02): a mark an extension or a conversion committed since the
    # read fails this write (409), so nothing it turned on is turned off; one committed after it stops the turn-offs
    # (Q3, 7.71.03: each turn-off's own transaction checks the rev saved here, 7.71.04).
    trial = save_trial(tables.workspaces, ws, meta, {**trial, PAUSED: {'plugins': plugins, 'forms': live}})
    at = audit_trial(tables.workspaces, ws, TRIAL_PAUSED_KIND, EXPIRY_ACTOR,
                {'actor_kind': EXPIRY_ACTOR_KIND, 'expires_at': trial.get('expires_at'), 'plugins': plugins,
                 'forms': live})
    turned = _turn_off(tables, ws, forms, trial, at)
    if turned.active:
        logger.info('Trial paused', extra={'workspace_id': ws, 'plugins': turned.plugins, 'forms': turned.forms})
    return {'outcome': PAUSED_NOW if turned.active else NOT_ACTIVE, 'plugins': turned.plugins, 'forms': turned.forms}


def _publish_problem(item: Mapping[str, Any]) -> str | None:
    """Why the stored form ``item`` may not be put live again (the publish rules of any write that turns a form live,
    shared/forms_v2.py ``validate_publishable`` and ``validate_placeholders``): the rule's code, or None when it may."""
    try:
        fv2.validate_publishable(item.get('theme'), live=True)
        fv2.validate_placeholders(fv2.definition_of(item), live=True)
    except (ValidationError, ConflictError) as exc:
        return exc.code or 'not_publishable'
    return None


def resume(tables: PauseTables, ws: str, trial: Mapping[str, Any], actor: str, reason: str) -> dict[str, Any]:
    """Turn back on what the pause recorded (see the module docstring): each plugin the deployment still offers, each
    form still there, still off and still publishable, as ``actor`` (a platform admin) for ``reason``; how many of each
    were turned on, and the forms left off (``skipped``: ``[{form_id, name, code}]``)."""
    recorded = paused_lists(trial)
    offered = set(workspace_ceiling(tables.ceiling))
    plugins = [plugin for plugin in recorded['plugins'] if plugin in offered]
    who = {'actor': actor, 'platform_admin': True}
    plugins_on = sum(set_trial_plugin(tables.workspaces, ws, plugin, True, who, reason) for plugin in plugins)
    scope = workspace_scope(ws)
    forms = tables.forms(scope)
    at = now_iso()
    skipped: list[dict[str, str]] = []
    forms_on = 0
    for form_id in recorded['forms']:
        item = forms.get_item({'pk': forms_partition(scope), 'sk': f'{_FORM_PREFIX}{form_id}'},
                              ConsistentRead=True).get('Item')
        if not isinstance(item, Mapping):
            # Deleted meanwhile: it stays deleted.
            continue
        problem = _publish_problem(item)
        if problem is None:
            forms_on += set_form_live(forms, scope, form_id, True, actor, at)
        else:
            skipped.append({'form_id': form_id, 'name': str(item.get('name') or '')[:200], 'code': problem})
    logger.info('Trial resumed', extra={'workspace_id': ws, 'plugins': plugins_on, 'forms': forms_on,
                                        'skipped': len(skipped)})
    return {'plugins': plugins_on, 'forms': forms_on, 'skipped': skipped}
