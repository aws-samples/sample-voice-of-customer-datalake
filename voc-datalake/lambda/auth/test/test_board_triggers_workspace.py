"""The board pool's PreSignUp trigger and a review link kept in a workspace (docs/multi-workspace.md, the project plan,
3e; 7.35.00).

A link made in a workspace is that workspace's own row, and its ``DOCSHARE#{id}`` row only routes to it
(``workspace_id``). The trigger reads the ``DOCSHARE#`` row as before and resolves the workspace from it; a routing
row is refused (``REVIEWER_ROUTES_STORE``, as the reviewer routes refuse it) until the switch gives the trigger the
workspace's status check, and nothing of the workspace is read. A routing row naming anything but a workspace id
admits nobody either, and a routing row is never itself read as a link. A deployment's link sends the one GetItem it
always sent.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import pytest
from moto import mock_aws

from auth import board_triggers
from shared.participants_settings import SETTINGS_KEY
from shared.review_share_audience import REVIEWER_ROUTES_STORE, share_key
from shared.test.moto_tables import create_pk_sk_table

SHARE_ID = 'shr_' + 'a' * 32
WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
REVIEWER = 'reviewer@elsewhere.example'
ANYONE = {'mode': 'anyone', 'domains': [], 'emails': []}


@pytest.fixture
def projects(monkeypatch):
    """voc-projects and voc-participants (whose settings admit only the company domain), in one moto context."""
    monkeypatch.setenv('PARTICIPANTS_TABLE', 'participants')
    monkeypatch.setenv('PROJECTS_TABLE', 'projects')
    with mock_aws():
        create_pk_sk_table('participants').put_item(Item={**SETTINGS_KEY, 'company_domains': ['example.com']})
        table = create_pk_sk_table('projects')
        monkeypatch.setattr(board_triggers, '_table', None)
        monkeypatch.setattr(board_triggers, '_projects', None)
        yield table
    monkeypatch.setattr(board_triggers, '_table', None)
    monkeypatch.setattr(board_triggers, '_projects', None)


@pytest.fixture
def reads(projects, monkeypatch) -> list[dict[str, Any]]:
    """Every GetItem the trigger sends to voc-projects, in order (each still answered by the table)."""
    calls: list[dict[str, Any]] = []

    class Recording:
        def get_item(self, **request: Any) -> dict:
            calls.append(request)
            return projects.get_item(**request)

    monkeypatch.setattr(board_triggers, 'get_projects_table', Recording)
    return calls


def _link(**extra: Any) -> dict[str, Any]:
    return {'share_id': SHARE_ID, 'revoked': False, 'expires_at_epoch': int(time.time()) + 3600, 'audience': ANYONE,
            **extra}


def _admitted(email: str = REVIEWER) -> bool:
    event = {'triggerSource': 'PreSignUp_SignUp', 'response': {},
             'request': {'userAttributes': {'email': email}, 'clientMetadata': {'share_id': SHARE_ID}}}
    try:
        board_triggers.pre_sign_up_handler(event, None)
    except board_triggers.SignUpRefusedError:
        return False
    return True


def test_a_routing_row_is_resolved_and_refused_until_the_switch(projects, reads, caplog):
    """The route names a real workspace holding a live link of this id: refused under the reviewer routes' store,
    and the workspace's link is never read."""
    projects.put_item(Item={**share_key(SHARE_ID), 'workspace_id': WS_A, 'routed_at': 'x'})
    projects.put_item(Item={'pk': f'WS#{WS_A}#DOCSHARE#{SHARE_ID}', 'sk': 'META', **_link()})
    with caplog.at_level(logging.INFO):
        assert not _admitted()
    assert reads == [{'Key': share_key(SHARE_ID), 'ConsistentRead': True}]
    assert f'{REVIEWER_ROUTES_STORE} is not per workspace yet' in caplog.text


@pytest.mark.parametrize('workspace_id', ['ws_bad', '', 'WS#' + WS_A, f'{WS_A}#x', 7, None])
def test_a_routing_row_naming_no_workspace_id_admits_nobody(projects, workspace_id):
    """Malformed: refused, and never read as the deployment's link (the row carries an audience of its own here)."""
    projects.put_item(Item={**share_key(SHARE_ID), 'workspace_id': workspace_id, **_link()})
    assert not _admitted()


def test_a_routing_row_is_never_itself_admitted_as_a_link(projects):
    projects.put_item(Item={**share_key(SHARE_ID), 'workspace_id': WS_A, **_link()})
    assert not _admitted()


def test_a_deployments_link_sends_the_one_get_it_always_sent(projects, reads):
    projects.put_item(Item={**share_key(SHARE_ID), **_link()})
    assert _admitted()
    assert reads == [{'Key': share_key(SHARE_ID), 'ConsistentRead': True}]
