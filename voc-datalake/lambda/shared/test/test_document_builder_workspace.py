"""voc-wiki's project paths per workspace, as the 7.37.00 merge left them (docs/multi-workspace.md, the project plan).

The merge brought Revise from comments, the Prototype builder's drafts, feedback and incorporation, and the document
canvas's series checks. What reads or writes a project through the version stores is threaded (a keyword-only
``workspace``, None giving the request sent before): ``series_head_version``, ``require_series_head``,
``revise_document``, ``prototype_drafts.series_head`` / ``drafted_base`` and the draft's object key. What reads the
deployment's feedback, pin forms, job rows or prototype objects refuses a workspace (``NotPerWorkspaceError``) before
anything is sent, under ``REVISE_FROM_COMMENTS_STORE`` or ``PROTOTYPE_BUILDER_STORE``, until the switch (3h).
No route passes a workspace yet.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any
from unittest.mock import MagicMock

import pytest
from moto import mock_aws

from shared import (
    document_history,
    document_revision,
    document_versions,
    prototype_drafts,
    prototype_feedback,
    prototype_incorporation,
    prototype_versions,
)
from shared.exceptions import ConflictError, NotFoundError
from shared.project_keys import (
    PROTOTYPE_BUILDER_STORE,
    REVISE_FROM_COMMENTS_STORE,
    NotPerWorkspaceError,
    document_listing,
    project_pk,
)
from shared.prototypes import prototype_draft_s3_key, prototype_draft_signed_url
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
SCOPES = (None, A, B)
PROJECT = 'proj_shared_id'
STAMP = '2026-11-15T09:00:00+00:00'
ACTOR = {'sub': 'sub-ada', 'kind': 'user'}


@pytest.fixture
def table():
    with mock_aws():
        projects = create_pk_sk_table('voc-projects-builder-test')
        metas = [{'pk': project_pk(PROJECT, workspace=scope), 'sk': 'META', 'project_id': PROJECT,
                  'document_count': 0} for scope in SCOPES]
        for meta in metas:
            projects.put_item(Item=meta)
        yield projects


def _version(table, scope, allocation: str) -> dict[str, Any]:
    return document_versions.persist_versioned_document(
        table, PROJECT, 'prd', 'Trail map', allocation,
        {'created_at': STAMP, 'content': f'Trail map in {allocation}.', **document_listing(PROJECT, STAMP,
                                                                                          workspace=scope)},
        workspace=scope)


# ── Threaded: the series head and the revised version ───────────────────────

def test_each_scope_reads_its_own_series_head(table):
    _version(table, None, 'job_1')
    _version(table, A, 'job_1')
    _version(table, A, 'job_2')
    heads = [document_versions.series_head_version(table, PROJECT, 'prd', 'Trail map', workspace=scope)
             for scope in SCOPES]
    assert heads == [1, 2, 0]


def test_a_revise_checks_and_writes_the_next_version_in_its_own_workspace(table):
    _version(table, None, 'job_1')
    _version(table, A, 'job_1')
    head = _version(table, A, 'job_2')
    document_history.require_series_head(table, PROJECT, head, workspace=A)
    with pytest.raises(ConflictError):
        document_history.require_series_head(table, PROJECT, head)
    revised = document_history.revise_document(
        table, PROJECT, head, 'Trail map, revised.', revise_id='r1', now=STAMP, actor=ACTOR,
        llm_metadata={'model': 'model-a', 'prompt_version': '1.0.0'}, workspace=A)
    assert (revised['pk'], revised['version']) == (project_pk(PROJECT, workspace=A), 3)
    heads = [document_versions.series_head_version(table, PROJECT, 'prd', 'Trail map', workspace=scope)
             for scope in SCOPES]
    assert heads == [1, 3, 0]


def test_a_drafts_base_is_read_in_its_own_workspace(table):
    _version(table, None, 'job_1')
    head = _version(table, A, 'job_1')
    assert prototype_drafts.series_head(table, PROJECT, head, workspace=A)['pk'] == project_pk(PROJECT, workspace=A)
    assert prototype_drafts.drafted_base(table, PROJECT, head, {'base_document_id': head['document_id']},
                                         workspace=A) == prototype_drafts.series_head(table, PROJECT, head,
                                                                                      workspace=A)
    with pytest.raises(NotFoundError, match='Prototype not found'):
        prototype_drafts.series_head(table, PROJECT, head, workspace=B)


def test_a_drafts_object_key_is_under_its_workspace_and_never_signed():
    assert prototype_draft_s3_key('p1', 'job_1') == 'prototypes/p1/drafts/job_1.html'
    assert prototype_draft_s3_key('p1', 'job_1', workspace=A) == f'ws/{A.ws}/prototypes/p1/drafts/job_1.html'
    assert prototype_draft_signed_url('p1', 'job_1', 'https://cdn.example/prototypes', workspace=A) is None


# ── Refused: the deployment's feedback, pin forms, job rows and objects ─────

def _refusals() -> list[tuple[str, str, Callable[[Any], Any]]]:
    document = {'document_id': 'doc_1', 'version': 1}
    return [
        ('read_evidence', REVISE_FROM_COMMENTS_STORE,
         lambda handle: document_revision.read_evidence(handle, {'input_feedback_ids': ['f1']}, None, workspace=A)),
        ('run_revision', REVISE_FROM_COMMENTS_STORE,
         lambda handle: document_revision.run_revision(
             handle, project_id=PROJECT, series_id='ser_1', document=document, document_type='prd', wanted=None,
             outcome=document_revision.OUTCOME_APPLIED, revise_id='r1', actor=ACTOR, evidence=[],
             invoke=handle, workspace=A)),
        ('PrototypeStore', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_versions.PrototypeStore(table=handle, pins_table=handle, s3=handle, bucket='b',
                                                          api_base=None, workspace=A)),
        ('put_prototype_html', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_versions.put_prototype_html(handle, 'b', PROJECT, 'doc_1', '<html>', None,
                                                              workspace=A)),
        ('read_prototype_html', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_versions.read_prototype_html(handle, 'b', PROJECT, 'doc_1', workspace=A)),
        ('version_html', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_versions.version_html(handle, 'b', PROJECT, {'document_id': 'doc_1'},
                                                        workspace=A)),
        ('put_draft_html', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_drafts.put_draft_html(handle, 'b', PROJECT, 'job_1', '<html>', workspace=A)),
        ('record_draft', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_drafts.record_draft(handle, PROJECT, 'job_1', {}, workspace=A)),
        ('draft_object_exists', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_drafts.draft_object_exists(handle, 'b', PROJECT, 'job_1', workspace=A)),
        ('series_pins', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_feedback.series_pins(handle, handle, PROJECT, document, workspace=A)),
        ('read_feedback', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_feedback.read_feedback(handle, handle, PROJECT, document, workspace=A)),
        ('selected_pins', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_incorporation.selected_pins(handle, handle, PROJECT, document, ['pin_1'],
                                                              workspace=A)),
        ('incorporate', PROTOTYPE_BUILDER_STORE,
         lambda handle: prototype_incorporation.incorporate(
             handle, draft_id='job_1', accepted=[{'pin_id': 'pin_1', 'form_id': 'form_1'}],
             outcomes=[{'pin_id': 'pin_1', 'outcome': 'done'}], new_document_id='doc_2', actor=ACTOR,
             llm_metadata=None, now=STAMP, workspace=A)),
    ]


@pytest.mark.parametrize(('name', 'store', 'call'), _refusals(), ids=[entry[0] for entry in _refusals()])
def test_a_workspace_is_refused_before_anything_is_sent(name, store, call):
    handle = MagicMock()
    with pytest.raises(NotPerWorkspaceError, match=f'^{store} is not per workspace yet$'):
        call(handle)
    assert handle.mock_calls == [], name
