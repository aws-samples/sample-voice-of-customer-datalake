"""Opaque next_token cursors (shared/feedback_cursor.py) round-trip and refuse tampering."""
import base64
import json

import pytest

from shared.feedback_cursor import (
    MAX_CURSOR_CHARS,
    decode_key_cursor,
    decode_offset_cursor,
    encode_key_cursor,
    encode_offset_cursor,
)

FIELDS = frozenset({'gsi3pk', 'gsi3sk', 'pk', 'sk'})
KEY = {'gsi3pk': 'URGENCY#high', 'gsi3sk': '2026-10-18T10:00:00', 'pk': 'SOURCE#web', 'sk': 'FEEDBACK#1'}


def _raw(value: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')


def test_a_key_cursor_round_trips_without_padding():
    token = encode_key_cursor(KEY)
    assert '=' not in token
    assert decode_key_cursor(token, FIELDS, ('gsi3pk', 'URGENCY#high')) == KEY


@pytest.mark.parametrize('token', [
    '', '%%%', 'x' * (MAX_CURSOR_CHARS + 1), _raw([1]), _raw({**KEY, 'extra': 'x'}), _raw({**KEY, 'sk': 1}),
    _raw({**KEY, 'sk': ''}), _raw({**KEY, 'gsi3pk': 'URGENCY#low'}),
])
def test_a_key_cursor_that_was_not_issued_for_this_partition_is_refused(token):
    with pytest.raises(ValueError, match='next_token'):
        decode_key_cursor(token, FIELDS, ('gsi3pk', 'URGENCY#high'))


def test_an_offset_cursor_round_trips():
    assert decode_offset_cursor(encode_offset_cursor(42), 100) == 42


@pytest.mark.parametrize('value', [{'o': -1}, {'o': 101}, {'o': True}, {'o': '3'}, {'x': 3}, 3])
def test_an_out_of_range_or_malformed_offset_is_refused(value):
    with pytest.raises(ValueError, match='next_token'):
        decode_offset_cursor(_raw(value), 100)
