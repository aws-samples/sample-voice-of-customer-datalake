"""voc-engineering-runtime's ``learn_cross_run`` (7.53.00, runtime/handler.py): the weekly schedule's invocation hands
each of the index's flows on as an invocation of its own; a flow's invocation runs its pass this week; nothing raises,
and voc-engineering-start never takes the action."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, ClassVar

import boto3
import pytest

from engineering.coach.model import COACH_MODEL, CoachReply
from engineering.learning.cross_run import record_key, week_of
from engineering.runtime import handler
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.test.conftest import RUN, WORKSPACE_BUCKET
from shared import aws as shared_aws

OTHER = '01JD3R4NZXQ7Y2W8K4M6P9T0AC'
FLOW = 'bug-hunt'
QUIET = json.dumps({'convergence': 'Two runs, both done: nothing recurs yet.', 'failures': [], 'lessons': [],
                    'coach': []})


class Model:
    """Bedrock's stand-in: the one answer, its tokens; the models it was built with are kept."""

    built: ClassVar[list[str]] = []

    def __init__(self, model_id: str = COACH_MODEL) -> None:
        Model.built.append(model_id)

    def __call__(self, system: str, prompt: str) -> CoachReply:
        del system, prompt
        return CoachReply(QUIET, COACH_MODEL, tokens_in=100, tokens_out=50)


def _indexed(monkeypatch: pytest.MonkeyPatch) -> str:
    """RUN and OTHER in the flow's index today, each with its manifest; Bedrock faked. The week's record key."""
    from engineering.coach import model
    monkeypatch.setattr(model, 'BedrockCoachModel', Model)
    Model.built = []
    s3 = boto3.client('s3', region_name='us-east-1')
    today = datetime.now(UTC).date().isoformat()
    for run in (RUN, OTHER):
        s3.put_object(Bucket=WORKSPACE_BUCKET, Key=f'ws/default/transcripts-index/{FLOW}/{today}/{run}.json', Body=b'{}')
        s3.put_object(Bucket=WORKSPACE_BUCKET, Key=f'ws/default/runs/{run}/_manifest/v0001.json', Body=json.dumps({
            'schema': 'voc-run-manifest/1', 'run_id': run, 'status': 'done', 'connection': 'conn-1', 'repo': 'example/app',
            'cost_usd': '0.50', 'tokens': 1000, 'agents': [], 'keys': {'outputs': []}}).encode())
    return record_key(FLOW, week_of(datetime.now(UTC)))


def test_the_schedules_invocation_runs_each_flows_pass_here_without_a_function_name(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    key = _indexed(monkeypatch)
    answer = handler.lambda_handler({'action': 'learn_cross_run'}, None)
    assert answer == {'status': 'handed_on', 'flows': [FLOW], 'more': False}
    record = json.loads(boto3.client('s3', region_name='us-east-1').get_object(
        Bucket=WORKSPACE_BUCKET, Key=key)['Body'].read())
    assert (record['analysis']['outcome'], record['window']['runs'], Model.built) == ('answered', 2, [COACH_MODEL])


def test_the_schedules_invocation_hands_each_flow_on_to_the_function_itself(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _indexed(monkeypatch)
    sent: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', lambda name, event: sent.append((name, event)) or {})

    class Context:
        function_name = 'voc-engineering-runtime'
        invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-engineering-runtime'

    handler.lambda_handler({'action': 'learn_cross_run'}, Context())
    assert sent == [('voc-engineering-runtime', {'action': 'learn_cross_run', 'flow': FLOW})]
    assert Model.built == []   # (no pass here: each flow's is its own invocation)


def test_a_flows_pass_runs_once_a_week(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _indexed(monkeypatch)
    first = handler.lambda_handler({'action': 'learn_cross_run', 'flow': FLOW}, None)
    again = handler.lambda_handler({'action': 'learn_cross_run', 'flow': FLOW}, None)
    assert (first['status'], again['status'], again['reason']) == ('written', 'skipped',
                                                                   "this week's pass has run already")


@pytest.mark.parametrize('flow', ['no-flow', 'a/b', ''])
def test_a_pass_that_fails_is_logged_and_answered_never_raised(wired: Any, flow: str) -> None:
    assert wired is not None
    assert handler.lambda_handler({'action': 'learn_cross_run', 'flow': flow}, None) == {
        'flow': flow, 'status': 'failed'}


def test_the_start_function_never_takes_the_pass() -> None:
    with pytest.raises(RuntimeRefused, match='this function only starts a run'):
        handler.start_handler({'action': 'learn_cross_run'}, None)
