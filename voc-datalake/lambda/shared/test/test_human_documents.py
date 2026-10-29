"""`shared/human_documents.py`: a PR/FAQ or PRD a person writes from a blank template
(docs/ways-of-working.md → Writing by hand). `persist_versioned_document` is the storage
boundary and is mocked, except in the moto cases that check a retried click files one
document."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

from shared import human_documents
from shared.exceptions import ValidationError
from shared.test.moto_tables import create_projects_table_with_meta

PERSISTED = {'document_id': 'doc_1', 'title': 'Faster checkout'}


@pytest.fixture
def persist() -> Iterator[MagicMock]:
    with patch.object(human_documents, 'persist_versioned_document', return_value=PERSISTED) as mock:
        yield mock


def _create(body: dict, doc_type: str = 'prd', creator_sub: str = 'sub-ada') -> dict:
    return human_documents.create_human_document('TABLE', 'p1', doc_type, body, creator_sub=creator_sub)


def _refusal(body: dict, doc_type: str = 'prd') -> str:
    with pytest.raises(ValidationError) as caught:
        _create(body, doc_type)
    return caught.value.message


def _fields(persist: MagicMock) -> dict:
    fields = persist.call_args.args[5]
    assert isinstance(fields, dict)
    return fields


class TestFilingTheDocument:
    @pytest.mark.parametrize('doc_type', ['prfaq', 'prd'])
    def test_it_is_filed_as_a_versioned_document_of_its_type(self, persist: MagicMock, doc_type: str):
        result = _create({'title': 'Faster checkout', 'create_id': 'click_1'}, doc_type)

        assert result == PERSISTED
        persist.assert_called_once()
        assert persist.call_args.args[:5] == ('TABLE', 'p1', doc_type, 'Faster checkout', 'human:click_1')

    def test_it_is_marked_as_written_by_a_person_with_the_creator(self, persist: MagicMock):
        _create({'title': 'T', 'content': 'My own words'})

        fields = _fields(persist)
        assert fields['origin'] == 'human'
        assert fields['created_by_sub'] == 'sub-ada'
        assert fields['content'] == 'My own words'
        assert fields['gsi1pk'] == 'PROJECT#p1#DOCUMENTS'
        assert fields['gsi1sk'] == fields['created_at'] == fields['updated_at']
        assert datetime.fromisoformat(fields['created_at']).tzinfo is not None

    def test_no_creator_leaves_no_creator_attribute(self, persist: MagicMock):
        _create({'title': 'T'}, creator_sub='')

        assert 'created_by_sub' not in _fields(persist)

    def test_the_title_is_trimmed(self, persist: MagicMock):
        _create({'title': '  Faster checkout  '})

        assert persist.call_args.args[3] == 'Faster checkout'

    def test_without_a_create_id_each_request_gets_its_own_allocation(self, persist: MagicMock):
        _create({'title': 'T'})
        _create({'title': 'T'})

        first, second = (c.args[4] for c in persist.call_args_list)
        assert first.startswith('human:')
        assert second.startswith('human:')
        assert first != second


class TestTheBlankTemplate:
    @pytest.mark.parametrize('doc_type', ['prfaq', 'prd'])
    @pytest.mark.parametrize('body', [{'title': 'T'}, {'title': 'T', 'content': ''}, {'title': 'T', 'content': None}])
    def test_empty_content_starts_from_the_types_template(self, persist: MagicMock, doc_type: str, body: dict):
        _create(body, doc_type)

        assert _fields(persist)['content'] == human_documents.TEMPLATES[doc_type]

    def test_the_prfaq_template_has_the_press_release_and_the_faq(self):
        template = human_documents.TEMPLATES['prfaq']

        assert template.startswith('# Press release\n')
        assert '# FAQ' in template
        assert '## Internal FAQ' in template

    def test_the_prd_template_has_requirements_and_success_metrics(self):
        template = human_documents.TEMPLATES['prd']

        assert template.startswith('# Overview\n')
        assert '# Requirements' in template
        assert '# Success metrics' in template

    def test_whitespace_content_is_the_persons_text_not_the_template(self, persist: MagicMock):
        _create({'title': 'T', 'content': '   '})

        assert _fields(persist)['content'] == '   '


class TestRefusals:
    @pytest.mark.parametrize('doc_type', ['custom', 'prototype', 'research', 'PRD', ''])
    def test_only_a_prfaq_or_a_prd_can_be_written_by_hand(self, persist: MagicMock, doc_type: str):
        assert _refusal({'title': 'T'}, doc_type) == 'document_type must be prfaq or prd'
        persist.assert_not_called()

    @pytest.mark.parametrize('body', [{}, {'title': ''}, {'title': '   '}, {'title': None}, {'title': 7}])
    def test_a_title_is_required(self, persist: MagicMock, body: dict):
        assert _refusal(body) == 'title is required'
        persist.assert_not_called()

    def test_a_title_of_two_hundred_characters_is_accepted(self, persist: MagicMock):
        _create({'title': 'x' * 200})

        assert persist.call_args.args[3] == 'x' * 200

    def test_a_longer_title_is_refused(self, persist: MagicMock):
        assert _refusal({'title': 'x' * 201}) == 'title must be at most 200 characters'
        persist.assert_not_called()

    def test_the_title_limit_counts_the_trimmed_text(self, persist: MagicMock):
        assert _refusal({'title': ' ' + 'x' * 201}) == 'title must be at most 200 characters'
        persist.assert_not_called()

    @pytest.mark.parametrize('content', [7, ['text'], {'body': 'text'}, True])
    def test_content_must_be_a_string(self, persist: MagicMock, content: object):
        assert _refusal({'title': 'T', 'content': content}) == 'content must be a string'
        persist.assert_not_called()

    def test_content_at_the_limit_is_accepted_and_one_more_character_is_refused(self, persist: MagicMock):
        _create({'title': 'T', 'content': 'x' * 200_000})
        assert len(_fields(persist)['content']) == 200_000

        assert _refusal({'title': 'T', 'content': 'x' * 200_001}) == 'content must be at most 200000 characters'
        persist.assert_called_once()

    @pytest.mark.parametrize('create_id', ['', 'a' * 65, 'has space', 'a/b', '../x', 7, True, 'é'])
    def test_a_malformed_create_id_is_refused(self, persist: MagicMock, create_id: object):
        assert _refusal({'title': 'T', 'create_id': create_id}) == (
            'create_id must be 1-64 letters, digits, "-" or "_"')
        persist.assert_not_called()

    @pytest.mark.parametrize('create_id', ['a', 'A-b_9', 'z' * 64])
    def test_a_well_formed_create_id_is_used_as_the_allocation(self, persist: MagicMock, create_id: str):
        _create({'title': 'T', 'create_id': create_id})

        assert persist.call_args.args[4] == f'human:{create_id}'


class TestStoredInDynamoDB:
    @pytest.fixture
    def table(self) -> Iterator[Any]:
        with mock_aws():
            yield create_projects_table_with_meta('test-projects', 'p1')

    def test_a_retried_click_files_one_document(self, table: Any):
        body = {'title': 'Faster checkout', 'create_id': 'click_1'}

        first = human_documents.create_human_document(table, 'p1', 'prd', body, creator_sub='sub-ada')
        second = human_documents.create_human_document(table, 'p1', 'prd', body, creator_sub='sub-ada')

        assert first['document_id'] == second['document_id']
        assert first['origin'] == 'human'
        assert first['created_by_sub'] == 'sub-ada'
        assert first['content'] == human_documents.TEMPLATES['prd']

    def test_a_second_click_files_the_next_version_of_the_series(self, table: Any):
        first = human_documents.create_human_document(
            table, 'p1', 'prfaq', {'title': 'Checkout', 'create_id': 'c1'}, creator_sub='sub-ada')
        second = human_documents.create_human_document(
            table, 'p1', 'prfaq', {'title': 'Checkout', 'create_id': 'c2'}, creator_sub='sub-ada')

        assert first['document_id'] != second['document_id']
        assert (first.get('version'), second.get('version')) == (1, 2)
