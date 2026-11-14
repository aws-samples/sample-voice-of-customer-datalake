"""The voc-conversations keys the chat routes build agree with the stream Lambda's (record.ts, LOCKSTEP).

Both sides read the same cases, ``voc-datalake/schemas/conversation-keys-cases.json``; the stream's own test
(lambda/stream/src/assistant/session/conversation-keys.test.ts) checks ``sessionKey``, ``cancelKey`` and
``conversantKey`` against them, this one ``conversation_partition``, ``CANCEL_SK_PREFIX`` and ``conversant_key``.
"""
from __future__ import annotations

import json

import pytest

from chat_handler import CANCEL_SK_PREFIX
from shared.conversations import CONVERSATION_SK_PREFIX, conversant_key, conversation_partition
from shared.test.repo_paths import repo_root
from shared.ws_repo import WorkspaceScope

_CASES = json.loads((repo_root() / 'schemas' / 'conversation-keys-cases.json').read_text(encoding='utf-8'))['cases']


def _scope(case: dict) -> WorkspaceScope | None:
    return None if case['workspace'] is None else WorkspaceScope(case['workspace'])


@pytest.mark.parametrize('case', _CASES, ids=lambda case: f"{case['workspace']}:{case['sub']}")
def test_the_conversation_and_its_stop_marker_have_the_streams_keys(case):
    partition = conversation_partition(case['sub'], _scope(case))
    assert {'pk': partition, 'sk': f"{CONVERSATION_SK_PREFIX}{case['conversation_id']}"} == case['conversation']
    assert {'pk': partition, 'sk': f"{CANCEL_SK_PREFIX}{case['conversation_id']}"} == case['cancel']


@pytest.mark.parametrize('case', _CASES, ids=lambda case: f"{case['workspace']}:{case['sub']}")
def test_the_owner_row_has_the_streams_key(case):
    scope = _scope(case)
    built = None if scope is None else conversant_key(scope, case['sub'])
    assert built == case['conversant']


def test_the_cases_cover_both_scopes():
    assert {case['workspace'] is None for case in _CASES} == {True, False}


def test_an_owner_row_needs_a_subject():
    with pytest.raises(ValueError, match='subject'):
        conversant_key(WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'), '')
