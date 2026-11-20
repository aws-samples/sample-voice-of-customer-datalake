"""Readiness on any public repository (7.57.00, engineering/readiness.py): a read-only connection fails a flow that
pushes and passes one that reads; a fork's checks (the fork itself, its upstream pull request one click away) answer
for a fork alone, and neither blocks Enable (7.58.00: no owner's authorization, the app never opens it itself)."""
from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from engineering.readiness import REQUIRED, ReadFailed, evaluate, flow_requires
from engineering.test.test_readiness import ROW, SETTINGS, SUBJECT, TRIAGE_FLOW, Ports, checks

PUBLIC_ROW = {**ROW, 'connection_kind': 'public_read', 'credential_kind': 'public_read'}
FORK_ROW = {**ROW, 'connection_kind': 'fork', 'upstream': 'upstream-org/shop', 'owner_subject': 'owner-sub',
            'owner_name': 'casey', 'licence': 'MIT'}
TRIAGE = replace(SUBJECT, definition=TRIAGE_FLOW, requires=flow_requires(TRIAGE_FLOW), trigger=None)


def test_a_read_only_connection_fails_a_flow_that_pushes_and_blocks_enable() -> None:
    found = checks(ports=Ports(rows={'shop': PUBLIC_ROW}))
    assert found['connection'].status == 'fail'
    assert 'read only' in found['connection'].detail
    assert 'Contribute card' in found['connection'].fix
    assert not evaluate(SUBJECT, Ports(rows={'shop': PUBLIC_ROW}), SETTINGS).ready


def test_a_read_only_connection_passes_a_flow_that_reads_saying_what_stays_in_voc() -> None:
    found = checks(TRIAGE, Ports(rows={'shop': PUBLIC_ROW}))
    assert found['connection'].status == 'pass'
    assert 'stays in VoC' in found['connection'].detail


def test_the_fork_checks_are_not_needed_off_a_fork() -> None:
    found = checks()
    assert {found[name].status for name in ('fork', 'upstream_pr')} == {'pass'}
    assert all('not a fork' in found[name].detail for name in ('fork', 'upstream_pr'))
    assert not {'fork', 'upstream_pr'} & REQUIRED
    assert 'user_authorization' not in found   # (7.58.00: gone with the app's own upstream pull request)


@pytest.mark.parametrize('mode', ['ai_driven', 'ai_assisted', 'human_driven', ''])
def test_a_set_up_fork_passes_its_checks_its_pull_request_one_click_away_whatever_the_way_of_working(mode: str) -> None:
    found = checks(ports=Ports(rows={'shop': FORK_ROW}, modes={'admin-sub': mode}))
    assert (found['fork'].status, found['upstream_pr'].status) == ('pass', 'pass')
    assert found['upstream_pr'].detail == ('A run ends with its pull request on upstream-org/shop one click away once the '
                                           'gate passes (licence MIT acknowledged): you create it on GitHub.')
    assert 'a fork of upstream-org/shop' in found['connection'].detail


def test_a_flow_that_pushes_nothing_needs_no_upstream_pull_request() -> None:
    found = checks(TRIAGE, Ports(rows={'shop': FORK_ROW}))
    assert found['upstream_pr'].detail.startswith('Not needed: the flow pushes nothing')


@pytest.mark.parametrize(('parent', 'status'), [('', 'fail'), (None, 'fail'), ('someone/else', 'fail'),
                                                (ReadFailed('no'), 'unknown')])
def test_a_fork_that_is_no_longer_one_fails(parent: Any, status: str) -> None:
    assert checks(ports=Ports(rows={'shop': FORK_ROW}, parent=parent))['fork'].status == status


def test_a_read_only_connection_needs_no_app_installation_on_the_public_repository() -> None:
    # (Q23, 7.58.00) It is read with the deployment's App token that names no repository.
    # (no installation is read: a read would answer unknown here)
    found = checks(TRIAGE, Ports(rows={'shop': PUBLIC_ROW}, covered=ReadFailed('not read')))['app_installation']
    assert found.status == 'pass'
    assert found.detail == ("Not needed: a public repository connected read only is read with this deployment's GitHub "
                            'App, which needs no installation on it.')

