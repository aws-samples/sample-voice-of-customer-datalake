"""A session's transcript (harness/transcript.py) and the run's manifest and index entry (runtime/manifest.py)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import pytest

from engineering.runtime import manifest
from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.harness.converse_loop import ConverseAdapter
from engineering.runtime.harness.transcript import FLUSH_BYTES, MAX_TEXT, SCHEMA, Transcript
from engineering.runtime.runs import Run, RunCaps
from engineering.runtime.test.harness_fakes import HARNESS_COMMIT, RUN_ID, FakeBedrock, use, world
from engineering.workspace.layout import parse_agent_key

PREFIX = artifact_prefix(RUN_ID, 'fixer-1', HARNESS_COMMIT, 1, 'transcripts')


class Taken(Exception):
    @property
    def response(self) -> dict[str, Any]:
        return {'Error': {'Code': 'PreconditionFailed'}}


@dataclass
class CreateOnly:
    """The workspace bucket: a put of a key that exists is refused (If-None-Match)."""

    objects: dict[str, bytes] = field(default_factory=dict)

    def put(self, key: str, body: bytes) -> None:
        if key in self.objects:
            raise Taken
        self.objects[key] = body

    def events(self) -> list[dict[str, Any]]:
        return [json.loads(line) for key in sorted(self.objects) for line in self.objects[key].splitlines()]


def test_a_transcript_is_written_under_the_agents_own_keys_redacted_and_in_numbered_chunks() -> None:
    store = CreateOnly()
    transcript = Transcript(store, PREFIX, clock=lambda: 1_700_000_000.0)
    transcript.record('tool_result', tool='read_file', text='DB_PASSWORD=hunter2hunter2\nok', error=False)
    transcript.record('tool_call', tool='run', input={'argv': ['echo', 'ghp_' + 'a' * 36]})
    assert transcript.flush() == f'{PREFIX}0001.jsonl'
    assert transcript.flush() is None   # (nothing held)
    transcript.record('end', ending='done')
    assert transcript.flush() == f'{PREFIX}0002.jsonl'
    # Each chunk is one of the agent's own artifacts (the layout parses it), its events of one schema.
    assert all(parse_agent_key(key) is not None for key in store.objects)
    parsed = parse_agent_key(f'{PREFIX}0001.jsonl')
    assert parsed is not None
    assert parsed.kind == 'transcripts'
    first, second, end = store.events()
    assert (first['schema'], first['kind'], first['at']) == (SCHEMA, 'tool_result', '2023-11-14T22:13:20.000000Z')
    assert 'hunter2hunter2' not in first['text']
    assert 'ghp_' not in json.dumps(second)
    assert end['ending'] == 'done'


def test_a_continuation_goes_on_with_the_next_free_chunk_and_a_long_text_is_cut() -> None:
    store = CreateOnly({f'{PREFIX}0001.jsonl': b'{}\n', f'{PREFIX}0002.jsonl': b'{}\n'})
    transcript = Transcript(store, PREFIX)
    transcript.record('message', role='user', content=[{'text': 'x' * (MAX_TEXT * 2)}])
    assert transcript.flush() == f'{PREFIX}0003.jsonl'
    [event] = [json.loads(line) for line in store.objects[f'{PREFIX}0003.jsonl'].splitlines()]
    assert len(event['content'][0]['text']) < MAX_TEXT + 100
    assert 'characters cut' in event['content'][0]['text']


def test_a_transcript_flushes_on_its_own_past_its_bound_and_a_failed_put_keeps_its_events() -> None:
    store = CreateOnly()
    transcript = Transcript(store, PREFIX)
    for _ in range(FLUSH_BYTES // (MAX_TEXT // 2) + 2):
        transcript.record('tool_result', tool='read_file', text='y' * (MAX_TEXT // 2))
    assert list(store.objects) == [f'{PREFIX}0001.jsonl']

    class Down(CreateOnly):
        def put(self, key: str, body: bytes) -> None:
            del key, body
            raise OSError('S3 is not there')

    failing = Transcript(Down(), PREFIX)
    failing.record('end', ending='crashed')
    with pytest.raises(OSError, match='S3 is not there'):
        failing.flush()
    failing.flush_quietly()   # (a session's end: never raised)


def test_a_converse_session_records_its_messages_model_calls_tool_calls_and_checkpoints(tmp_path: Any) -> None:
    w = world(tmp_path)
    store = CreateOnly()
    w.session.context.transcript = Transcript(store, PREFIX)
    bedrock = FakeBedrock([[use('read_file', path='src/parse.py')],
                           [use('save_checkpoint', 't2', notes='found it'), use('finish', 't3', summary='fixed')]])
    assert ConverseAdapter(bedrock, 'model-a').run(w.session) == 'done'
    w.session.context.transcript.flush()
    kinds = [event['kind'] for event in store.events()]
    assert kinds[:4] == ['message', 'model_call', 'message', 'tool_call']
    assert {'tool_result', 'checkpoint'} <= set(kinds)
    model_call = next(event for event in store.events() if event['kind'] == 'model_call')
    assert (model_call['model'], model_call['tokens_in'], model_call['tokens_out']) == ('model-a', 100, 20)
    read = next(event for event in store.events() if event['kind'] == 'tool_result')
    assert read['tool'] == 'read_file'
    assert 'def parse(text)' in read['text']
    # (flushed at the checkpoint the model asked for: what a continuation starts from is in the transcript too)
    assert len(store.objects) == 2


def _run(**fields: Any) -> Run:
    return Run(run_id=RUN_ID, status='done', started_at=1_763_300_000, caps=RunCaps(max_tasks=10),
               connection='conn-1', commit=HARNESS_COMMIT, flow='01JD3R4NZXQ7Y2W8K4M6P9FLOW', repo='acme/app', **fields)


@dataclass(frozen=True)
class FakeTask:
    result_keys: tuple[str, ...]


@dataclass
class Bucket:
    objects: dict[str, str] = field(default_factory=dict)

    def put_once(self, key: str, body: str, content_type: str) -> bool:
        assert content_type == 'application/json'
        if key in self.objects:
            return False
        self.objects[key] = body
        return True


def test_the_runs_manifest_names_its_agents_sessions_models_cost_and_transcripts_and_is_indexed_once() -> None:
    agents = [
        {'sk': 'AGENT#fixer-1', 'seq': 7, 'role': 'fixer', 'task_id': 'task-1', 'task_attempt': 1,
         'status': 'done', 'model': 'global.anthropic.claude-sonnet-5-5', 'skill_version': 'fixer@template-2',
         'tokens': {'global.anthropic.claude-sonnet-5-5': {'in': 1000, 'out': 200}}, 'cost_usd': Decimal('0.0123'),
         'microvm_seconds': 61, 'commit': HARNESS_COMMIT},
        {'sk': 'AGENT#hunter-2', 'launch_hold': 0},   # (a launch hold: no session)
    ]
    built = manifest.build(_run(), agents, [FakeTask(('a/key.diff',))], revision=3,
                           learn_spend={'cost_usd': '0.002', 'tokens_in': '10', 'tokens_out': '5'})
    body = built.body
    assert (body['schema'], body['flow'], body['day'], body['status']) == (
        manifest.MANIFEST_SCHEMA, {'id': '01JD3R4NZXQ7Y2W8K4M6P9FLOW', 'revision': 3}, '2025-11-16', 'done')
    [fixer] = body['agents']
    assert (fixer['agent'], fixer['skill'], fixer['transcripts']) == ('fixer-1', 'fixer@template-2', PREFIX)
    assert body['models'] == {'global.anthropic.claude-sonnet-5-5': {'in': 1000, 'out': 200}}
    assert (body['tokens'], body['cost_usd']) == (1200, '0.0143')
    assert body['keys'] == {'transcripts': [PREFIX], 'outputs': ['a/key.diff']}
    bucket = Bucket()
    key, indexed = manifest.write(bucket, built)
    assert (key, indexed) == (f'ws/default/runs/{RUN_ID}/_manifest/v0001.json', True)
    index = f'ws/default/transcripts-index/01JD3R4NZXQ7Y2W8K4M6P9FLOW/2025-11-16/{RUN_ID}.json'
    assert json.loads(bucket.objects[index])['manifest'] == key
    # Seen again (a resumed run that ends): its next version, and the index entry kept as it was.
    assert manifest.write(bucket, built) == (f'ws/default/runs/{RUN_ID}/_manifest/v0002.json', False)
    # A run without a flow is indexed apart.
    assert manifest.index_key('', '2025-11-16', RUN_ID).startswith('ws/default/transcripts-index/no-flow/')
