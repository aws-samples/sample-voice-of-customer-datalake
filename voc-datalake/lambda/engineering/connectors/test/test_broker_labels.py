"""The broker's ``label_issue`` (7.50.00): the understander's triage labels on its run's own issue, the allowlist only,
once per attempt, no dial; and each writer's writes, pinned."""
from __future__ import annotations

import json
from dataclasses import replace

import pytest

from engineering.connectors.broker import (
    LABEL_ISSUE,
    OPEN_OR_UPDATE_DRAFT_PR,
    POST_COMMENT,
    PUSH_BUNDLE,
    READ,
    Broker,
    NotNow,
    NotPermitted,
    permitted,
)
from engineering.connectors.handler import handle
from engineering.connectors.hosts import WRITE_UNKNOWN, OutcomeUnknown, WriteClaim
from engineering.connectors.identity import AGENT_ROLES, Caller
from engineering.connectors.test.fakes import (
    ACCOUNT,
    PATTERN,
    RUN,
    FakeDial,
    FakeHost,
    FakeRuns,
    FakeWrites,
    connector,
    record,
    role_arn,
    url_event,
)
from engineering.connectors.write_policy import WriteRefused
from engineering.runtime.outputs import TRIAGE_LABELS

UNDERSTANDER = Caller(role='understander', run_id=RUN, agent_index=1)
LABELS = ('voc-triage/bug', 'voc-severity/s2')


def broker(host: FakeHost | None = None, **kwargs: object) -> tuple[Broker, FakeHost]:
    host = host or FakeHost()
    return Broker(connector(host=host, **kwargs)), host   # type: ignore[arg-type]


def test_the_understander_labels_its_runs_issue_with_the_triage_labels() -> None:
    labeller, host = broker()
    assert labeller.label_issue(UNDERSTANDER, 42, LABELS) == LABELS
    assert host.calls[-1] == ('label_issue', 'conn-1', 42, LABELS)


@pytest.mark.parametrize('role', sorted(AGENT_ROLES - {'understander'}))
def test_no_other_role_labels_an_issue(role: str) -> None:
    labeller, host = broker()
    with pytest.raises(NotPermitted, match=f'The {role} role may not label issue.'):
        labeller.label_issue(Caller(role=role, run_id=RUN, agent_index=1), 42, LABELS)
    assert host.writes() == []


def test_only_the_runs_own_issue_is_labelled() -> None:
    labeller, host = broker()
    with pytest.raises(NotPermitted, match="own run's issue"):
        labeller.label_issue(UNDERSTANDER, 43, LABELS)
    labeller, host = broker(runs=FakeRuns({RUN: record(issue_number=None)}))
    with pytest.raises(NotPermitted, match="own run's issue"):
        labeller.label_issue(UNDERSTANDER, 42, LABELS)
    assert host.writes() == []


@pytest.mark.parametrize('labels', [
    ('bug',), ('voc-triage/chore',), ('voc-severity/s5',), ('voc-agent',), (),
    ('voc-triage/bug', 'voc-triage/feature'), ('voc-severity/s1', 'voc-severity/s2'),
    ('voc-triage/bug', 'voc-severity/s1', 'voc-severity/s2'),
])
def test_a_label_outside_the_allowlist_or_two_of_one_kind_is_refused(labels: tuple[str, ...]) -> None:
    labeller, host = broker()
    with pytest.raises(WriteRefused):
        labeller.label_issue(UNDERSTANDER, 42, labels)
    assert host.writes() == []


def test_one_label_alone_is_enough_and_a_repeated_label_is_asked_once() -> None:
    labeller, host = broker()
    assert labeller.label_issue(UNDERSTANDER, 42, ('voc-severity/s1', 'voc-severity/s1')) == ('voc-severity/s1',)
    assert host.calls[-1] == ('label_issue', 'conn-1', 42, ('voc-severity/s1',))


@pytest.mark.parametrize('status', ['stopped', 'needs_human', 'done'])
def test_an_inactive_run_labels_nothing(status: str) -> None:
    labeller, host = broker(runs=FakeRuns({RUN: record(status=status)}))
    with pytest.raises(NotNow):
        labeller.label_issue(UNDERSTANDER, 42, LABELS)
    assert host.writes() == []


def test_no_dial_and_no_ci_check_hold_a_label() -> None:
    # A Human-driven starter, an unattested run: a label changes no code, so neither is read.
    dial = FakeDial({'person-sub-1': 'human_driven'})
    labeller, host = broker(dial=dial, runs=FakeRuns({RUN: record(ci_attested=False)}))
    assert labeller.label_issue(UNDERSTANDER, 42, LABELS) == LABELS
    assert dial.asked == []
    assert host.ci_checks == []


def test_a_repeat_answers_the_first_outcome_and_labels_once() -> None:
    writes = FakeWrites()
    labeller, host = broker(writes=writes)
    labeller.label_issue(UNDERSTANDER, 42, LABELS, attempt=2)
    assert labeller.label_issue(UNDERSTANDER, 42, LABELS, attempt=2) == LABELS
    assert host.writes() == ['label_issue']
    # Even once the run has moved on (the first outcome stands).
    moved = Broker(connector(host=host, runs=FakeRuns({RUN: record(status='done')}), writes=writes))
    assert moved.label_issue(UNDERSTANDER, 42, LABELS, attempt=2) == LABELS
    assert host.writes() == ['label_issue']


def test_a_repeat_of_a_label_whose_outcome_is_unknown_is_never_made_again() -> None:
    writes = FakeWrites()
    labeller, host = broker(writes=writes)
    labeller.label_issue(UNDERSTANDER, 42, LABELS)
    key = next(iter(writes.claims))
    writes.claims[key] = WriteClaim(WRITE_UNKNOWN)
    with pytest.raises(OutcomeUnknown):
        labeller.label_issue(UNDERSTANDER, 42, LABELS)
    assert host.writes() == ['label_issue']


def test_each_writer_keeps_its_writes_and_no_more() -> None:
    writes = {role: {op for op in (POST_COMMENT, LABEL_ISSUE, PUSH_BUNDLE, OPEN_OR_UPDATE_DRAFT_PR)
                     if permitted(role, op)} for role in AGENT_ROLES}
    assert {role: ops for role, ops in writes.items() if ops} == {
        'understander': {POST_COMMENT, LABEL_ISSUE}, 'pr-reviewer': {POST_COMMENT}, 'committer': {PUSH_BUNDLE},
        'pr-author': {OPEN_OR_UPDATE_DRAFT_PR}}
    assert all(permitted(role, READ) for role in AGENT_ROLES)
    assert set(LABELS) <= TRIAGE_LABELS


def _call(args: object, role: str = 'understander') -> dict[str, object]:
    event = url_event(role_arn(role), {'operation': LABEL_ISSUE, 'args': args})
    return handle(event, PATTERN, ACCOUNT, Broker(connector()))


def test_the_function_url_takes_a_label_request_and_answers_its_labels() -> None:
    answer = _call({'number': 42, 'labels': list(LABELS), 'attempt': 1})
    assert answer['statusCode'] == 200
    assert json.loads(str(answer['body'])) == {'result': {'number': 42, 'labels': list(LABELS)}}
    assert _call({'number': 42, 'labels': list(LABELS)}, role='pr-reviewer')['statusCode'] == 403
    assert _call({'number': 42, 'labels': ['voc-agent']})['statusCode'] == 422


@pytest.mark.parametrize('args', [
    {'number': 42}, {'labels': ['voc-triage/bug']}, {'number': True, 'labels': ['voc-triage/bug']},
    {'number': 42, 'labels': 'voc-triage/bug'}, {'number': 42, 'labels': []},
    {'number': 42, 'labels': ['a', 'b', 'c']}, {'number': 42, 'labels': [7]},
    {'number': 42, 'labels': ['voc-triage/bug'], 'extra': 1},
])
def test_a_label_request_off_its_shape_is_a_bad_request(args: object) -> None:
    assert _call(args)['statusCode'] == 400


def test_the_record_keeps_the_run_on_ready_pull_requests_by_default() -> None:
    assert record().draft_pr is False
    assert replace(record(), draft_pr=True).draft_pr is True
