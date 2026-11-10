"""Mutation hardening for `agents/run_memory.py`.

`test_conductor_run.py::TestRunMemory` drives a whole run through moto and
checks that a completed run lands on the queue, a failed run does not, and a
broken queue never fails the run. A mutation run found everything inside the
module unobserved by those three end-to-end checks:

* the message itself — the exact ``kind`` / ``ref`` / ``text`` / ``agent_id``
  keys and nothing else, the queue URL read from exactly
  ``MEMORY_EXTRACT_QUEUE_URL``, and that ``needs_human`` is a memory source
  while ``cancelled`` / ``failed`` / ``running`` are not;
* the three silent refusals — an unset queue URL or an empty agent id returns
  ``False`` WITHOUT touching the store, the queue or the log;
* the journal — the exact header line, the ``[kind] summary`` line format with
  the summary stripped, non-string and blank summaries dropped, the ``\\n``
  joiner, the 400-event read, and the 30 000-character TAIL (a ``+`` instead
  of ``-`` in the slice would keep the head);
* the failure path — the exact ``Agent run not queued for memory`` warning and
  its ``extra``, that ``None`` from ``get_agent`` falls back to the agent id,
  and that the return value is ``True`` only when a message was sent.

Every expectation is the literal string, number, key or call the module emits.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from agents import run_memory, store

AGENT_ID = 'ag_1'
RUN_ID = 'ar_000000000001'
QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/0/voc-memory-extract'
HEADER = f'Autonomous agent "Checkout agent" run {RUN_ID} finished: completed.'


@pytest.fixture
def sqs() -> Iterator[MagicMock]:
    client = MagicMock()
    with patch.object(run_memory, 'get_sqs_client', return_value=client):
        yield client


@pytest.fixture
def queue_env(monkeypatch) -> None:
    monkeypatch.setenv('MEMORY_EXTRACT_QUEUE_URL', QUEUE_URL)


@pytest.fixture
def warning() -> Iterator[MagicMock]:
    with patch.object(run_memory.logger, 'warning') as mock:
        yield mock


@pytest.fixture
def agent_store() -> Iterator[MagicMock]:
    """`store` with one named agent and two events, reachable without DynamoDB."""
    mock = MagicMock()
    mock.get_agent.return_value = {'agent_id': AGENT_ID, 'name': 'Checkout agent'}
    mock.list_events.return_value = [
        {'kind': 'node_started', 'summary': 'Reading feedback'},
        {'kind': 'node_finished', 'summary': 'Wrote the PRD'},
    ]
    with patch.object(run_memory, 'store', mock):
        yield mock


class TestTheJournalIsExactLines:
    def test_header_then_one_bracketed_line_per_event_joined_by_newline(self, agent_store):
        text = run_memory.journal_text(RUN_ID, 'Checkout agent', 'completed')

        assert text == f'{HEADER}\n[node_started] Reading feedback\n[node_finished] Wrote the PRD'
        agent_store.list_events.assert_called_once_with(RUN_ID, 400)

    def test_the_header_names_agent_run_and_status_literally(self, agent_store):
        agent_store.list_events.return_value = []

        assert run_memory.journal_text('ar_x', 'Billing', 'needs_human') == (
            'Autonomous agent "Billing" run ar_x finished: needs_human.')

    @pytest.mark.parametrize('event', [
        {'kind': 'node_finished', 'summary': '   '},
        {'kind': 'node_finished', 'summary': ''},
        {'kind': 'node_finished', 'summary': 42},
        {'kind': 'node_finished', 'summary': None},
        {'kind': 'node_finished'},
    ])
    def test_an_event_without_a_non_blank_string_summary_adds_no_line(self, agent_store, event):
        agent_store.list_events.return_value = [event]

        assert run_memory.journal_text(RUN_ID, 'Checkout agent', 'completed') == HEADER

    def test_a_summary_is_stripped_and_prefixed_with_its_kind(self, agent_store):
        agent_store.list_events.return_value = [{'kind': 'escalated', 'summary': '  needs a human \n'}]

        assert run_memory.journal_text(RUN_ID, 'Checkout agent', 'completed') == (
            f'{HEADER}\n[escalated] needs a human')

    def test_an_event_without_a_kind_is_tagged_none(self, agent_store):
        agent_store.list_events.return_value = [{'summary': 'orphan'}]

        assert run_memory.journal_text(RUN_ID, 'Checkout agent', 'completed') == f'{HEADER}\n[None] orphan'

    def test_a_long_journal_keeps_exactly_its_last_30000_characters(self, agent_store):
        agent_store.list_events.return_value = [
            {'kind': 'node_finished', 'summary': 'a' * 20_000},
            {'kind': 'node_finished', 'summary': 'z' * 20_000},
        ]
        full = f'{HEADER}\n[node_finished] {"a" * 20_000}\n[node_finished] {"z" * 20_000}'

        text = run_memory.journal_text(RUN_ID, 'Checkout agent', 'completed')

        assert len(text) == 30_000
        assert text == full[-30_000:]
        assert text.endswith('z' * 20_000)
        assert not text.startswith('Autonomous')

    def test_a_journal_of_exactly_30000_characters_is_kept_whole(self, agent_store):
        padding = 30_000 - len(HEADER) - len('\n[node_finished] ')
        agent_store.list_events.return_value = [{'kind': 'node_finished', 'summary': 'b' * padding}]

        text = run_memory.journal_text(RUN_ID, 'Checkout agent', 'completed')

        assert len(text) == 30_000
        assert text.startswith(HEADER)


@pytest.mark.usefixtures('agent_store')
class TestTheQueuedMessage:
    @pytest.mark.usefixtures('queue_env')
    def test_a_completed_run_sends_exactly_kind_ref_text_and_agent_id(self, sqs, warning):

        assert run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, 'completed') is True

        sqs.send_message.assert_called_once_with(QueueUrl=QUEUE_URL, MessageBody=json.dumps({
            'kind': 'agent_run',
            'ref': RUN_ID,
            'text': f'{HEADER}\n[node_started] Reading feedback\n[node_finished] Wrote the PRD',
            'agent_id': AGENT_ID,
        }))
        warning.assert_not_called()

    @pytest.mark.usefixtures('queue_env')
    def test_the_agent_name_comes_from_the_store_row(self, sqs, agent_store):

        run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, 'completed')

        agent_store.get_agent.assert_called_once_with(AGENT_ID)
        body = json.loads(sqs.send_message.call_args.kwargs['MessageBody'])
        assert body['text'].startswith('Autonomous agent "Checkout agent" run')

    @pytest.mark.usefixtures('queue_env')
    @pytest.mark.parametrize('agent', [None, {}, {'name': ''}, {'name': None}])
    def test_a_missing_or_nameless_agent_falls_back_to_its_id(self, sqs, agent_store, agent):
        agent_store.get_agent.return_value = agent

        assert run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, 'completed') is True

        body = json.loads(sqs.send_message.call_args.kwargs['MessageBody'])
        assert body['text'].startswith(f'Autonomous agent "{AGENT_ID}" run {RUN_ID} finished: completed.')

    @pytest.mark.usefixtures('queue_env')
    def test_needs_human_is_a_memory_source_and_the_status_is_in_the_header(self, sqs):

        assert run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, store.RUN_NEEDS_HUMAN) is True

        body = json.loads(sqs.send_message.call_args.kwargs['MessageBody'])
        assert body['text'].startswith(
            f'Autonomous agent "Checkout agent" run {RUN_ID} finished: needs_human.')


class TestEveryRefusalIsSilent:
    @pytest.mark.usefixtures('queue_env')
    @pytest.mark.parametrize('status', [store.RUN_FAILED, store.RUN_CANCELLED, store.RUN_RUNNING, '', 'done'])
    def test_a_status_that_is_not_memorable_sends_nothing(self, sqs, warning, agent_store, status):

        assert run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, status) is False

        agent_store.get_agent.assert_not_called()
        sqs.send_message.assert_not_called()
        warning.assert_not_called()

    def test_an_unset_queue_url_sends_nothing(self, monkeypatch, sqs, warning, agent_store):
        monkeypatch.delenv('MEMORY_EXTRACT_QUEUE_URL', raising=False)

        assert run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, 'completed') is False

        agent_store.get_agent.assert_not_called()
        sqs.send_message.assert_not_called()
        warning.assert_not_called()

    def test_the_queue_url_is_read_from_memory_extract_queue_url_only(self, monkeypatch, sqs, agent_store):
        monkeypatch.delenv('MEMORY_EXTRACT_QUEUE_URL', raising=False)
        monkeypatch.setenv('XXMEMORY_EXTRACT_QUEUE_URLXX', QUEUE_URL)

        assert run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, 'completed') is False

        agent_store.get_agent.assert_not_called()
        sqs.send_message.assert_not_called()
        assert run_memory.QUEUE_ENV == 'MEMORY_EXTRACT_QUEUE_URL'

    @pytest.mark.usefixtures('queue_env')
    def test_an_empty_agent_id_sends_nothing(self, sqs, warning, agent_store):

        assert run_memory.enqueue_finished_run('', RUN_ID, 'completed') is False

        agent_store.get_agent.assert_not_called()
        sqs.send_message.assert_not_called()
        warning.assert_not_called()


@pytest.mark.usefixtures('agent_store')
class TestAQueueFailureIsLoggedNotRaised:
    @pytest.mark.usefixtures('queue_env')
    def test_a_send_error_returns_false_and_logs_the_exact_warning(self, sqs, warning):
        sqs.send_message.side_effect = RuntimeError('queue gone')

        assert run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, 'completed') is False

        warning.assert_called_once_with(
            'Agent run not queued for memory', extra={'agent_id': AGENT_ID, 'run_id': RUN_ID})

    @pytest.mark.usefixtures('queue_env')
    def test_a_store_error_is_handled_the_same_way(self, sqs, warning, agent_store):
        agent_store.get_agent.side_effect = RuntimeError('table gone')

        assert run_memory.enqueue_finished_run(AGENT_ID, RUN_ID, 'completed') is False

        sqs.send_message.assert_not_called()
        warning.assert_called_once_with(
            'Agent run not queued for memory', extra={'agent_id': AGENT_ID, 'run_id': RUN_ID})
