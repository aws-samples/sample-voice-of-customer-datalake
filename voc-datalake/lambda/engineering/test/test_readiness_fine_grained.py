"""Readiness on a fine-grained connection (7.60.00, engineering/readiness.py): the connection pushed with its owner's
token after their go, the App installation not needed on the repository (only that the deployment's still exists), the
``write_token`` check's days left (a warning at 14 or fewer, a failure when expired or unset), the dial saying every
push waits for the token owner's go, and a flow that pushes refused on an expired token."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from datetime import date

import pytest

from engineering.readiness import CHECK_IDS, REQUIRED, Check, ReadFailed, Settings, Subject, evaluate, flow_requires
from engineering.test.test_readiness import ROW, SETTINGS, SUBJECT, TRIAGE_FLOW, Ports

TODAY = date(2026, 11, 20)
ON_TODAY: Settings = replace(SETTINGS, today=TODAY)


def token_row(expires: str | None = '2027-01-31', **change: object) -> dict[str, object]:
    return {**ROW, 'connection_kind': 'fine_grained', 'credential_kind': 'fine_grained_token', 'credential_set': True,
            'repository_private': False, 'token_login': 'casey-dev', 'token_expires_at': expires, **change}


def report(row: Mapping[str, object], ports: Ports | None = None, subject: Subject = SUBJECT) -> dict[str, Check]:
    found = ports or Ports(rows={'shop': row}, covered=(frozenset({'example-org/other'}), False))
    return {check.id: check for check in evaluate(subject, found, ON_TODAY).checks}


def test_the_write_token_check_sits_after_the_app_installation_and_is_not_required() -> None:
    assert CHECK_IDS.index('write_token') == CHECK_IDS.index('app_installation') + 1
    assert 'write_token' not in REQUIRED


def test_a_token_connection_is_ready_pushed_with_its_owner_s_token_after_their_go() -> None:
    checks = report(token_row())
    connection, installation, token, dial = (checks[name] for name in ('connection', 'app_installation', 'write_token',
                                                                         'dial'))
    assert (connection.status, "casey-dev's fine-grained token: a branch and a pull request after your go" in
            connection.detail) == ('pass', True)
    assert (installation.status, installation.detail) == (
        'pass', "Not needed: read with this deployment's GitHub App's read-only token.")
    assert (token.status, 'expires in 72 days' in token.detail, 'first push confirms' in token.detail) == (
        'pass', True, True)
    assert dial.status == 'pass'
    assert "every push waits for casey-dev's go" in dial.detail
    assert all(check.docs.endswith('#a-fine-grained-token-76000') for check in (connection, installation, token))


@pytest.mark.parametrize(('expires', 'status', 'words'), [
    ('2026-12-04', 'warn', 'expires in 14 days'), ('2026-11-21', 'warn', 'expires in 1 day.'),
    ('2026-12-05', 'pass', 'expires in 15 days'), ('2026-11-20', 'fail', 'expired on 2026-11-20'),
    (None, 'fail', 'not set'), ('not-a-day', 'fail', 'not set'),
])
def test_the_token_s_days_left_warn_at_fourteen_and_fail_once_expired(expires: str | None, status: str,
                                                                       words: str) -> None:
    check = report(token_row(expires))['write_token']
    assert (check.status, words in check.detail) == (status, True)
    assert ('Replace token' in check.fix) is (status != 'pass')


def test_an_expired_or_unset_token_fails_the_connection_of_a_flow_that_pushes_and_blocks_enable() -> None:
    for row in (token_row('2026-11-01'), token_row(credential_set=False)):
        result = evaluate(SUBJECT, Ports(rows={'shop': row}), ON_TODAY)
        failing = {check.id for check in result.failing}
        assert 'connection' in failing
        assert not result.ready


def test_a_flow_that_pushes_nothing_needs_no_live_token() -> None:
    triage = replace(SUBJECT, definition=TRIAGE_FLOW, requires=flow_requires(TRIAGE_FLOW))
    assert report(token_row('2026-11-01'), subject=triage)['connection'].status == 'pass'


def test_a_token_warning_never_blocks_enable() -> None:
    result = evaluate(SUBJECT, Ports(rows={'shop': token_row('2026-11-25')}), ON_TODAY)
    assert result.ready
    assert {check.id: check.status for check in result.checks}['write_token'] == 'warn'


def test_the_deployment_s_app_installation_gone_fails_and_unreadable_is_unknown() -> None:
    gone = report(token_row(), Ports(rows={'shop': token_row()}, covered=(frozenset(), False)))
    assert gone['app_installation'].status == 'fail'
    unread = report(token_row(), Ports(rows={'shop': token_row()}, covered=ReadFailed('throttled')))
    assert unread['app_installation'].status == 'unknown'


def test_another_kind_of_connection_needs_no_write_token() -> None:
    check = report(ROW, Ports())['write_token']
    assert (check.status, 'no token of a person' in check.detail) == ('pass', True)


def test_settings_read_today_from_the_clock_unless_given() -> None:
    assert ON_TODAY.day() == TODAY
    assert isinstance(SETTINGS.day(), date)
