"""Readiness on any public repository (7.57.00, engineering/readiness.py): a read-only connection fails a flow that
pushes and passes one that reads; a fork's checks (the fork itself, the owner's authorization, the upstream pull
request under the runs' way of working) answer for a fork alone, and none of them blocks Enable."""
from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from engineering.readiness import REQUIRED, ReadFailed, evaluate, flow_requires
from engineering.test.test_readiness import ROW, SETTINGS, SUBJECT, TRIAGE_FLOW, Ports, checks

PUBLIC_ROW = {**ROW, 'connection_kind': 'public_read', 'credential_kind': 'public_read'}
FORK_ROW = {**ROW, 'connection_kind': 'fork', 'upstream': 'upstream-org/shop', 'owner_subject': 'owner-sub',
            'owner_name': 'casey', 'licence': 'MIT', 'upstream_pr_assisted': False}
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
    assert {found[name].status for name in ('fork', 'user_authorization', 'upstream_pr')} == {'pass'}
    assert all('not a fork' in found[name].detail for name in ('fork', 'user_authorization', 'upstream_pr'))
    assert not {'fork', 'user_authorization', 'upstream_pr'} & REQUIRED


def test_a_set_up_fork_passes_its_checks() -> None:
    ports = Ports(rows={'shop': FORK_ROW}, modes={'admin-sub': 'ai_driven'})
    found = checks(ports=ports)
    assert (found['fork'].status, found['user_authorization'].status, found['upstream_pr'].status) == (
        'pass', 'pass', 'pass')
    assert 'authorized 123 owner-sub' in ports.asked
    assert 'pull request on upstream-org/shop' in found['upstream_pr'].detail
    assert 'a fork of upstream-org/shop' in found['connection'].detail


@pytest.mark.parametrize(('parent', 'status'), [('', 'fail'), (None, 'fail'), ('someone/else', 'fail'),
                                                (ReadFailed('no'), 'unknown')])
def test_a_fork_that_is_no_longer_one_fails(parent: Any, status: str) -> None:
    assert checks(ports=Ports(rows={'shop': FORK_ROW}, parent=parent))['fork'].status == status


def test_a_missing_authorization_is_advice_the_run_ends_with_the_one_click_link() -> None:
    ports = Ports(rows={'shop': FORK_ROW}, authorized=False)
    found = checks(ports=ports)
    assert found['user_authorization'].status == 'warn'
    assert 'one-click link' in found['user_authorization'].detail
    assert 'Authorize as me' in found['user_authorization'].fix
    assert evaluate(SUBJECT, ports, SETTINGS).ready


@pytest.mark.parametrize(('mode', 'assisted', 'status'), [
    ('ai_assisted', False, 'warn'), ('ai_assisted', True, 'pass'), ('human_driven', True, 'warn'), ('', True, 'warn'),
])
def test_the_upstream_pull_request_follows_the_way_of_working_and_the_owners_setting(mode: str, assisted: bool,
                                                                                       status: str) -> None:
    ports = Ports(rows={'shop': {**FORK_ROW, 'upstream_pr_assisted': assisted}}, modes={'admin-sub': mode})
    assert checks(ports=ports)['upstream_pr'].status == status
