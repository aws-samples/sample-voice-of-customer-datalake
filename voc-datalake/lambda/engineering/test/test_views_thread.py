"""One agent's thread (engineering/views_thread.py): its transcript and the run's messages about it, merged in time
order; its cursors, the tail of a long attempt, bounded text, a chunk gone missing, a tool call's result on a later
page, and an item's whole event."""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
from moto import mock_aws

from engineering.run_objects import Read, RunObjects
from engineering.runtime.checkpoints import artifact_prefix
from engineering.test import run_workspace_world as world
from engineering.thread_items import MAX_TEXT, is_thread_item
from engineering.views_thread import (
    TAIL,
    Cursor,
    CursorError,
    ThreadView,
    decode_cursor,
    display,
    parse_tail,
)


@pytest.fixture
def built() -> Iterator[world.World]:
    with mock_aws():
        yield world.build()


@pytest.fixture
def view(built: world.World) -> ThreadView:
    return ThreadView(built.client, world.TABLE, RunObjects(built.s3, world.BUCKET))


def _fixer(view: ThreadView) -> Any:
    subject = view.subject(world.RUN, world.FIXER)
    assert subject is not None
    return subject


def _all(view: ThreadView, subject: Any, limit: int) -> list[dict[str, Any]]:
    """Every item, page after page of ``limit``, each kept once by its ref (a later one replaces an earlier)."""
    kept: dict[str, dict[str, Any]] = {}
    cursor = Cursor()
    for _ in range(50):
        page = view.page(world.RUN, subject, cursor, limit)
        kept.update((item['ref'], item) for item in page['items'])
        following = decode_cursor(page['next'])
        if following == cursor:
            break
        cursor = following
    return list(kept.values())


def test_the_thread_merges_the_transcript_and_the_messages_about_the_agent_in_time_order(view: ThreadView) -> None:
    page = view.page(world.RUN, _fixer(view), Cursor(), 200)
    items = page['items']
    assert all(is_thread_item(item) for item in items)
    assert [item['at'] for item in items] == sorted(item['at'] for item in items)
    kinds = [(item['kind'], item['from']['kind']) for item in items]
    assert ('thought', 'agent') in kinds
    assert ('said', 'agent') in kinds
    assert ('steer', 'conductor') in kinds
    # The person's steering to the conductor is the orchestrator's, not the fixer's: only its relay is here.
    texts = [item['text'] for item in items if item['kind'] == 'steer']
    assert texts == ['Keep the public signature of last_page as it is.']
    # Another agent's gate verdict and the run's start are not the fixer's.
    assert not [item for item in items if item['ref'] in ('c1', 'c8')]
    assert page['done'] is False   # (its session still works)


def test_a_tool_call_is_one_item_with_its_result_and_its_acp_kinds(view: ThreadView) -> None:
    items = {item['ref']: item for item in view.page(world.RUN, _fixer(view), Cursor(), 200)['items']}
    read, run, submit = (next(item for item in items.values() if item.get('tool', {}).get('name') == name)
                         for name in ('read_file', 'run', 'submit_work'))
    # (its result's first line, its DATA fence unwrapped; a result read in the same page fills the call's item)
    assert (read['text'], read['tool']['ok'], read['tool']['kind'], read['update']) == (
        'def last_page(items, size):', True, 'read', 'tool_call_update')
    # (the run's result is in the next chunk, after a checkpoint: still the call's own item)
    assert (run['tool']['status'], run['text'], run['cut']) == ('failed', 'exit 1', True)
    assert (submit['tool']['status'], submit['tool']['ok'], submit['update']) == ('in_progress', None, 'tool_call')


def test_a_reply_tools_words_are_the_agents_own_said_item_just_before_its_call(view: ThreadView) -> None:
    items = view.page(world.RUN, _fixer(view), Cursor(), 200)['items']
    submit = next(item for item in items if item.get('tool', {}).get('name') == 'submit_work')
    said = items[items.index(submit) - 1]
    # (7.54.00: the summary the agent hands in is its reply, shown as its words; the call keeps its own line)
    assert (said['kind'], said['ref'], said['from'], said['text'], said['update'], said['at']) == (
        'said', f'{submit["ref"]}.1', {'kind': 'agent', 'id': world.FIXER}, 'The last page now holds at most a page.',
        'agent_message_chunk', submit['at'])
    assert is_thread_item(said)


def _built(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from engineering.views_thread import Event, Subject, _Transcript

    subject = Subject(world.RUN, world.FIXER, 'fixer', world.FIX_TASK, 2, world.COMMIT, 'working')
    built, _ = _Transcript(subject, RunObjects(None, world.BUCKET)).build(
        [Event(1, index * 100, index * 100 + 99, event) for index, event in enumerate(events)])
    return [entry.item for entry in built]


def test_only_a_reply_tools_own_field_is_said_redacted_and_unfenced() -> None:
    items = _built([
        {'kind': 'tool_call', 'tool': 'report_progress', 'input': {'step': 'Read the helper; AKIA' + 'ABCDEFGHIJKLMNOP'}},
        {'kind': 'tool_call', 'tool': 'finish', 'input': {'summary': '<<<DATA notes abc>>>\nDone.\n<<<END DATA notes abc>>>'}},
        {'kind': 'tool_call', 'tool': 'finish', 'input': {'summary': '   '}},
        {'kind': 'tool_call', 'tool': 'finish', 'input': {'summary': 7}},
        {'kind': 'tool_call', 'tool': 'write_file', 'input': {'path': 'a.py', 'text': 'print(1)'}},
        {'kind': 'tool_call', 'tool': 'post_comment', 'input': {'body': 'A comment on the issue'}},
    ])
    said = [(item['ref'], item['text']) for item in items if item['kind'] == 'said']
    assert said == [('2.1.0.1', 'Read the helper; <redacted>'), ('2.1.100.1', '[notes]\nDone.')]
    assert [item['tool']['name'] for item in items if item['kind'] == 'tool'] == [
        'report_progress', 'finish', 'finish', 'finish', 'write_file', 'post_comment']


def test_a_reply_answered_in_the_same_read_keeps_its_words_and_its_calls_result() -> None:
    items = _built([
        {'kind': 'tool_call', 'tool': 'finish', 'call_id': 'c1', 'input': {'summary': 'Fixed the slice.'}},
        {'kind': 'tool_result', 'tool': 'finish', 'call_id': 'c1', 'text': 'finished', 'error': False},
    ])
    assert [(item['kind'], item['text']) for item in items] == [('said', 'Fixed the slice.'), ('tool', 'finished')]
    assert items[1]['tool']['ok'] is True


@pytest.mark.parametrize('limit', [1, 2, 3, 5, 8])
def test_pages_of_any_size_give_the_whole_thread_once(view: ThreadView, limit: int) -> None:
    whole = {item['ref']: item for item in view.page(world.RUN, _fixer(view), Cursor(), 200)['items']}
    assert {item['ref']: item for item in _all(view, _fixer(view), limit)} == whole


def test_a_result_read_on_a_later_page_updates_its_call(view: ThreadView) -> None:
    subject = _fixer(view)
    first = view.page(world.RUN, subject, Cursor(), 8)
    call = first['items'][-1]
    assert call['tool']['name'] == 'run'
    following = decode_cursor(first['next'])
    assert following.call == call['ref']   # (the cursor remembers the call whose result it has not passed)
    later = view.page(world.RUN, subject, following, 200)
    update = next(item for item in later['items'] if item['ref'] == call['ref'])
    assert (update['update'], update['tool']['status'], update['tool']['input']) == (
        'tool_call_update', 'failed', call['tool']['input'])


def test_a_page_repeats_the_messages_of_the_window_below_its_cursor(view: ThreadView) -> None:
    subject = _fixer(view)
    first = view.page(world.RUN, subject, Cursor(), 200)
    again = view.page(world.RUN, subject, decode_cursor(first['next']), 200)
    # (nothing new; the window's messages again, which the reader keeps once by their ref)
    assert {item['ref'] for item in again['items']} <= {item['ref'] for item in first['items']}
    assert all(item['ref'].startswith('c') for item in again['items'])


def test_the_tail_opens_a_long_attempt_at_its_end(view: ThreadView) -> None:
    subject = _fixer(view)
    whole = view.page(world.RUN, subject, Cursor(), 200)['items']
    tail = view.page(world.RUN, subject, decode_cursor(TAIL), 4)
    assert [item['ref'] for item in tail['items']] == [item['ref'] for item in whole[-4:]]
    assert decode_cursor(tail['next']).call == tail['items'][-1]['ref']   # (submit_work, still under way)


def test_parse_tail_drops_a_partial_first_line_and_skips_bad_lines() -> None:
    lines = [json.dumps({'kind': 'checkpoint', 'turn': n}) for n in range(3)]
    body = ('\n'.join(lines) + '\nnot json\n[1, 2]\n' + json.dumps({'kind': 'end'}) + '\n').encode()
    whole = parse_tail(Read(body, 0, len(body)), 1)
    assert [event.data.get('turn', 'end') for event in whole] == [0, 1, 2, 'end']
    cut = parse_tail(Read(body[5:], 5, len(body)), 1)   # (a range read that starts inside the first line)
    assert [event.data.get('turn', 'end') for event in cut] == [1, 2, 'end']
    assert cut[0].offset == len(lines[0]) + 1   # (each event keeps where its line starts in the object)
    assert parse_tail(Read(b'no new line here', 9, 40), 1) == []


def test_a_chunk_gone_since_the_listing_is_read_past(view: ThreadView) -> None:
    prefix = artifact_prefix(world.RUN, world.FIXER, world.COMMIT, 2, 'transcripts')
    original = view.objects.read

    def missing(key: str, *args: Any, **kwargs: Any) -> Read | None:
        return None if key == f'{prefix}0001.jsonl' else original(key, *args, **kwargs)

    view.objects.read = missing   # type: ignore[method-assign]
    items = view.page(world.RUN, _fixer(view), Cursor(), 200)['items']
    transcript = [item['ref'] for item in items if not item['ref'].startswith('c')]
    assert transcript
    assert all(ref.startswith('2.2.') for ref in transcript)


def test_text_is_bounded_redacted_and_without_its_data_fences() -> None:
    assert display('<<<DATA notes abc123>>>\nsee AKIA' + 'ABCDEFGHIJKLMNOP\x00\x07 here\n<<<END DATA notes abc123>>>') == (
        '[notes]\nsee <redacted> here')
    long_said = {'role': 'assistant', 'content': [{'text': 'é' * 10_000}]}
    from engineering.views_thread import Event, Subject, _Transcript

    subject = Subject(world.RUN, world.FIXER, 'fixer', world.FIX_TASK, 2, world.COMMIT, 'working')
    built, _ = _Transcript(subject, RunObjects(None, world.BUCKET)).build([Event(1, 0, 10, {'kind': 'message', **long_said})])
    [item] = [entry.item for entry in built]
    assert (item['cut'], len(item['text'].encode()) <= MAX_TEXT) == (True, True)


def test_an_items_whole_event_is_answered_by_its_ref(view: ThreadView) -> None:
    subject = _fixer(view)
    items = view.page(world.RUN, subject, Cursor(), 200)['items']
    run = next(item for item in items if item.get('tool', {}).get('name') == 'run')
    whole = view.event(world.RUN, subject, run['ref'])
    assert whole is not None
    assert (whole['kind'], whole['event']['input']['argv'][-1], whole['result']['error']) == (
        'tool_call', 'tests/test_paging.py', True)
    question = view.event(world.RUN, subject, 'c5')
    assert question is not None
    assert question['message']['type'] == 'msg.question'
    # A message not about the agent, an attempt it has not, a line that does not start there: none of its thread.
    assert [view.event(world.RUN, subject, ref) for ref in ('c3', '1.1.0', '2.1.5', 'x')] == [None] * 4


def test_the_thread_of_an_ended_agent_is_done_once_read_to_its_end(view: ThreadView) -> None:
    gate = view.subject(world.RUN, world.GATE_RUNNER)
    assert gate is not None
    assert gate.ended
    page = view.page(world.RUN, gate, Cursor(), 200)
    assert page['done'] is True
    assert [item['kind'] for item in page['items']][-1] == 'end'


@pytest.mark.parametrize('text', ['x', 'eyJ2IjoyfQ', 'eyJ2IjoxLCJrIjotMSwibyI6MCwicyI6MH0', 'a' * 401,
                                  'eyJ2IjoxLCJrIjowLCJvIjowLCJzIjowLCJwIjoiZXZpbCJ9'])
def test_a_cursor_this_thread_did_not_give_is_refused(text: str) -> None:
    with pytest.raises(CursorError):
        decode_cursor(text)


def test_a_cursor_reads_back_as_it_was_given() -> None:
    cursor = Cursor(chunk=3, offset=1024, seq=17, call='2.3.512')
    assert decode_cursor(cursor.encode()) == cursor
    assert decode_cursor(TAIL).tail
    assert decode_cursor(None) == Cursor()
