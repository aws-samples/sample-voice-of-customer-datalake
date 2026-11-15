"""The keys this function spells itself are shared/'s keys (docs/multi-workspace.md, the project plan, 3f).

The extractor cannot import shared/ (handler.py's module docstring), so it spells the project partition, the claim,
the workspace's META and the object keys itself. Both suites read the same cases,
``voc-datalake/schemas/project-keys-cases.json``: this one checks the handler's spelling against them,
lambda/shared/test/test_project_keys_cases.py checks shared/'s (and the API's) against the same file, so a change to
either side fails until both agree.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, call

import pytest

from .conftest import PROJECT_KEYS_SPEC as _SPEC
from .conftest import TEST_PROJECTS_TABLE, TEST_WORKSPACES_TABLE

_CASES: list[dict[str, Any]] = _SPEC['cases']
_WORKSPACE_CASES = [case for case in _CASES if case['workspace'] is not None]


def _case_id(case: dict[str, Any]) -> str:
    return f"{case['workspace'] or 'deployment'}:{case['ext']}"


def _answering(item: dict[str, Any]) -> MagicMock:
    """A table whose GetItem answers ``item``; its calls are the requests."""
    table = MagicMock()
    table.get_item.return_value = {'Item': item}
    return table


def test_the_handlers_upload_extensions_are_the_cases(extractor):
    """The cases' list is the upload boundary's (shared/'s suite checks that side)."""
    assert list(extractor.UPLOAD_EXTENSIONS) == _SPEC['upload_extensions']


@pytest.mark.parametrize('case', _CASES, ids=_case_id)
def test_the_upload_key_parses_to_its_ids(extractor, case):
    workspace_match = extractor.WORKSPACE_RAW_KEY_PATTERN.fullmatch(case['raw_key'])
    if case['workspace'] is None:
        match = extractor.RAW_KEY_PATTERN.fullmatch(case['raw_key'])
        assert match is not None
        assert match.group('project_id', 'doc_id', 'ext') == (case['project_id'], case['doc_id'], case['ext'])
        assert workspace_match is None
    else:
        assert workspace_match is not None
        assert workspace_match.group('workspace_id', 'project_id', 'doc_id', 'ext') == (
            case['workspace'], case['project_id'], case['doc_id'], case['ext'])
        assert extractor.RAW_KEY_PATTERN.fullmatch(case['raw_key']) is None


@pytest.mark.parametrize('case', _CASES, ids=_case_id)
def test_the_output_and_the_row_are_shareds_keys(extractor, case):
    extracted = extractor._extracted_key(case['project_id'], case['doc_id'], case['workspace'])
    assert extracted == case['extracted_key']
    assert extracted.startswith(case['doc_prefix'])
    row = {'pk': extractor._project_pk(case['project_id'], case['workspace']),
           'sk': f"{extractor.DOC_SK_PREFIX}{case['doc_id']}"}
    assert row == case['doc_row']


@pytest.mark.parametrize('case', _WORKSPACE_CASES, ids=_case_id)
def test_the_claim_is_read_as_shared_reads_it(extractor, case):
    table = _answering({'workspace_id': case['workspace']})
    extractor._clients[f'table:{TEST_PROJECTS_TABLE}'] = table

    assert extractor._claimed_workspace(case['project_id']) == case['workspace']
    assert table.get_item.call_args_list == [call(**case['claim_read'])]


@pytest.mark.parametrize('case', _WORKSPACE_CASES, ids=_case_id)
def test_the_status_is_read_as_shared_reads_it(extractor, case):
    table = _answering({'pk': f"WS#{case['workspace']}", 'sk': 'META', 'status': 'active'})
    extractor._clients[f'table:{TEST_WORKSPACES_TABLE}'] = table

    extractor._require_active(case['workspace'])
    assert table.get_item.call_args_list == [call(**case['status_read'])]


def test_every_document_row_write_names_only_the_granted_attributes(extractor):
    """The stack holds the UpdateItem to doc_row_attributes (`dynamodb:Attributes`): the key, the condition's
    `attribute_exists(pk)` and status, and every value the handler writes, in each of its three writes."""
    table = MagicMock()
    extractor._clients[f'table:{TEST_PROJECTS_TABLE}'] = table

    extractor._mark_extracting('proj_1', 'abc123', workspace='ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
    extractor._mark_failed('proj_1', 'abc123', 'No text could be extracted from this file.')
    extractor._mark_ready('proj_1', 'abc123', 'projects/proj_1/product_docs/extracted/abc123.txt', 4)

    named = {name for request in table.update_item.call_args_list
             for name in [*request.kwargs['Key'], *request.kwargs['ExpressionAttributeNames'].values()]}
    assert sorted(named) == _SPEC['doc_row_attributes']
    assert all('attribute_exists(pk)' in r.kwargs['ConditionExpression'] for r in table.update_item.call_args_list)


@pytest.mark.parametrize('case', _CASES, ids=_case_id)
def test_a_document_record_is_read_for_the_granted_attributes_in_a_workspace(extractor, case):
    """A workspace's record is read projected to doc_read_attributes (all the stack lets it read there); the
    deployment's read is the unprojected one it always sent."""
    table = _answering({'status': 'pending'})
    extractor._clients[f'table:{TEST_PROJECTS_TABLE}'] = table

    extractor._get_doc(case['project_id'], case['doc_id'], workspace=case['workspace'])

    projection = table.get_item.call_args.kwargs.get('ExpressionAttributeNames')
    expected = None if case['workspace'] is None else _SPEC['doc_read_attributes']
    assert (None if projection is None else sorted(projection.values())) == expected
    assert table.get_item.call_args.kwargs['Key'] == case['doc_row']


def test_the_model_rows_are_the_cases(extractor):
    rows = [extractor.MODEL_SETTINGS_PK, extractor.MODEL_DEFAULT_PK]
    assert rows == _SPEC['model_rows']
    assert list(extractor.DOC_READ_ATTRIBUTES) == _SPEC['doc_read_attributes']
