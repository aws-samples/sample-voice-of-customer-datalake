"""The run workspace's inspector tabs (engineering/views_inspector.py): an agent's changes from its S3 patches (D51-1)
with the links to its pull request and pushed change, one file of a patch, the files it read and wrote, its gate, its
memory; and the patch parser on git's own shapes (renames, binary files, ``/dev/null``, ``\\ No newline``)."""
from __future__ import annotations

from collections.abc import Iterator

import pytest
from moto import mock_aws

from engineering.run_objects import RunObjects
from engineering.test import run_workspace_world as world
from engineering.views_inspector import AgentTabs, patch_files
from engineering.views_thread import Subject, ThreadView


@pytest.fixture
def tabs() -> Iterator[AgentTabs]:
    with mock_aws():
        built = world.build()
        objects = RunObjects(built.s3, world.BUCKET)
        yield AgentTabs(built.client, world.TABLE, objects, ThreadView(built.client, world.TABLE, objects))


def _agent(tabs: AgentTabs, agent: str = world.FIXER) -> Subject:
    subject = tabs.thread.subject(world.RUN, agent)
    assert subject is not None
    return subject


def test_a_patch_is_read_into_its_files() -> None:
    files = [file.view() for file in patch_files(world.PATCH)]
    assert files == [
        {'path': 'src/paging.py', 'status': 'modified', 'additions': 1, 'deletions': 1, 'binary': False},
        {'path': 'tests/test_paging.py', 'status': 'added', 'additions': 6, 'deletions': 0, 'binary': False},
        {'path': 'docs/paging.md', 'status': 'renamed', 'additions': 1, 'deletions': 1, 'binary': False,
         'old_path': 'docs/old-paging.md'},
        {'path': 'assets/logo.png', 'status': 'modified', 'additions': 0, 'deletions': 0, 'binary': True}]


@pytest.mark.parametrize(('patch', 'expected'), [
    ('diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
     ('gone.txt', '', 'deleted', 0, 1)),
    ('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n', ('b', 'a', 'renamed', 0, 0)),
    ('diff --git a/x.py b/y.py\nsimilarity index 80%\ncopy from x.py\ncopy to y.py\n', ('y.py', 'x.py', 'copied', 0, 0)),
    # (a space in the path; a hunk line that looks like a header is a line of the hunk)
    ('diff --git a/my file.txt b/my file.txt\n--- a/my file.txt\n+++ b/my file.txt\n@@ -1,2 +1,2 @@\n--- a\n+++ b\n',
     ('my file.txt', '', 'modified', 1, 1)),
    ('diff --git a/new.bin b/new.bin\nnew file mode 100644\nBinary files /dev/null and b/new.bin differ\n',
     ('new.bin', '', 'added', 0, 0)),
    (('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n'
      '@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n'), ('café.txt', '', 'modified', 1, 1)),
    ('diff --git a/t.txt b/t.txt\n--- a/t.txt\t2026-11-17 09:00\n+++ b/t.txt\t2026-11-17 09:01\n@@ -1 +1 @@\n-a\n+b\n',
     ('t.txt', '', 'modified', 1, 1)),
])
def test_the_parser_reads_gits_shapes(patch: str, expected: tuple[str, str, str, int, int]) -> None:
    [file] = patch_files(patch)
    assert (file.path, file.old_path, file.status, file.additions, file.deletions) == expected
    assert patch[file.start:file.end] == patch


def test_the_changes_are_the_newest_submitted_patch_with_every_patch_and_the_links(tabs: AgentTabs) -> None:
    changes = tabs.changes(_agent(tabs), source=None, attempt=None, key=None)
    assert (changes['source'], changes['key'], changes['commit'], changes['attempt']) == (
        'submitted', world.SUBMITTED_KEY, world.COMMIT, 2)
    assert [file['path'] for file in changes['files']] == ['src/paging.py', 'tests/test_paging.py', 'docs/paging.md',
                                                           'assets/logo.png']
    assert [(patch['source'], patch['at']) for patch in changes['patches']] == [
        ('submitted', '2026-11-17T09:24:00Z'), ('checkpoint', '2026-11-17T09:18:00Z')]
    assert changes['pr_url'] == f'https://github.com/{world.REPO}/pull/42'
    assert changes['commit_url'] == f'https://github.com/{world.REPO}/compare/main...{world.BRANCH}'


def test_a_checkpoints_patch_and_a_missing_source_are_read_as_asked(tabs: AgentTabs) -> None:
    fixer = _agent(tabs)
    checkpoint = tabs.changes(fixer, source='checkpoint', attempt=None, key=None)
    assert (checkpoint['key'], [file['additions'] for file in checkpoint['files']]) == (world.CHECKPOINT_KEY, [2])
    other_attempt = tabs.changes(fixer, source=None, attempt=1, key=None)
    assert (other_attempt['key'], other_attempt['files'], other_attempt['patches']) == (None, [], [])
    gate = tabs.changes(_agent(tabs, world.GATE_RUNNER), source='submitted', attempt=None, key=None)
    assert (gate['source'], gate['key']) == ('submitted', None)


def test_a_pushed_change_without_a_pull_request_links_through_its_connections_host(tabs: AgentTabs) -> None:
    tabs.client.delete_item(TableName=world.TABLE, Key={'pk': {'S': f'WS#default#WRITES#{world.RUN}'},
                                                        'sk': {'S': 'PULL_REQUEST'}})
    asked: list[str] = []
    changes = tabs.changes(_agent(tabs), source=None, attempt=None, key=None,
                           host=lambda connection: asked.append(connection) or 'gitlab')
    assert (changes['pr_url'], changes['commit_url'], asked) == (
        None, f'https://gitlab.com/{world.REPO}/-/compare/main...{world.BRANCH}', ['conn-storefront'])


def test_one_file_of_a_patch_is_its_part_of_the_patch(tabs: AgentTabs) -> None:
    found = tabs.file_patch(_agent(tabs), world.SUBMITTED_KEY, 'docs/old-paging.md')   # (a rename, by its old path)
    assert found is not None
    assert (found['path'], found['truncated']) == ('docs/paging.md', False)
    assert found['patch'].startswith('diff --git a/docs/old-paging.md b/docs/paging.md\n')
    assert found['patch'].endswith('\\ No newline at end of file\n')
    assert tabs.file_patch(_agent(tabs), world.SUBMITTED_KEY, 'src/none.py') is None
    assert tabs.file_patch(_agent(tabs), world.SUBMITTED_KEY.replace('fixer-3', 'fixer-9'), 'src/paging.py') is None


def test_the_files_are_what_its_tool_calls_read_listed_and_wrote(tabs: AgentTabs) -> None:
    assert tabs.files(_agent(tabs)) == {'files': [
        {'path': 'src/paging.py', 'read': 1, 'written': 1, 'listed': 0, 'last_at': '2026-11-17T09:14:00.000000Z'},
        {'path': 'tests', 'read': 0, 'written': 0, 'listed': 1, 'last_at': '2026-11-17T09:22:00.000000Z'}],
        'truncated': False}


def test_the_gate_is_its_record_and_its_latest_runs_checks_with_their_output(tabs: AgentTabs) -> None:
    gate = tabs.gate(_agent(tabs, world.GATE_RUNNER))
    assert (gate['key'], gate['record']['verdict'], gate['passed'], gate['packs']) == (
        world.GATE_RECORD_KEY, 'GO', True, ['python'])
    assert [(check['key'], check['output_tail']) for check in gate['checks']] == [
        ('python.tests', '..........\n10 passed in 4.1s'), ('python.lint', 'All checks passed!')]
    # (an agent that ran no gate and wrote no record: nothing read, no key asked for)
    assert tabs.gate(_agent(tabs)) == {'key': None, 'record': None, 'checks': [], 'passed': None, 'packs': [],
                                       'ran_at': None}


def test_the_memory_is_its_briefs_lessons_and_what_learn_made_of_its_task(tabs: AgentTabs) -> None:
    memory = tabs.memory(_agent(tabs))
    assert memory['recalled'] == [{'name': 'memory:1', 'text': 'In storefront, paging helpers live in src/paging.py '
                                                               'and are tested in tests/.'}]
    assert [(learned['memory_id'], learned['proposed_version']) for learned in memory['learned']] == [('mem-paging-1', 4)]
    assert tabs.memory(_agent(tabs, world.GATE_RUNNER)) == {'recalled': [], 'learned': []}
