"""Crypto-free JWT segment parsing (shared/mcp_oauth_jwt_parts.py): strict base64url, JSON objects only."""
from __future__ import annotations

import base64
import json

import pytest

from shared.mcp_oauth_jwt_parts import MAX_TOKEN_LENGTH, InvalidToken, b64url, json_segment, unverified_claims


def _seg(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def _token(payload: object) -> str:
    return f"{_seg(b'{}')}.{_seg(json.dumps(payload).encode())}.sig"


def test_an_unpadded_segment_decodes():
    assert b64url(_seg(b'ab')) == b'ab'


@pytest.mark.parametrize('segment', ['', 'YWI=', 'a', 'a$b!'])
def test_a_padded_empty_or_invalid_segment_is_malformed(segment):
    with pytest.raises(InvalidToken, match='malformed segment'):
        b64url(segment)


@pytest.mark.parametrize('raw', [b'\xff\xfe', b'not json', b'[1, 2]', b'"text"'])
def test_a_segment_that_is_not_a_json_object_is_malformed(raw):
    with pytest.raises(InvalidToken, match='malformed segment'):
        json_segment(_seg(raw))


def test_the_payload_is_read_without_a_signature_check():
    assert unverified_claims(_token({'sub': 'sub-alice', 'origin_jti': 'chain-1'})) == {
        'sub': 'sub-alice', 'origin_jti': 'chain-1'}


@pytest.mark.parametrize('token', [
    None, 42, 'one.two', 'a.b.c.d', 'x.' + 'a' * MAX_TOKEN_LENGTH + '.y', f"{_seg(b'{}')}.{_seg(b'[1]')}.sig",
])
def test_anything_but_a_compact_jwt_with_an_object_payload_is_none(token):
    assert unverified_claims(token) is None
