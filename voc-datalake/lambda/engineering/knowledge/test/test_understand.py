"""The fictional monorepo's web package through map and reduce on moto and the recorded fake, across two calls."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest

from engineering.board.test.table import TABLE
from engineering.knowledge.notes import Note
from engineering.knowledge.reduce import Edit
from engineering.knowledge.shards import Budget, Entry
from engineering.knowledge.store import DRAFT, Actor, PackStore
from engineering.knowledge.test.fixtures import MANIFESTS, PATHS, SHA_A, SHA_B, WEB_URL, pack_tables, rules
from engineering.knowledge.understand import Refreshed, RunPlace, Sources, understand_package
from engineering.knowledge.workspaces import Package, detect
from engineering.quality_gate.test.gate_fakes import RecordedModel
from engineering.workspace.layout import agent_shard_key, knowledge_key, parse_agent_key
from engineering.workspace.store import WorkspaceStore

CONN = 'conn-harbor'
RUN = '01JD0000000000000000000000'
AGENT = Actor('mapper-0', 'agent')
ADMIN = Actor('admin-sub-1', 'person', admin=True)
LAYOUT = detect(PATHS, MANIFESTS)
WEB = next(p for p in LAYOUT.packages if p.path == 'packages/web')
COMMENT = f'{WEB_URL}/pull/12#discussion_r900'
TEXTS = {path: f'// {path}\nexport const x = 1\n' for path in LAYOUT.files['packages/web']}
TEXTS |= {SHA_A: 'feat(web): add the home route', SHA_B: 'fix(web): keep the session', '12': f'{{"html_url": "{COMMENT}", "body": "Please add a test."}}'}


def note(kind: str, claim: str, *citations: str, subject: str = '', package: str = 'packages/web') -> str:
    return json.dumps({'schema': 'voc-note/1', 'kind': kind, 'package': package, 'subject': subject, 'claim': claim,
                       'citations': list(citations)})


@dataclass
class World:
    s3: Any
    workspace: WorkspaceStore
    store: PackStore


@pytest.fixture
def world() -> Iterator[World]:
    with pack_tables() as (client, s3, workspace):
        yield World(s3, workspace, PackStore(client, TABLE, workspace))


def run(world: World, model: RecordedModel, mapped: dict[str, str], max_shards: int, package: Package = WEB,
        attempt: int = 1) -> Refreshed:
    sources = Sources(files=[Entry(p, len(TEXTS[p])) for p in LAYOUT.files[package.path]],
                      commits_newest_first=[Entry(SHA_B, 30), Entry(SHA_A, 30)], pull_requests=[Entry('12', 20)],
                      read=TEXTS.get)
    return understand_package(
        place=RunPlace('default', RUN, 'mapper-0', SHA_B, attempt), connection=CONN, package=package,
        packages=LAYOUT.packages, sources=sources, budget=Budget(), model=model, rules=rules(), workspace=world.workspace,
        store=world.store, mapped=mapped, max_shards=max_shards, author=AGENT)


def first_model() -> RecordedModel:
    return RecordedModel({
        'mapper:files': ['\n'.join([
            note('architecture', 'Routes live under src/routes.', 'packages/web/src/routes/home.ts:1', subject='routes'),
            note('convention', 'Exports are named, never default.', 'packages/web/src/app.ts:2', subject='exports'),
            note('glossary', 'A note about billing.', 'services/billing/billing/invoice.py:1', package='services/billing'),
        ])],
        'mapper:history': [note('how-we-work', 'Commit messages follow a type(scope) prefix.', SHA_A, SHA_B,
                                subject='commit messages')],
        'mapper:pull_requests': [note('review-guide', 'Reviewers ask for a test with each change.', COMMENT,
                                      'nowhere.ts:1', subject='tests')],
    })


def test_a_package_is_mapped_across_calls_then_reduced_into_a_draft(world: World) -> None:
    model = first_model()
    first = run(world, model, {}, max_shards=2)
    assert (first.version, first.remaining, len(first.mapped)) == (None, 1, 2)
    assert first.dropped == {'package': 1}   # the billing note is not the web package's
    for key in first.mapped.values():
        parsed = parse_agent_key(key)
        assert parsed is not None
        assert (parsed.package, parsed.agent, parsed.attempt) == ('packages/web', 'mapper-0', 1)
    second = run(world, model, dict(first.mapped), max_shards=2)
    assert len(second.mapped) == 1
    assert second.remaining == 0
    assert second.citations_removed == 1   # nowhere.ts is not listed
    assert [r.agent for r in model.requests] == ['mapper:files', 'mapper:history', 'mapper:pull_requests']
    version = second.version
    assert version is not None
    assert (version.version, version.status, version.author, version.built_from, version.base_version) == (
        1, DRAFT, 'mapper-0', SHA_B, 0)
    review = world.workspace.read_text(knowledge_key('default', CONN, 'packages/web', 1, 'review-guide.md'))
    assert review is not None
    assert 'Reviewers ask for a test with each change.[^1]' in review
    assert review.endswith(f'[^1]: <{COMMENT}>\n')
    assert world.store.latest_approved('default', CONN, 'packages/web') is None   # a draft until approved


def test_a_refresh_starts_from_the_approved_version_and_flags_what_contradicts_an_edit(world: World) -> None:
    model = first_model()
    done = run(world, model, {}, max_shards=10)
    assert done.version is not None
    world.store.approve('default', CONN, 'packages/web', done.version.version, ADMIN)
    approved = world.store.latest_approved('default', CONN, 'packages/web')
    assert approved is not None
    exports = approved.pack.documents['convention'][0]
    edit = Note('convention', 'packages/web', 'Default exports are allowed for pages.', (), 'exports', ADMIN.id)
    edited = world.store.edit('default', CONN, 'packages/web', 1, [Edit(edit, replaces=exports.id)], ADMIN,
                              rules())
    world.store.approve('default', CONN, 'packages/web', edited.version, ADMIN)
    again = run(world, first_model(), {}, max_shards=10, attempt=2)
    assert again.version is not None
    assert (again.version.version, again.version.base_version) == (3, 2)
    pack = json.loads(world.workspace.read_text(knowledge_key('default', CONN, 'packages/web', 3, 'pack.json')) or '')
    assert [c['claim'] for c in pack['documents']['convention']] == ['Default exports are allowed for pages.']
    assert [f['claim']['claim'] for f in pack['flagged']] == ['Exports are named, never default.']


def test_what_an_agent_wrote_is_checked_again_before_the_reduce(world: World) -> None:
    model = RecordedModel({'mapper:files': [''], 'mapper:history': [''], 'mapper:pull_requests': ['']})
    first = run(world, model, {}, max_shards=10)
    assert first.version is not None
    assert first.version.version == 1
    files_shard = next(s for s in first.mapped if s.startswith('files-'))
    # The same agent's object of a later attempt (a retried lease writes its own), holding a citation the package
    # never listed: read as data, its notes are checked again.
    retried = agent_shard_key('default', RUN, 'mapper-0', SHA_B, 'packages/web', 2, f'{files_shard}.jsonl')
    world.workspace.put_once(retried, note('ci', 'Deploys skip the tests.', 'unlisted.sh:1') + '\n' + note(
        'ci', 'CI runs the unit tests.', 'packages/web/src/app.ts:1') + '\n', 'application/x-ndjson')
    second = run(world, RecordedModel({}), {**first.mapped, files_shard: retried}, max_shards=10)
    assert second.dropped == {'citation': 1}
    ci = world.workspace.read_text(knowledge_key('default', CONN, 'packages/web', 2, 'ci.md')) or ''
    assert 'CI runs the unit tests.' in ci
    assert 'skip the tests' not in ci


OTHER_RUN = '01JD0000000000000000000001'


@pytest.mark.parametrize('foreign', [
    ('other-ws', RUN, 'mapper-0', SHA_B, 'packages/web'),        # another workspace
    ('default', OTHER_RUN, 'mapper-0', SHA_B, 'packages/web'),   # another run
    ('default', RUN, 'mapper-1', SHA_B, 'packages/web'),         # another agent
    ('default', RUN, 'mapper-0', SHA_A, 'packages/web'),         # another commit
    ('default', RUN, 'mapper-0', SHA_B, 'packages/api'),         # another package
])
def test_a_result_key_that_is_not_this_refreshs_own_is_never_read(world: World,
                                                                    foreign: tuple[str, str, str, str, str]) -> None:
    model = RecordedModel({'mapper:files': [''], 'mapper:history': [''], 'mapper:pull_requests': ['']})
    first = run(world, model, {}, max_shards=10)
    files_shard = next(s for s in first.mapped if s.startswith('files-'))
    key = agent_shard_key(*foreign, 1, f'{files_shard}.jsonl')
    world.workspace.put_once(key, note('ci', 'CI is optional.', 'packages/web/src/app.ts:1') + '\n',
                             'application/x-ndjson')
    second = run(world, RecordedModel({}), {**first.mapped, files_shard: key}, max_shards=10)
    assert (second.version, second.unreadable, second.remaining) == (None, (files_shard,), 1)
    assert [v.version for v in world.store.versions('default', CONN, 'packages/web')] == [1]


def test_a_result_key_naming_another_shard_or_off_the_layout_is_never_read(world: World) -> None:
    model = RecordedModel({'mapper:files': [''], 'mapper:history': [''], 'mapper:pull_requests': ['']})
    first = run(world, model, {}, max_shards=10)
    files_shard, history_shard = (next(s for s in first.mapped if s.startswith(p)) for p in ('files-', 'history-'))
    swapped = {**first.mapped, files_shard: first.mapped[history_shard], history_shard: 'ws/default/elsewhere.jsonl'}
    second = run(world, RecordedModel({}), swapped, max_shards=10)
    assert second.unreadable == (files_shard, history_shard)


def test_a_mapped_shard_whose_notes_are_gone_stops_the_publish_and_is_named(world: World) -> None:
    model = RecordedModel({'mapper:files': [''], 'mapper:history': [''], 'mapper:pull_requests': ['']})
    first = run(world, model, {}, max_shards=10)
    assert first.version is not None
    assert first.unreadable == ()   # empty notes objects are shards with no notes, read as such
    history = next(s for s in first.mapped if s.startswith('history-'))
    gone = {**first.mapped, history: first.mapped[history].replace('attempt-1', 'attempt-9')}
    second = run(world, RecordedModel({}), gone, max_shards=10)
    assert (second.version, second.remaining, second.unreadable) == (None, 1, (history,))
    assert [v.version for v in world.store.versions('default', CONN, 'packages/web')] == [1]
