"""Feedback forms in a paused trial workspace (7.71.00; shared/trial_state.py, docs/multi-workspace.md "Trial
workspaces"): no form is put live there (a create or a save with ``enabled: true`` is a 409 ``trial_paused``) until a
platform admin extends or converts the trial; every other save works, and another workspace is not affected."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from test_feedback_form_workspace import (
    EDITOR,
    FORM_A,
    FORM_B,
    MEMBER_B,
    WS_A,
    WS_B,
    _call,
    _form,
    _present,
    _stored,
    form_tables,
    wire_form_handler,
)

from shared.test.source_profile_fixtures import no_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

PAUSED_TRIAL = {'rev': 2, 'days': 30, 'expires_at': '2026-11-01T09:00:00+00:00', 'paused_at': '2026-11-01T09:00:05+00:00',
                'paused': {'plugins': [], 'forms': [FORM_A]}}


@pytest.fixture
def world() -> Iterator[dict[str, Any]]:
    with form_tables() as (stack, aggregates, feedback, workspaces):
        workspaces.put_item(Item={'pk': f'WS#{WS_A}', 'sk': 'META', 'status': 'active', 'name': 'Trial', 'slug': 'trial',
                                  'trial': PAUSED_TRIAL})
        workspaces.put_item(Item={'pk': f'WS#{WS_B}', 'sk': 'META', 'status': 'active', 'name': 'B', 'slug': 'b'})
        workspaces.put_item(Item={'pk': f'WS#{WS_A}', 'sk': f"MEMBER#{EDITOR['sub']}", 'role': 'editor'})
        workspaces.put_item(Item={'pk': f'WS#{WS_B}', 'sk': f"MEMBER#{MEMBER_B['sub']}", 'role': 'admin'})
        for ws, form_id in ((WS_A, FORM_A), (WS_B, FORM_B)):
            aggregates.put_item(Item={**_form(f'WS#{ws}#FEEDBACK_FORM', form_id, 'Workshop'), 'enabled': False})
            workspaces.put_item(Item={'pk': f'FORM#{form_id}', 'sk': 'META', 'workspace_id': ws, 'created_at': 'x'})
        yield wire_form_handler(stack, {'aggregates': aggregates, 'feedback': feedback, 'workspaces': workspaces})


def test_a_form_is_not_put_live_in_a_paused_trial(world, lambda_context):
    status, body = _call(lambda_context, 'PUT', f'/feedback-forms/{FORM_A}', claims=EDITOR, ws=WS_A,
                         body={'enabled': True}, form_id=FORM_A)
    assert (status, body['code']) == (409, 'trial_paused')
    assert _present(_stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_A))['enabled'] is False
    status, body = _call(lambda_context, 'POST', '/feedback-forms', claims=EDITOR, ws=WS_A,
                         body={'name': 'New', 'enabled': True})
    assert (status, body['code']) == (409, 'trial_paused')


def test_every_other_save_still_works_there(world, lambda_context):
    status, _ = _call(lambda_context, 'PUT', f'/feedback-forms/{FORM_A}', claims=EDITOR, ws=WS_A,
                      body={'name': 'Renamed while paused'}, form_id=FORM_A)
    assert status == 200
    assert _present(_stored(world, f'WS#{WS_A}#FEEDBACK_FORM', FORM_A))['name'] == 'Renamed while paused'
    status, _ = _call(lambda_context, 'POST', '/feedback-forms', claims=EDITOR, ws=WS_A, body={'name': 'Draft'})
    assert status == 200


def test_another_workspace_is_not_affected(world, lambda_context):
    status, _ = _call(lambda_context, 'PUT', f'/feedback-forms/{FORM_B}', claims=MEMBER_B, ws=WS_B,
                      body={'enabled': True}, form_id=FORM_B)
    assert status == 200
    assert _present(_stored(world, f'WS#{WS_B}#FEEDBACK_FORM', FORM_B))['enabled'] is True
