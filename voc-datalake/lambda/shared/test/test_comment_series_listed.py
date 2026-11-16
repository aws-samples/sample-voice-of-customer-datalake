"""Every writer of a comment thread lists its series first (7.48.00, projects 3g-d; docs/multi-workspace.md, 3g-d).

An erasure by email finds a deployment's comment partitions (``DCOMMENTS#{project}#{series}``) through the deployment's
series registry (``COMMENT_SERIES_IDS``) once the backfill's marker is there, so a thread written without its series
listed would hold a reviewer's address no erasure reaches. This guard reads the source (nothing is imported):

* every module under ``lambda/``, ``plugins/`` and ``scripts/`` that names a comment partition AND writes to a table is
  listed in ``WRITERS`` with how it keeps the rule (it lists the series, or it only updates or deletes rows that exist);
* a thread row is built by ``thread_item`` and written only by ``put_thread`` (which lists the series): every module
  that builds one also writes it through ``put_thread``;
* the one generic copier of rows, the project bundle's import, lists each copied comment partition's series (its own
  behaviour test is in test_project_bundle_scripts.py); it names it here, so a second copier cannot appear unlisted;
* every module that makes a project (a ``META`` on ``gsi1-by-type``) lists it in the deployment's project registry
  (``PROJECT_IDS``), and the bundle import lists each project it copies, or says here why not.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parents[3]
SCANNED: Final = ('lambda', 'plugins', 'scripts')
#: How a module names a comment partition.
_NAMES_A_PARTITION: Final = re.compile(r"comments_pk\(|comment_key\(|COMMENT_PARTITION_PREFIX|['\"]DCOMMENTS#")
#: How a module writes to a table.
_WRITES: Final = re.compile(r'\.(put_item|update_item|delete_item|batch_writer|transact_write_items)\(|'
                            r'transact_project_writes\(|batch_delete\(')
#: Each module that names a comment partition and writes, and how it keeps the rule.
WRITERS: Final = {
    'lambda/shared/document_comments.py': 'put_thread lists the series (list_series, list_deployment_series) first',
    'lambda/shared/document_share.py': "create_share lists the series in the link's own transaction",
    'lambda/jobs/retention/project_people.py': 'updates existing threads only (de-identification)',
    'lambda/jobs/workspace_delete/sweeps.py': "deletes a workspace's threads only",
}
#: The generic copiers of stored rows, which list every copied comment partition's series and the copied project.
COPIERS: Final = {'scripts/project_bundle/importer.py': ('list_copied_series', 'list_imported_project')}
#: How a module makes a project: a ``META`` put on ``gsi1-by-type``'s project partition.
_MAKES_A_PROJECT: Final = re.compile(
    r"gsi1pk['\"]?\s*[:=]\s*\(?\s*(project_type_pk\(|PROJECT_TYPE_PK|['\"]TYPE#PROJECT)")
#: Each module that makes a project, and how it keeps the deployment's project registry (``PROJECT_IDS``).
PROJECT_CREATORS: Final = {
    'lambda/api/projects.py': 'register_deployment_project(',
    # Not listed, on purpose: a verification fixture's project holds no person's data (its rows carry the
    # verification run's ids, no owner, member or reviewer), expires by its own ttl, and its teardown proves zero
    # rows remain, so no erasure has anything to find there.
    'lambda/api/verification_fixture_provider.py': None,
}


def _sources() -> dict[str, str]:
    found = {}
    for folder in SCANNED:
        for path in (ROOT / folder).rglob('*.py'):
            rel = path.relative_to(ROOT).as_posix()
            if any(part in ('test', 'tests', 'layers', 'node_modules', '__pycache__', '.venv') for part in path.parts):
                continue
            found[rel] = path.read_text(encoding='utf-8')
    return found


def test_every_module_that_writes_a_comment_partition_is_listed_with_its_rule():
    writers = {rel for rel, text in _sources().items() if _NAMES_A_PARTITION.search(text) and _WRITES.search(text)}
    assert sorted(writers - set(WRITERS)) == []
    assert sorted(set(WRITERS) - writers) == []


def test_the_thread_writer_lists_its_series_in_both_scopes():
    text = _sources()['lambda/shared/document_comments.py']
    body = text[text.index('def put_thread('):]
    body = body[:body.index('\ndef ', 1)]
    assert 'list_deployment_series(' in body
    assert 'list_series(' in body


def test_every_module_that_builds_a_thread_writes_it_through_put_thread():
    builders = {rel for rel, text in _sources().items() if re.search(r'\bthread_item\(', text)}
    assert builders
    assert sorted(rel for rel in builders if not re.search(r'\bput_thread\(', _sources()[rel])) == []


def test_each_generic_copier_lists_the_series_and_the_project_it_copies():
    for rel, helpers in COPIERS.items():
        for helper in helpers:
            assert f'{helper}(' in _sources()[rel], (rel, helper)


def test_every_module_that_makes_a_project_lists_it_in_the_deployments_registry():
    """A project made without its ``PROJECT_IDS`` row would drop out of an erasure by email once deleted (the delete
    takes its ``META`` off ``gsi1-by-type``)."""
    creators = {rel for rel, text in _sources().items() if _MAKES_A_PROJECT.search(text)}
    assert sorted(creators ^ set(PROJECT_CREATORS)) == []
    for rel, call in PROJECT_CREATORS.items():
        assert call is None or call in _sources()[rel], rel
