"""Checkpoints: a continuation restores from the newest valid one, and never from one holding a secret."""
import json
from typing import Any

import pytest

from engineering.runtime.checkpoints import (
    KINDS,
    MAX_CANDIDATES,
    MAX_CHECKPOINT_BYTES,
    CheckpointReader,
    artifact_prefix,
    assert_storable,
    checkpoint_prefix,
    is_valid,
)
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.test.conftest import BUCKET, COMMIT, RUN
from engineering.runtime.tokens import TokenNotStorable
from engineering.workspace.layout import parse_agent_key


def _put(s3: Any, seq: int, body: object) -> str:
    key = f'{checkpoint_prefix(RUN, "fixer-1", COMMIT, 1)}{seq:06d}-n{seq}.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=body if isinstance(body, bytes) else json.dumps(body).encode())
    return key


def test_the_newest_valid_checkpoint_wins(aws):
    s3, _ = aws
    _put(s3, 1, {'position': 1})
    newest = _put(s3, 2, {'position': 2, 'plan': ['a'], 'cursor': 'evt-9', 'patch': 'k'})
    assert CheckpointReader(s3, BUCKET).latest(RUN, 'fixer-1', COMMIT, 1) == newest


def test_invalid_checkpoints_are_skipped_for_an_older_valid_one(aws):
    s3, _ = aws
    good = _put(s3, 1, {'position': 1})
    _put(s3, 2, {'position': 2, 'notes': {'api_token': 'x'}})
    _put(s3, 3, b'not json')
    _put(s3, 4, {'plan': 'no position'})
    assert CheckpointReader(s3, BUCKET).latest(RUN, 'fixer-1', COMMIT, 1) == good


def test_a_checkpoint_too_big_is_never_read_and_an_older_valid_one_wins(aws, monkeypatch):
    s3, _ = aws
    good = _put(s3, 1, {'position': 1})
    huge = _put(s3, 2, b'x' * (MAX_CHECKPOINT_BYTES + 1))
    read: list[str] = []
    original = s3.get_object
    monkeypatch.setattr(s3, 'get_object', lambda **kwargs: read.append(kwargs['Key']) or original(**kwargs))
    assert CheckpointReader(s3, BUCKET).latest(RUN, 'fixer-1', COMMIT, 1) == good
    assert huge not in read


def test_no_checkpoint_or_none_valid_among_the_newest_starts_afresh(aws):
    s3, _ = aws
    reader = CheckpointReader(s3, BUCKET)
    assert reader.latest(RUN, 'fixer-1', COMMIT, 1) is None
    _put(s3, 1, {'position': 1})
    for seq in range(2, 2 + MAX_CANDIDATES):
        _put(s3, seq, b'{}')
    assert reader.latest(RUN, 'fixer-1', COMMIT, 1) is None


@pytest.mark.parametrize('state', [
    {'auth_token': 'x'}, {'nested': {'Authorization': 'Bearer x'}}, {'items': [{'password': 'x'}]},
    {'session': {'SessionToken': 'x'}},
], ids=['token-key', 'nested-header', 'in-list', 'session-token'])
def test_a_state_holding_a_secret_is_refused(state):
    with pytest.raises(TokenNotStorable):
        assert_storable(state)


def test_an_oversized_checkpoint_is_not_valid_and_a_bad_id_is_refused():
    assert not is_valid(json.dumps({'position': 1, 'notes': 'x' * 300_000}).encode())
    with pytest.raises(RuntimeRefused):
        checkpoint_prefix(RUN, '../fixer', COMMIT, 1)


@pytest.mark.parametrize('kind', sorted(KINDS))
def test_every_key_written_here_is_one_the_workspace_layout_reads(kind: str):
    key = f'{artifact_prefix(RUN, "fixer-1", COMMIT, 3, kind)}000001-abcd1234.json'
    parsed = parse_agent_key(key)
    assert parsed is not None
    assert (parsed.ws, parsed.run_id, parsed.agent, parsed.sha, parsed.kind, parsed.attempt) == (
        'default', RUN, 'fixer-1', COMMIT, kind, 3)


def test_a_continuation_restores_only_from_its_tasks_attempt(aws):
    s3, _ = aws
    first = _put(s3, 1, {'position': 1})
    later = f'{checkpoint_prefix(RUN, "fixer-1", COMMIT, 2)}000009-n9.json'
    s3.put_object(Bucket=BUCKET, Key=later, Body=json.dumps({'position': 9}).encode())
    reader = CheckpointReader(s3, BUCKET)
    assert (reader.latest(RUN, 'fixer-1', COMMIT, 1), reader.latest(RUN, 'fixer-1', COMMIT, 2)) == (first, later)


@pytest.mark.parametrize(('commit', 'attempt', 'kind'), [
    ('abc1234', 1, 'patches'), (COMMIT, 0, 'patches'), (COMMIT, 10_000, 'patches'), (COMMIT, 1, 'findings'),
], ids=['short-sha', 'no-attempt', 'too-many', 'not-a-runtime-kind'])
def test_a_key_off_the_layout_is_refused(commit: str, attempt: int, kind: str):
    with pytest.raises(RuntimeRefused):
        artifact_prefix(RUN, 'fixer-1', commit, attempt, kind)
