"""shared/'s spelling of the keys the product-doc extractor spells itself (docs/multi-workspace.md, the project plan, 3f).

The extractor (lambda/product_doc_extractor/handler.py) is a stdlib-only bundle with no shared/, so it spells a
project's partition, a project id's claim, a workspace's ``META`` and a product document's object keys itself. Both
suites read the same cases, ``voc-datalake/schemas/project-keys-cases.json``: this one holds shared/'s builders and
readers (and the API's object keys) to them, lambda/product_doc_extractor/test/test_project_keys_lockstep.py the
extractor's, so neither side can change a key alone.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch
from urllib.parse import unquote_plus

import pytest

from api import product_context
from api.product_context import (
    ALLOWED_CONTENT_TYPES,
    DOC_SK_PREFIX,
    product_doc_extracted_key,
    product_doc_raw_key,
)
from api.projects import product_docs_project_prefix
from shared.model_config import MODEL_DEFAULT_KEY, MODEL_SETTINGS_PK
from shared.project_keys import project_pk
from shared.row_ids import LONG_OPAQUE_ID_RE
from shared.test.repo_paths import repo_root
from shared.workspace_ids import is_workspace_id
from shared.ws_repo import WorkspaceScope, WorkspaceStatusCache, project_claim, workspace_is_active

_SPEC: dict[str, Any] = json.loads((repo_root() / 'schemas' / 'project-keys-cases.json').read_text(encoding='utf-8'))


def _params(*, workspace_only: bool) -> list[Any]:
    """Each case with its id (its scope and extension); the workspace cases alone for the claim's and status's reads."""
    return [pytest.param(case, id=f"{case['workspace'] or 'deployment'}:{case['ext']}") for case in _SPEC['cases']
            if case['workspace'] is not None or not workspace_only]


_CASES = _params(workspace_only=False)
_WORKSPACE_CASES = _params(workspace_only=True)


def _scope(case: dict[str, Any]) -> WorkspaceScope | None:
    return None if case['workspace'] is None else WorkspaceScope(case['workspace'])


def test_the_cases_cover_both_scopes():
    assert {case['workspace'] is None for case in _SPEC['cases']} == {True, False}


def test_the_extractors_id_expressions_are_shareds():
    """The strict parse of a workspace's upload key (handler.py WORKSPACE_RAW_KEY_PATTERN) uses shared/'s id rules,
    spelled again: the workspace id (shared/workspace_ids.py) and the opaque project and document id
    (shared/row_ids.py LONG_OPAQUE_ID_RE). Imported here, not at collection: the extractor reads its configuration
    when it is first imported."""
    from product_doc_extractor import handler as extractor
    from shared import workspace_ids

    assert workspace_ids._WORKSPACE_ID.pattern == extractor.WORKSPACE_ID_REGEX
    assert rf'^{extractor.OPAQUE_ID_REGEX}\Z' == LONG_OPAQUE_ID_RE.pattern


#: Each rule a rejected key's bad segment breaks, as shared/ (or the upload boundary) states it: True when it holds.
_RULES = {
    'workspace_id': is_workspace_id,
    'opaque_id': lambda segment: LONG_OPAQUE_ID_RE.fullmatch(segment) is not None,
    'extension': lambda segment: segment in set(ALLOWED_CONTENT_TYPES.values()),
}
#: A workspace upload's key has seven segments: ws, {ws}, projects, {id}, product_docs, raw, {doc}.{ext}.
_UPLOAD_KEY_SEGMENTS = 7


@pytest.mark.parametrize('rejected', _SPEC['rejected_keys'], ids=lambda rejected: rejected['why'])
def test_every_rejected_key_breaks_a_rule_shared_states(rejected):
    """Each rejected key's bad segment is in it, and shared/'s own rule refuses that segment too (the workspace id,
    a project or document id, the extension), or the key has a segment where none goes: the extractor is neither
    stricter nor looser than the layer about the ids a key names."""
    decoded = unquote_plus(rejected['key'])
    assert rejected['segment'] in decoded
    if rejected['rule'] == 'shape':
        assert len(decoded.split('/')) != _UPLOAD_KEY_SEGMENTS
    else:
        assert not _RULES[rejected['rule']](rejected['segment'])


def test_the_upload_extensions_are_the_boundarys():
    assert _SPEC['upload_extensions'] == sorted(set(ALLOWED_CONTENT_TYPES.values()))


@pytest.mark.parametrize('case', _CASES)
def test_the_document_row_is_the_project_partitions(case):
    assert {'pk': project_pk(case['project_id'], workspace=_scope(case)),
            'sk': f"{DOC_SK_PREFIX}{case['doc_id']}"} == case['doc_row']


@pytest.mark.parametrize('case', _CASES)
def test_the_upload_and_its_text_are_under_the_projects_document_prefix(case):
    scope = _scope(case)
    assert product_doc_raw_key(case['project_id'], case['doc_id'], case['ext'], workspace=scope) == case['raw_key']
    prefix = product_docs_project_prefix(case['project_id'], workspace=scope)
    assert prefix == case['doc_prefix']
    # A document's delete reaches the text by this key; the project delete sweeps the prefix, so it reaches it too.
    extracted = product_doc_extracted_key(case['project_id'], case['doc_id'], workspace=scope)
    assert extracted == case['extracted_key']
    assert extracted.startswith(prefix)


def test_the_model_rows_are_the_model_settings():
    assert [MODEL_SETTINGS_PK, MODEL_DEFAULT_KEY['pk']] == _SPEC['model_rows']


def test_every_attribute_the_extractor_reads_is_one_the_upload_route_writes():
    """doc_read_attributes, the extractor's projection of a workspace's record, names attributes the record has: the
    ones create_upload_url writes (a record without them would read as malformed, never as another's)."""
    table = MagicMock()
    table.name = 'test-projects'
    table.query.return_value = {'Items': []}
    # The record is written in a transaction (shared/project_writes.py): each Put lands as a put_item here.
    table.meta.client.transact_write_items.side_effect = lambda *, TransactItems: [
        table.put_item(Item=action['Put']['Item']) for action in TransactItems if 'Put' in action] and {}
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = 'https://example-bucket.s3.amazonaws.com/signed'
    with patch.object(product_context, 'projects_table', table), patch.object(product_context, '_s3', return_value=s3):
        product_context.create_upload_url('proj-1', {'filename': 'a.md', 'content_type': 'text/markdown',
                                                     'size_bytes': 10})

    written = table.put_item.call_args.kwargs['Item']
    assert set(_SPEC['doc_read_attributes']) <= set(written)


@pytest.mark.parametrize('case', _WORKSPACE_CASES)
def test_the_claim_is_read_with_the_extractors_request(case):
    table = MagicMock()
    table.get_item.return_value = {'Item': {'workspace_id': case['workspace']}}

    assert project_claim(table, case['project_id']) == WorkspaceScope(case['workspace'])
    assert [request.kwargs for request in table.get_item.call_args_list] == [case['claim_read']]


@pytest.mark.parametrize('case', _WORKSPACE_CASES)
def test_the_status_is_read_with_the_extractors_request(case):
    meta = {'pk': f"WS#{case['workspace']}", 'sk': 'META', 'status': 'active'}
    table = MagicMock()
    table.get_item.return_value = {'Item': meta}

    assert workspace_is_active(table, WorkspaceScope(case['workspace']), WorkspaceStatusCache())
    assert [request.kwargs for request in table.get_item.call_args_list] == [case['status_read']]
