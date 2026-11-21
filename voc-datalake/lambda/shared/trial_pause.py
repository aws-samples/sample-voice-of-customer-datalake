"""A trial's pause and its resume (7.71.00; shared/trials.py, docs/multi-workspace.md "Trial workspaces").

The pause, ``pause`` (voc-trial-expiry, at the trial's end), in this order:

1. ``trial.paused_at`` set first (``save_trial``, conditional on the ``rev`` read): from then on no plugin enable and no
   form put live can land (shared/trial_state.py);
2. what is on now: the plugins of the deployment's ceiling the workspace enabled (one GetItem each) and its live
   forms (one paged Query of its forms partition, the ``FORM#`` rows' ``enabled``);
3. those lists, joined to any an earlier attempt recorded, stored as ``trial.paused``: a retry after a partial pause
   still turns everything back on later;
4. the ``trial_paused`` audit row (actor ``trial-expiry``, kind ``schedule``, the lists);
5. each plugin turned off by the existing audited change (shared/workspace_plugin_settings.py ``set_trial_plugin``: its
   own ``plugin_disabled`` row, reason ``trial_paused``), and each form set ``enabled`` false (one conditional UpdateItem
   of ``enabled``, its save counter one up so an editor's stale copy cannot turn it on again, ``updated_at`` and
   ``updated_by``).

Nothing is deleted but the plugins' own ``PLUGIN#{plugin}`` / ``WS#{ws}`` rows, which ARE the existing disable (a
present row means enabled; the ingestors' tick fans out over them). No form, response, feedback item, project, file or
audit row is touched, and the workspace stays ``active``: reads and the export keep working.

The resume, ``resume`` (an extension or a conversion, the workspaces API, a platform admin): each plugin of
``trial.paused`` the deployment still offers turned back on (``plugin_enabled``, the platform admin's, reason the
route's) and each form of it set ``enabled`` true while it is still there and still off. An imported form is never live,
so it is never paused, and a form someone deleted meanwhile stays deleted.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.logging import logger
from shared.onboarding import forms_partition
from shared.timestamps import now_iso
from shared.trial_state import PAUSED, PAUSED_AT, at_second, is_paused
from shared.trials import TRIAL_PAUSED_KIND, audit_trial, expiry_of, is_converted, read_meta, save_trial
from shared.workspace import ACTIVE
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


def set_form_live(forms: WorkspaceTable, scope: WorkspaceScope, form_id: str, live: bool, actor: str, at: str) -> bool:
    """``enabled`` set to ``live`` on the form while it exists and is the other way; its save counter one up,
    ``updated_at`` and ``updated_by``. True when it changed, False when there was nothing to change."""
    try:
        forms.update_item(
            {'pk': forms_partition(scope), 'sk': f'{_FORM_PREFIX}{form_id}'},
            UpdateExpression=('SET #enabled = :to, #writes = if_not_exists(#writes, :zero) + :one, '
                              '#updated_at = :at, #updated_by = :actor'),
            ConditionExpression='attribute_exists(#sk) AND #enabled = :from',
            ExpressionAttributeNames={'#enabled': 'enabled', '#writes': 'write_count', '#updated_at': 'updated_at',
                                      '#updated_by': 'updated_by', '#sk': 'sk'},
            ExpressionAttributeValues={':to': live, ':from': not live, ':zero': 0, ':one': 1, ':at': at,
                                       ':actor': actor},
            ReturnValues='NONE')
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return False
        raise
    return True


def _union(first: Iterable[str], second: Iterable[str]) -> list[str]:
    return list(dict.fromkeys([*first, *second]))


def _enabled_plugins(tables: PauseTables, ws: str) -> list[str]:
    return [entry['id'] for entry in workspace_plugins(tables.workspaces, ws, tables.ceiling) if entry['enabled']]


def _due(meta: Mapping[str, Any], trial: object, now: datetime) -> str | None:
    """Why there is nothing to pause, or None when the trial is due."""
    if not isinstance(trial, Mapping):
        return NOT_A_TRIAL
    if meta.get('status') != ACTIVE:
        return NOT_ACTIVE
    if is_converted(trial):
        return CONVERTED
    expiry = expiry_of(trial)
    if expiry is not None and expiry > now:
        # An older schedule, run after an extension moved the end.
        return NOT_DUE
    return None


def pause(tables: PauseTables, ws: str, now: datetime) -> dict[str, Any]:
    """Pause trial ``ws`` if it is due (see the module docstring); what was done, ``outcome`` saying which case."""
    meta = read_meta(tables.workspaces, ws)
    trial = meta.get('trial')
    reason = _due(meta, trial, now)
    if reason is not None or not isinstance(trial, Mapping):
        return {'outcome': reason or NOT_A_TRIAL}
    trial = dict(trial)
    was_paused = is_paused(trial)
    if not was_paused:
        trial = save_trial(tables.workspaces, ws, meta, {**trial, PAUSED_AT: at_second(now)})
        meta = {**meta, 'trial': trial}
    scope = workspace_scope(ws)
    forms = tables.forms(scope)
    stored = trial.get(PAUSED)
    recorded: Mapping[str, Any] = stored if isinstance(stored, Mapping) else {}
    still_on, still_live = _enabled_plugins(tables, ws), live_forms(forms, scope)
    if was_paused and isinstance(stored, Mapping) and not still_on and not still_live:
        # A run again of a pause that finished (a retried invoke): nothing is on, so nothing is written.
        return {'outcome': ALREADY_PAUSED}
    plugins = _union(recorded.get('plugins') or [], still_on)
    live = _union(recorded.get('forms') or [], still_live)
    if recorded.get('plugins') != plugins or recorded.get('forms') != live:
        trial = save_trial(tables.workspaces, ws, meta, {**trial, PAUSED: {'plugins': plugins, 'forms': live}})
    at = audit_trial(tables.workspaces, ws, TRIAL_PAUSED_KIND, EXPIRY_ACTOR,
                {'actor_kind': EXPIRY_ACTOR_KIND, 'expires_at': trial.get('expires_at'), 'plugins': plugins,
                 'forms': live})
    actor = {'actor': EXPIRY_ACTOR, 'actor_kind': EXPIRY_ACTOR_KIND}
    plugins_off = sum(set_trial_plugin(tables.workspaces, ws, plugin, False, actor, TRIAL_PAUSED_KIND)
                      for plugin in plugins)
    forms_off = sum(set_form_live(forms, scope, form_id, False, EXPIRY_ACTOR, at) for form_id in live)
    logger.info('Trial paused', extra={'workspace_id': ws, 'plugins': plugins_off, 'forms': forms_off})
    return {'outcome': PAUSED_NOW, 'plugins': plugins_off, 'forms': forms_off}


def resume(tables: PauseTables, ws: str, trial: Mapping[str, Any], actor: str, reason: str) -> dict[str, int]:
    """Turn back on what the pause recorded (see the module docstring): each plugin the deployment still offers, each
    form still there and still off, as ``actor`` (a platform admin) for ``reason``; how many of each were turned on."""
    stored = trial.get(PAUSED)
    recorded: Mapping[str, Any] = stored if isinstance(stored, Mapping) else {}
    offered = set(workspace_ceiling(tables.ceiling))
    plugins = [plugin for plugin in recorded.get('plugins') or [] if isinstance(plugin, str) and plugin in offered]
    form_ids = [form for form in recorded.get('forms') or [] if isinstance(form, str)]
    who = {'actor': actor, 'platform_admin': True}
    plugins_on = sum(set_trial_plugin(tables.workspaces, ws, plugin, True, who, reason) for plugin in plugins)
    scope = workspace_scope(ws)
    forms = tables.forms(scope)
    at = now_iso()
    forms_on = sum(set_form_live(forms, scope, form_id, True, actor, at) for form_id in form_ids)
    logger.info('Trial resumed', extra={'workspace_id': ws, 'plugins': plugins_on, 'forms': forms_on})
    return {'plugins': plugins_on, 'forms': forms_on}
