"""The classification of a project's own rows for the workspace export (jobs/workspace_export/project_fields.py,
7.39.00): every attribute the project-row writers store, as scripts/audit/py_stored_attrs.py reads them, and every
top-level field of schemas/persona.schema.json, is EXPORTED or EXCLUDED, never both and never neither. So a new
attribute (a credential, or a document's new content) fails here until someone decides which it is."""
from __future__ import annotations

import ast
import importlib
import json
import re
import sys
from functools import cache
from pathlib import Path
from typing import Any, Final

import pytest

from jobs.workspace_export.project_fields import EXCLUDED, EXPORTED, classified, is_secret_name, nested_scrubbed

CDK: Final = Path(__file__).resolve().parents[4]
AUDIT: Final = CDK.parent / 'scripts' / 'audit'
#: The modules that write a project's own rows (its META, documents, product documents, context and personas).
WRITERS: Final = frozenset({
    'lambda/api/product_context.py', 'lambda/api/projects.py', 'lambda/api/projects_handler.py',
    'lambda/api/verification_fixture_provider.py', 'lambda/jobs/document_generator/handler.py',
    'lambda/jobs/document_merger/handler.py', 'lambda/jobs/persona_importer/handler.py',
    'lambda/shared/document_revision.py', 'lambda/product_doc_extractor/handler.py',
    'lambda/research/research_step_handler.py', 'lambda/shared/company_personas.py',
    'lambda/shared/decision_records.py', 'lambda/shared/document_history.py', 'lambda/shared/document_versions.py',
    'lambda/shared/human_documents.py', 'lambda/shared/methodology.py', 'lambda/shared/persona_copy.py',
    'lambda/shared/persona_replace.py', 'lambda/shared/persona_save.py', 'lambda/shared/project_writes.py',
    'lambda/shared/prototype_drafts.py', 'lambda/shared/prototype_versions.py', 'lambda/shared/deleted_sources.py',
    # 7.64.00: a persona's evidence refreshes (evidence_updates, evidence_refreshed_at).
    'lambda/shared/persona_grounding.py',
    # 7.68.00: the Validate step's META block and its plan, run and report documents.
    'lambda/shared/project_validation.py', 'lambda/shared/project_validation_routes.py',
})
#: Modules that name a project's keys and write, but none of its own rows: each has its own export allowlist or none.
NOT_PROJECT_ROW_WRITERS: Final = {
    'lambda/jobs/workspace_delete/sweeps.py': 'the hard delete: deletes, writes no project row',
    'lambda/shared/job_notices.py': 'job notices (voc-aggregates)',
    'lambda/shared/jobs.py': 'job rows in voc-jobs (project_jobs, JOB_FIELDS)',
    'lambda/shared/participants_lists.py': 'list links in voc-participants (project_lists, LIST_FIELDS)',
    'lambda/shared/document_share.py': 'review links and comment pointers (review_links, LINK_FIELDS)',
    'lambda/shared/document_comments.py': ("comment threads (document_comments, THREAD_FIELDS) and a series' row in "
                                           "a project's series list or the deployment's series registry (keys only)"),
    'lambda/jobs/workspace_delete/handler.py': "the hard delete's job row and audit rows",
    'lambda/jobs/workspace_export/projects.py': 'the export itself: reads only (its cursor keys look like writes)',
    'lambda/shared/assist_jobs.py': 'assist job rows in voc-jobs (left out of project_jobs)',
    'lambda/shared/ws_repo.py': "the workspace layer: a project id's claim and a link's routing row",
    'lambda/jobs/retention/lineage.py': ("an erasure's marks: rewrites a row's id lists and its erased_evidence, both "
                                         'classified, adds none (its cursor keys look like writes)'),
    'lambda/jobs/retention/project_people.py': ("an erasure's de-identification: removes an address from a META's "
                                                "owner_email and members and a persona's research_notes "
                                                '(classified), a thread or a link (their own allowlists), adds none '
                                                '(its cursor keys look like writes)'),
}
#: How a module shows it reaches a project's partition (a key builder or a project store's writer).
_NAMES_A_PROJECT: Final = re.compile(r'project_pk\(|project_meta_key\(|document_keys\(|put_project_item|'
                                     r'transact_project_|create_counted_project_child|project_partitions\(|'
                                     r'PROJECT#\{|PERSONA#|COMMENT_SERIES')


@cache
def _audit() -> Any:
    sys.path.insert(0, str(AUDIT))
    return importlib.import_module('py_stored_attrs')


@cache
def _stored() -> dict[str, dict[str, int]]:
    """Each production module's stored attributes (py_stored_attrs ``writes_in``), for the modules that store any."""
    audit = _audit()
    trees = {rel.as_posix(): ast.parse((CDK / rel).read_text(encoding='utf-8'))
             for rel in importlib.import_module('audit_common').walk_py(CDK)}
    helpers = audit.write_helpers({Path(rel): tree for rel, tree in trees.items()})
    writes = {rel: audit.writes_in(tree, helpers) for rel, tree in trees.items() if '/test' not in rel}
    return {rel: attributes for rel, attributes in writes.items() if attributes}


def _naming_a_project() -> set[str]:
    """The storing modules whose source names a project's keys or a project store's writer."""
    return {rel for rel in _stored() if _NAMES_A_PROJECT.search((CDK / rel).read_text(encoding='utf-8'))}


def _persona_fields() -> set[str]:
    return set(json.loads((CDK / 'schemas' / 'persona.schema.json').read_text(encoding='utf-8'))['properties'])


def _not_attributes() -> set[str]:
    """``module::name`` of each dict key the audit's allowlist says is not a DynamoDB attribute (a prompt-template
    section, a model payload's field), which its static view takes for one."""
    entries = json.loads((AUDIT / 'allowlists' / 'py_stored_attrs.json').read_text(encoding='utf-8'))['entries']
    return {entry['key'] for entry in entries if entry['reason'].startswith('Not a DynamoDB attribute')}


def test_every_stored_project_attribute_is_classified():
    # Every listed writer is one the scan reads (a renamed or moved writer fails here, never drops out quietly).
    assert sorted(WRITERS - set(_stored())) == []
    not_attributes = _not_attributes()
    stored = {name for rel in WRITERS for name in _stored()[rel]
              if f'{rel}::{name}' not in not_attributes} | _persona_fields()
    assert sorted(stored - EXPORTED - EXCLUDED) == []


def test_no_attribute_is_both_exported_and_excluded_and_the_named_ones_are_excluded():
    assert sorted(EXPORTED & EXCLUDED) == []
    assert {'token_hash', 'secret_hash', 'prototype_url', 'kiro_export_prompt', 'gsi1pk', 'gsi1sk'} <= EXCLUDED


@pytest.mark.parametrize(('name', 'secret'), [
    ('api_key', True), ('apiKey', True), ('access_token', True), ('client_secret', True), ('prompt_hash', True),
    ('email_digest', True), ('signature', True), ('password', True), ('aws_credentials', True), ('session_id', True),
    ('input_tokens', False), ('max_tokens', False), ('key_findings', False), ('design', False), ('age_range', False),
    ('s3_key', False), ('session_count', False),
])
def test_a_name_that_looks_like_a_secret(name, secret):
    assert is_secret_name(name) is secret


def test_nested_maps_lose_every_secret_named_key_at_any_depth_and_count_them():
    row = {'pk': 'P', 'llm_metadata': {'model': 'm', 'input_tokens': 3, 'request': {'api_key': 'k', 'ok': 1}},
           'identity': [{'age_range': '30s', 'auth_token': 't'}], 'text': 'plain'}
    assert nested_scrubbed(row) == ({'pk': 'P', 'llm_metadata': {'model': 'm', 'input_tokens': 3,
                                                                  'request': {'ok': 1}},
                                     'identity': [{'age_range': '30s'}], 'text': 'plain'}, 2)


def test_a_project_row_keeps_its_exported_attributes_and_each_members_listed_fields():
    item = {'pk': 'P', 'sk': 'META', 'gsi1pk': 'G', 'later': 1, 'owner_email': 'ada@example.com',
            'members': {'sub-1': {'role': 'editor', 'email': 'vic@example.com', 'invite_token': 't', 'note': 'n'}}}
    assert classified(item) == ({'pk': 'P', 'sk': 'META', 'owner_email': 'ada@example.com',
                                 'members': {'sub-1': {'role': 'editor', 'email': 'vic@example.com'}}}, 0)


def test_every_module_that_writes_and_names_a_project_is_listed():
    assert sorted(_naming_a_project() - WRITERS - set(NOT_PROJECT_ROW_WRITERS)) == []
    assert sorted(rel for rel in (*WRITERS, *NOT_PROJECT_ROW_WRITERS) if not (CDK / rel).is_file()) == []
