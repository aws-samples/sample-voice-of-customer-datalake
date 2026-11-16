"""An engineering agent's start (7.47.00): voc-engineering-start resolves the commit through the broker's ``head`` (a
fake broker here), confirms the issue, forces the hard cap, and records where the run came from (``via`` on its first
RUNLOG# row, its feedback ids and PRD on META), each checked before anything is written."""
from __future__ import annotations

import io
import json
import urllib.error
from email.message import Message
from typing import Any

import boto3
import pytest

from engineering.learning import reactions_broker
from engineering.runtime import handler
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import RunStore, StartReadFailed, meta_key, run_pk
from engineering.runtime.test.broker_stub import Answer
from engineering.runtime.test.conftest import TABLE

RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0GH'
HEAD = 'c0ffee' + '0' * 34
VIA = {'agent_id': 'ag_0123456789ab', 'agent_run_id': 'ar_0123456789ab01234567', 'trigger': 'github_issue'}
START = {'action': 'start_run', 'run_id': RUN, 'max_tasks': 5, 'flow': 'wf_0123456789ab', 'connection': 'shop',
         'repo': 'example-org/shop', 'default_branch': 'main', 'host': 'github', 'issue': 7, 'commit': '',
         'resolve_commit': True, 'hard_cap': True, 'budget_usd': 50.0, 'actor': 'owner-sub',
         'goal': 'Fix the bug reported in issue #7 of example-org/shop.', 'via': VIA}


class Broker:
    """The broker's function URL: ``head`` answered with ``state`` for the issue, or a refusal ``status``."""

    def __init__(self, state: str | None = 'open', status: int = 200, reason: str = '') -> None:
        self.state, self.status, self.reason, self.sent = state, status, reason, []

    def open(self, request: Any, timeout: float) -> Any:
        del timeout
        self.sent.append(json.loads(request.data))
        if self.status != 200:
            body = io.BytesIO(json.dumps({'error': self.reason}).encode())
            raise urllib.error.HTTPError(request.full_url, self.status, 'refused', Message(), body)
        issue = self.sent[-1]['args'].get('issue')
        found = None if issue is None else {'number': issue, 'state': self.state}
        return Answer(json.dumps({'result': {'commit': HEAD, 'issue': found}}).encode())


@pytest.fixture
def broker(wired: Any, monkeypatch: pytest.MonkeyPatch) -> Broker:
    assert wired is not None
    fake = Broker()
    monkeypatch.setattr(reactions_broker, '_OPENER', fake)
    monkeypatch.setattr(handler, '_hand_on_launch', lambda *_handed: None)
    return fake


def _table() -> Any:
    return boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)


def _meta() -> dict[str, Any] | None:
    return _table().get_item(Key=meta_key(RUN)).get('Item')


def _start(**change: Any) -> dict[str, Any]:
    return handler.start_handler({**START, **change}, None)


def test_the_start_resolves_the_head_and_confirms_the_issue_through_the_broker(broker: Broker) -> None:
    assert _start() == {'run_id': RUN, 'status': 'active'}
    assert broker.sent == [{'operation': 'head', 'args': {'connection': 'shop', 'repository': 'example-org/shop',
                                                          'branch': 'main', 'issue': 7}}]
    meta = _meta()
    assert meta is not None
    assert (meta['commit'], meta['issue']['number'], meta['issue']['verified']) == (HEAD, 7, True)
    (log,) = _table().query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                            ExpressionAttributeValues={':pk': run_pk(RUN), ':log': 'RUNLOG#'})['Items']
    assert (log['actor'], log['via']) == ('owner-sub', VIA)


@pytest.mark.parametrize(('fake', 'refusal', 'kind'), [
    (Broker(state='closed'), 'issue #7 of example-org/shop is closed', RuntimeRefused),
    (Broker(state=None), 'issue #7 is not an issue of example-org/shop', RuntimeRefused),
    (Broker(status=409, reason="The connection's default branch is not on the repository"),
     "the repository refused the start: The connection's default branch is not on the repository", RuntimeRefused),
    (Broker(status=503, reason='no repository connection is configured'),
     "the repository's head could not be read", StartReadFailed),
])
def test_a_start_the_host_does_not_bear_out_is_refused_before_anything_is_written(
        broker: Broker, monkeypatch: pytest.MonkeyPatch, fake: Broker, refusal: str, kind: type) -> None:
    assert broker is not None
    monkeypatch.setattr(reactions_broker, '_OPENER', fake)
    with pytest.raises(kind, match=refusal):
        _start()
    assert _meta() is None


def test_a_start_names_its_commit_or_resolves_it_never_both(broker: Broker) -> None:
    with pytest.raises(RuntimeRefused, match='never both'):
        _start(commit=HEAD)
    assert (_meta(), broker.sent) == (None, [])


def test_the_start_is_hard_capped_even_with_the_administrators_hard_cap_off(broker: Broker) -> None:
    from datetime import UTC, datetime
    from decimal import Decimal

    from engineering.runtime.runs import RunCaps
    from engineering.settings import save_hard_cap
    from engineering.spend import MICROVM, Usage, Where, ledger_updates

    assert broker is not None
    store = RunStore(_table())
    save_hard_cap(store.table, on=False, by='admin-1', at=datetime.now(UTC))
    store.table.meta.client.transact_write_items(TransactItems=ledger_updates(
        store.table.name, datetime.fromtimestamp(handler.clock(), UTC), Where('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1',
                                                                              'wf_0123456789ab'),
        {MICROVM: Usage(usd=Decimal('45'))}))
    _start(max_cost_usd=50.0)
    run = store.get(RUN)
    assert run is not None
    assert run.caps == RunCaps(max_tasks=5, max_cost_usd=5.0)


def test_the_runs_feedback_and_prd_are_on_meta_as_ids_and_counts(broker: Broker) -> None:
    assert broker is not None
    _start(issue=None, resolve_commit=True, feedback={'ids': ['fb-1', 'fb-2'], 'count': 9, 'category': 'shipping'},
           prd={'project_id': 'proj_1', 'document_id': 'prd_1'}, goal='Hunt the defects behind 9 bug reports.')
    meta = _meta()
    assert meta is not None
    assert (meta['feedback'], meta['prd'], 'issue' in meta) == (
        {'ids': ['fb-1', 'fb-2'], 'count': 9, 'category': 'shipping'}, {'project_id': 'proj_1', 'document_id': 'prd_1'},
        False)


@pytest.mark.parametrize('change', [
    {'feedback': {'ids': [f'fb-{n}' for n in range(51)], 'count': 51}},
    {'feedback': {'ids': ['fb 1'], 'count': 1}},
    {'feedback': {'ids': ['fb-1', 'fb-2'], 'count': 1}},
    {'feedback': {'ids': [], 'count': 0, 'text': 'a review'}},
    {'prd': {'project_id': 'p', 'document_id': 'd', 'title': 'x'}},
    {'via': {**VIA, 'trigger': 'webhook'}},
    {'via': {**VIA, 'agent_id': 'agent-1'}},
])
def test_where_a_run_came_from_off_its_shape_is_refused_before_anything_is_written(broker: Broker,
                                                                                    change: dict) -> None:
    assert broker is not None
    with pytest.raises(RuntimeRefused):
        _start(**change)
    assert _meta() is None


def test_an_agents_goal_has_credential_shaped_text_redacted(broker: Broker) -> None:
    assert broker is not None
    _start(goal='Use token ghp_' + 'a' * 36 + ' to fix it.')
    meta = _meta()
    assert meta is not None
    assert 'ghp_' + 'a' * 36 not in meta['goal']
