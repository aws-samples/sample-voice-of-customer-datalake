"""voc-msg/1: what a message may hold, and every refusal."""
from __future__ import annotations

import pytest

from engineering.bus.schema import MAX_EVENT_BYTES, TYPES, MessageError, parse
from engineering.bus.test.messages import RUN, message


def test_a_valid_message_round_trips():
    raw = message(task_id='task-7', refs={'s3': [f'ws/default/runs/{RUN}/a.jsonl'], 'commit': 'abc1234', 'pr': 12,
                                          'files': ['app/paging.py']})
    parsed = parse(raw)
    assert parsed.to_dict() == raw
    assert (parsed.sender.kind, parsed.to.id, parsed.refs.pr) == ('agent', 'reviewer-1', 12)
    assert parse(message(refs=None)).to_dict()['refs'] == {'s3': []}


def test_the_type_list_is_the_designs():
    assert {t.split('.')[0] for t in TYPES} == {'task', 'msg', 'review', 'gate', 'run', 'signal', 'skill', 'outcome'}
    assert 'heartbeat' not in TYPES   # a heartbeat is the lease renewal on the board, never an event


@pytest.mark.parametrize(('changes', 'reason'), [
    ({'schema': 'voc-msg/2'}, 'must be "voc-msg/1"'),
    ({'extra': 'my token is ghp_x'}, '1 unknown field(s)'),
    ({'type': 'heartbeat'}, 'unknown type'),
    ({'type': []}, 'unknown type'),
    ({'attempt': -1}, '"attempt" is a whole number'),
    ({'attempt': True}, '"attempt" is a whole number'),
    ({'event_id': 'not-a-ulid'}, '"event_id" is missing or malformed'),
    ({'ws': 'Bad WS'}, '"ws" is missing or malformed'),
    ({'run_id': ''}, '"run_id" is missing or malformed'),
    ({'task_id': 'has space'}, '"task_id" is missing or malformed'),
    ({'at': '2026-11-12 09:00'}, '"at" is missing or malformed'),
    ({'from': {'kind': 'agent'}}, '"from" must be {kind, id}'),
    ({'from': {'kind': 'robot', 'id': 'x'}}, '"from.kind" must be one of'),
    ({'from': {'kind': [], 'id': 'x'}}, '"from.kind" must be one of'),
    ({'to': {'kind': {}, 'id': 'x'}}, '"to.kind" must be one of'),
    ({'to': {'kind': 'role', 'id': 'janitor'}}, 'unknown role'),
    ({'type': 'task.posted'}, 'only a posted task is addressed to a role'),
    ({'type': 'task.posted', 'to': {'kind': 'role', 'id': 'fixer'}}, 'only a posted task is addressed to a role'),
    ({'to': {'kind': 'role', 'id': 'pr-reviewer'}}, 'only a posted task is addressed to a role'),
    ({'summary': 'x' * 1025}, '"summary" is a string of at most 1024 bytes'),
    ({'summary': 'token ghp_' + 'a' * 36}, 'shaped like a credential'),
    ({'refs': {'s3': ['ws/other/runs/x']}}, 'an S3 ref must be a key under ws/default/'),
    ({'refs': {'s3': ['ws/default/../x']}}, 'an S3 ref must be a key under ws/default/'),
    ({'refs': {'diff': 'x'}}, '"refs" holds only'),
    ({'refs': {'files': 'a.py'}}, '"refs.s3" and "refs.files" are lists'),
    ({'refs': {'files': ['/etc/passwd']}}, '"refs.files" are repository paths'),
    ({'refs': {'commit': 'main'}}, '"refs.commit" is a commit sha'),
    ({'refs': {'pr': -1}}, '"refs.pr" is a pull request number'),
])
def test_a_bad_message_is_refused_with_its_reason(changes, reason):
    with pytest.raises(MessageError) as raised:
        parse(message(**changes))
    assert reason in str(raised.value)
    assert 'ghp_' not in str(raised.value)


def test_a_message_too_big_for_the_bus_is_refused():
    files = [f'src/{"d" * 330}/{n}.py' for n in range(50)]
    with pytest.raises(MessageError, match=f'over {MAX_EVENT_BYTES} bytes'):
        parse(message(refs={'files': files}))


@pytest.mark.parametrize('data', [None, [], 'text'])
def test_a_message_is_an_object(data):
    with pytest.raises(MessageError, match='a message is a JSON object'):
        parse(data)
