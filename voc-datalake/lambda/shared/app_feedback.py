"""In-app micro-feedback's settings (7.66.00, docs/micro-feedback.md): which feedback form receives the thumbs the SPA
shows after its key actions, whether they are shown, and after which actions. The routes are
shared/app_feedback_routes.py.

One row per scope in voc-aggregates, as every settings kind: ``SETTINGS#app_feedback`` / ``config`` for the
deployment, ``WS#{ws}#SETTINGS#app_feedback`` / ``config`` in a workspace (shared/workspace_settings.py, through
shared/workspace_config.py): ``{form_id, enabled, actions, updated_by: {sub, kind}, updated_at, reason}`` (D4: who,
when and why). No row: off (owner decision: off by default).

The form is a normal feedback form of the same scope, never a new pipeline: the SPA posts the response to the form's
public submit route (``POST /feedback-forms/{id}/submit``), so the forms' validation, throttles and access rules apply
as to any respondent, and the response is enriched like any other. Its fitness (``form_problems``) is what the control
sends: the single choice ``q_verdict`` with the codes ``up`` and ``down`` (a choice, never a rating, so it moves no
average), the open text ``q_missing``, the hidden fields ``action``, ``page``, ``app_version`` and ``workspace_role``
(ids only, never personal data), and the tag ``voc_app`` (shared/app_feedback_tag.py: what keeps the responses out of
the dashboards). The "In-app micro-feedback" template makes such a form (frontend/src/pages/FeedbackForms/templates/
appTemplates.ts). A form that is Off is kept but not ``active``: the control shows only while the form takes answers.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final

from shared import forms_v2 as fv2
from shared.app_feedback_tag import APP_FEEDBACK_TAG
from shared.exceptions import ValidationError
from shared.request_body import require_known_change

__all__ = ['APP_FEEDBACK_KIND', 'BLOCKING', 'DEPLOYMENT_KEY', 'REASON', 'config_view', 'form_problems', 'merged_config',
           'validate_changes']

#: The settings kind (``WS#{ws}#SETTINGS#app_feedback``) and the deployment's row.
APP_FEEDBACK_KIND: Final = 'app_feedback'
DEPLOYMENT_KEY: Final = {'pk': 'SETTINGS#app_feedback', 'sk': 'config'}
#: The key actions the control follows, in the Settings card's order.
ACTIONS: Final = ('personas', 'research', 'prfaq', 'prd', 'prototype', 'form_draft', 'import', 'engineering_run')
#: What the control sends, and so what the chosen form must hold.
VERDICT_QUESTION: Final = 'q_verdict'
VERDICT_CODES: Final = ('up', 'down')
MISSING_QUESTION: Final = 'q_missing'
HIDDEN_FIELDS: Final = ('action', 'page', 'app_version', 'workspace_role')
#: Why the row was written (TENETS.md D4).
REASON: Final = 'app_feedback_settings'
_FORM_ID: Final = re.compile(r'(?!\.{1,2}\Z)[0-9A-Za-z_.-]{1,64}')
_FIELDS: Final = ('enabled', 'form_id', 'actions')

# The problems a chosen form can have (the Settings card words each one).
NOT_TAGGED: Final = 'not_tagged'
NO_VERDICT: Final = 'no_verdict'
NO_MISSING: Final = 'no_missing'
HIDDEN_MISSING: Final = 'hidden_fields'
FORM_OFF: Final = 'form_off'
#: The problems that refuse a save (a form that is Off may be chosen and turned on later).
BLOCKING: Final = frozenset({NOT_TAGGED, NO_VERDICT, NO_MISSING, HIDDEN_MISSING})


def validate_changes(body: Mapping[str, Any]) -> dict[str, Any]:
    """The fields a ``PUT /settings/app-feedback`` changes: ``enabled`` (a boolean), ``form_id`` (a form id, or null to
    clear it), ``actions`` (a list of ``ACTIONS``, at least one, each once). 400 on anything else or nothing."""
    require_known_change(dict(body), _FIELDS)
    changes: dict[str, Any] = {}
    if 'enabled' in body:
        if not isinstance(body['enabled'], bool):
            raise ValidationError('enabled must be true or false')
        changes['enabled'] = body['enabled']
    if 'form_id' in body:
        form_id = body['form_id']
        if form_id is not None and not (isinstance(form_id, str) and _FORM_ID.fullmatch(form_id)):
            raise ValidationError('form_id must be a feedback form id, or null')
        changes['form_id'] = form_id
    if 'actions' in body:
        actions = body['actions']
        if (not isinstance(actions, list) or not actions or len(actions) > len(ACTIONS)
                or any(not isinstance(action, str) or action not in ACTIONS for action in actions)
                or len(set(actions)) != len(actions)):
            raise ValidationError(f"actions must list at least one of: {', '.join(ACTIONS)}, each once")
        changes['actions'] = [action for action in ACTIONS if action in actions]
    return changes


def _stored_actions(row: Mapping[str, Any]) -> list[str]:
    raw = row.get('actions')
    if not isinstance(raw, list):
        return list(ACTIONS)
    kept = [action for action in ACTIONS if action in raw]
    return kept or list(ACTIONS)


def _stored_form_id(row: Mapping[str, Any]) -> str | None:
    raw = row.get('form_id')
    return raw if isinstance(raw, str) and _FORM_ID.fullmatch(raw) else None


def merged_config(row: Mapping[str, Any], changes: Mapping[str, Any]) -> dict[str, Any]:
    """The settings after ``changes`` apply to the stored ``row`` (``{}``: none saved): ``{enabled, form_id,
    actions}``. Turning it on needs a form (400)."""
    merged = {'enabled': row.get('enabled') is True, 'form_id': _stored_form_id(row), 'actions': _stored_actions(row),
              **changes}
    if merged['enabled'] and merged['form_id'] is None:
        raise ValidationError('Choose the feedback form that receives the micro-feedback before turning it on',
                              code='app_feedback_form_required')
    return merged


def _question(definition: Mapping[str, Any], question_id: str) -> Mapping[str, Any] | None:
    found = [q for q in definition.get('questions') or [] if isinstance(q, Mapping) and q.get('id') == question_id]
    return found[0] if found else None


def _tags(form: Mapping[str, Any]) -> set[str]:
    raw = fv2.plain(form.get('tags'))
    return {tag.strip().casefold() for tag in raw if isinstance(tag, str)} if isinstance(raw, list) else set()


def form_problems(form: Mapping[str, Any]) -> list[str]:
    """What keeps ``form`` (its stored row) from receiving the control's responses, in a stable order: not tagged
    ``voc_app``; no single-choice ``q_verdict`` with the codes up and down; no open-text ``q_missing``; a hidden field
    the control sends that the form does not declare; the form is Off. ``[]``: fit and on."""
    problems: list[str] = []
    if APP_FEEDBACK_TAG not in _tags(form):
        problems.append(NOT_TAGGED)
    definition = fv2.definition_of(form)
    verdict = _question(definition, VERDICT_QUESTION)
    codes = {option.get('code') for option in (verdict or {}).get('options') or [] if isinstance(option, Mapping)}
    if verdict is None or verdict.get('type') != fv2.SINGLE or not set(VERDICT_CODES) <= codes:
        problems.append(NO_VERDICT)
    missing = _question(definition, MISSING_QUESTION)
    if missing is None or missing.get('type') != fv2.OPEN_TEXT:
        problems.append(NO_MISSING)
    declared = {field.get('id') for field in definition.get('hidden_fields') or [] if isinstance(field, Mapping)}
    if not set(HIDDEN_FIELDS) <= declared:
        problems.append(HIDDEN_MISSING)
    if form.get('enabled') is not True:
        problems.append(FORM_OFF)
    return problems


def _form_view(form_id: str, form: Mapping[str, Any] | None) -> dict[str, Any]:
    """What the SPA needs of the chosen form: its name, whether it is on, its languages (the control sends the app's
    language only when the form has it) and its problems; ``found: false`` once it was deleted."""
    if form is None:
        return {'form_id': form_id, 'found': False, 'name': None, 'enabled': False, 'languages': [], 'problems': []}
    definition = fv2.definition_of(form)
    languages = [lang for lang in definition.get('languages') or [] if isinstance(lang, str)]
    name = form.get('name')
    return {'form_id': form_id, 'found': True, 'name': name if isinstance(name, str) else '',
            'enabled': form.get('enabled') is True, 'languages': languages, 'problems': form_problems(form)}


def config_view(row: Mapping[str, Any], form: Mapping[str, Any] | None) -> dict[str, Any]:
    """The ``GET /settings/app-feedback`` body: ``{enabled, form_id, actions, updated_at, tag, form, active}``.
    ``active``: on, its form found, fit and on, so the SPA shows the control (never who saved it: a member reads
    this)."""
    form_id = _stored_form_id(row)
    form_view = _form_view(form_id, form) if form_id is not None else None
    enabled = row.get('enabled') is True
    updated_at = row.get('updated_at')
    active = (enabled and form_view is not None and form_view['found'] and not form_view['problems'])
    return {'enabled': enabled, 'form_id': form_id, 'actions': _stored_actions(row),
            'updated_at': updated_at if isinstance(updated_at, str) else None, 'tag': APP_FEEDBACK_TAG,
            'form': form_view, 'active': active}
