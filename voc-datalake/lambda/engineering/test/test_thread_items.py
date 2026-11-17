"""The run workspace's thread item (7.51.00): bounded, redacted, and shaped as ACP's session/update kinds."""
from __future__ import annotations

import pytest

from engineering.thread_items import MAX_TEXT, MAX_TOOL_INPUT, is_thread_item, thread_item

AGENT = {'kind': 'agent', 'id': 'fixer-2'}


def test_an_agents_words_are_an_agent_message_chunk():
    item = thread_item(ref='1.1.3', at='2026-11-17T10:00:00Z', kind='said', sender=AGENT, text='I found it.')
    assert item == {'ref': '1.1.3', 'at': '2026-11-17T10:00:00Z', 'kind': 'said', 'from': AGENT,
                    'text': 'I found it.', 'cut': False, 'update': 'agent_message_chunk'}
    assert is_thread_item(item)


def test_a_tool_call_is_one_line_with_its_acp_kind_and_status():
    call = thread_item(ref='1.1.4', at='t', kind='tool', sender=AGENT,
                       tool={'name': 'run', 'input': {'argv': ['pytest']}})
    assert call['tool'] == {'name': 'run', 'ok': None, 'input': "{'argv': ['pytest']}", 'kind': 'execute',
                            'status': 'in_progress'}
    assert call['update'] == 'tool_call'
    done = thread_item(ref='1.1.5', at='t', kind='tool', sender=AGENT,
                       tool={'name': 'write_file', 'ok': False, 'input': 'x\n' * 400})
    assert done['tool']['status'] == 'failed'
    assert done['tool']['kind'] == 'edit'
    assert done['update'] == 'tool_call_update'
    assert len(done['tool']['input']) == MAX_TOOL_INPUT
    assert '\n' not in done['tool']['input']
    assert is_thread_item(call)
    assert is_thread_item(done)


def test_text_is_redacted_and_cut_on_a_character_boundary():
    item = thread_item(ref='c4', at='t', kind='steer', sender={'kind': 'human', 'id': 'user-1'},
                       text='é' * MAX_TEXT + ' AKIA' + 'A' * 16)
    assert item['cut'] is True
    assert len(item['text'].encode()) <= MAX_TEXT
    assert item['update'] == 'user_message_chunk'
    secret = thread_item(ref='c5', at='t', kind='message', sender={'kind': 'human', 'id': 'u'},
                         text='key AKIA' + 'A' * 16)
    assert 'AKIA' not in secret['text']


@pytest.mark.parametrize(('kind', 'sender'), [('shout', AGENT), ('said', {'kind': 'model', 'id': 'x'})])
def test_a_kind_or_sender_off_the_shape_is_refused(kind, sender):
    with pytest.raises(ValueError, match='a thread item is'):
        thread_item(ref='r', at='t', kind=kind, sender=sender)


def test_the_shape_check_refuses_an_item_over_its_bounds():
    item = thread_item(ref='r', at='t', kind='said', sender=AGENT, text='ok')
    assert not is_thread_item({**item, 'text': 'x' * (MAX_TEXT + 1)})
    assert not is_thread_item({**item, 'kind': 'shout'})
    assert not is_thread_item({**item, 'tool': {'name': 'run', 'ok': 'yes', 'input': '', 'kind': 'execute',
                                               'status': 'completed'}})
