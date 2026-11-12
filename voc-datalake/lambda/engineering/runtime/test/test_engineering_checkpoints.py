"""Checkpoints: a continuation restores from the newest valid one, and never from one holding a secret."""
import json
from typing import Any

import pytest

from engineering.runtime.checkpoints import (
    MAX_CANDIDATES,
    MAX_CHECKPOINT_BYTES,
    CheckpointReader,
    assert_storable,
    checkpoint_prefix,
    is_valid,
)
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.test.conftest import BUCKET
from engineering.runtime.tokens import TokenNotStorable


def _put(s3: Any, seq: int, body: object) -> str:
    key = f'{checkpoint_prefix("01JD3R4NZXQ7Y2W8K4M6P9T0AB", "fixer-1")}{seq:06d}-n{seq}.json'
    s3.put_object(Bucket=BUCKET, Key=key, Body=body if isinstance(body, bytes) else json.dumps(body).encode())
    return key


def test_the_newest_valid_checkpoint_wins(aws):
    s3, _ = aws
    _put(s3, 1, {'position': 1})
    newest = _put(s3, 2, {'position': 2, 'plan': ['a'], 'cursor': 'evt-9', 'patch': 'k'})
    assert CheckpointReader(s3, BUCKET).latest('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1') == newest


def test_invalid_checkpoints_are_skipped_for_an_older_valid_one(aws):
    s3, _ = aws
    good = _put(s3, 1, {'position': 1})
    _put(s3, 2, {'position': 2, 'notes': {'api_token': 'x'}})
    _put(s3, 3, b'not json')
    _put(s3, 4, {'plan': 'no position'})
    assert CheckpointReader(s3, BUCKET).latest('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1') == good


def test_a_checkpoint_too_big_is_never_read_and_an_older_valid_one_wins(aws, monkeypatch):
    s3, _ = aws
    good = _put(s3, 1, {'position': 1})
    huge = _put(s3, 2, b'x' * (MAX_CHECKPOINT_BYTES + 1))
    read: list[str] = []
    original = s3.get_object
    monkeypatch.setattr(s3, 'get_object', lambda **kwargs: read.append(kwargs['Key']) or original(**kwargs))
    assert CheckpointReader(s3, BUCKET).latest('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1') == good
    assert huge not in read


def test_no_checkpoint_or_none_valid_among_the_newest_starts_afresh(aws):
    s3, _ = aws
    reader = CheckpointReader(s3, BUCKET)
    assert reader.latest('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1') is None
    _put(s3, 1, {'position': 1})
    for seq in range(2, 2 + MAX_CANDIDATES):
        _put(s3, seq, b'{}')
    assert reader.latest('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1') is None


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
        checkpoint_prefix('01JD3R4NZXQ7Y2W8K4M6P9T0AB', '../fixer')
