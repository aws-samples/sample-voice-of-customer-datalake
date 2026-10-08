"""Mutation hardening for `api/projects.py` lines 2672-3893 (document
duplication, manual persona CRUD and research notes, the synchronous research
fallback, and project sharing: visibility, members, candidate search and
ownership transfer). The Kiro autoseed export went with GET
/projects/{id}/autoseed in 3.00.00.

`test_projects_agent_features.py`, `test_project_permissions.py`,
`test_kiro_default_prompt.py`,
`test_run_research_date_basis.py` and `test_persona_note_update_moto.py` pin
that a copy is idempotent and that every sharing route is gated, but a mutation run found what they cannot see:

* the WORDING of every refusal (`ValidationError`, `ConflictError`,
  `NotFoundError`, `ServiceError`) — the 4xx/5xx body a user reads — and of
  every `logger.exception` / `logger.info` / `logger.warning` line an operator
  follows in CloudWatch, pinned here as literals.
* the exact DynamoDB arguments the stubs accept whatever their shape: the
  `UpdateExpression` built field by field for a persona edit (and that
  `ExpressionAttributeNames` is OMITTED when no alias is needed), the
  `ConditionExpression` of every guarded META write, the `ReturnValues`, the
  `ConsistentRead=True` of the META and source-document reads, the
  `TransactItems` of a persona delete, and the S3 `copy_object` arguments.
* that one UTC reading stamps `created_at`, `updated_at`, `gsi1sk` AND the id of
  a new persona, and that `_now_iso` asks for UTC.
* the ACCEPTED side of each bound: a 50-character question titles a research
  document intact and the 51st character is cut; a 350 000-character report is
  saved whole and one more character truncates it; 3 quotes are all rendered
  and the 4th dropped; an 80-character slug survives and the 81st is cut; a
  64-character query and a 128-character sub pass, 65 and 129 do not; the 20th
  candidate is listed and the 21st is not; 99 members accept a 100th and 100
  refuse a 101st.
* the exact markdown every persona/document/steering renderer emits, line by
  line, including each default (`Unknown`, `Untitled`, `custom`, `Project`).
* the exact compare-and-swap an ownership transfer builds for each of the four
  (legacy owner?, admin caller?) cases, and that the previous owner's new
  member entry is stamped `editor`, by the caller, at the same instant.
"""
import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError
from projects_mutation_fixtures import PERSONA_SECTIONS

import projects
from shared import project_access, project_writes
from shared.exceptions import (
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.project_access import Caller
from shared.project_writes import (
    PROJECT_WRITABLE_ATTRIBUTE_NAMES,
    PROJECT_WRITABLE_ATTRIBUTE_VALUES,
    PROJECT_WRITABLE_CONDITION,
)

FIXED = datetime(2026, 3, 4, 5, 6, 7, tzinfo=UTC)
NOW = '2026-03-04T05:06:07+00:00'
STAMP = '20260304050607'
#: A minted id's tail under the `fixed_id_suffix` fixture: `<stamp>_<8 hex>` (shared/ids.py).
ID = f'{STAMP}_a1b2c3d4'
pytestmark = pytest.mark.usefixtures('fixed_id_suffix')
TABLE_NOT_CONFIGURED = 'Projects table not configured'
PERSONA_KEY = {'pk': 'PROJECT#p1', 'sk': 'PERSONA#per_1'}
EXISTS = 'attribute_exists(pk) AND attribute_exists(sk)'
META_KEY = {'pk': 'PROJECT#p1', 'sk': 'META'}
OWNER = Caller(subject='owner-sub', username='olivia', email='olivia@example.com')
ADMIN = Caller(subject='admin-sub', is_admin=True)
CAP = project_access.MAX_PROJECT_MEMBERS


@pytest.fixture(autouse=True)
def clock() -> Iterator[MagicMock]:
    """Every test runs at FIXED: timestamps and ids become literals to compare against."""
    with patch.object(projects, 'datetime') as fake:
        fake.now.return_value = FIXED
        yield fake


@pytest.fixture
def log() -> Iterator[MagicMock]:
    with patch.object(projects, 'logger') as logger:
        yield logger


@pytest.fixture
def table() -> Iterator[MagicMock]:
    stub = MagicMock()
    stub.name = 'projects-table'
    with patch.object(projects, 'projects_table', stub):
        yield stub


@pytest.fixture
def no_table() -> Iterator[None]:
    with patch.object(projects, 'projects_table', None):
        yield


def _client_error(code: str, operation: str = 'UpdateItem') -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': code}}, operation)


def _only_kwargs(mock: MagicMock) -> dict:
    """The kwargs of the one call ``mock`` received (and that it took no positionals)."""
    assert mock.call_count == 1
    assert mock.call_args.args == ()
    return dict(mock.call_args.kwargs)


# ===========================================================================
# Document duplication
# ===========================================================================


ENTRY_POINTS = [
    'duplicate_document', 'create_persona', 'update_persona', 'add_persona_note',
    'update_persona_note', 'delete_persona_note', 'regenerate_persona_avatar', 'delete_persona',
    'run_research', 'read_project_meta', 'set_project_visibility',
    'search_member_candidates', 'get_project_members', 'add_project_member',
    'update_project_member', 'remove_project_member', 'transfer_project_owner',
]


@pytest.mark.parametrize('name', ENTRY_POINTS)
def test_every_entry_point_is_the_tracer_wrapper_around_the_named_function(name):
    # functools.wraps stores __wrapped__ in the function's __dict__; a dropped
    # decorator is a missing key, not a renamed function.
    assert vars(getattr(projects, name))['__wrapped__'].__qualname__ == name


class TestCopyPrototypeHtml:
    @pytest.mark.parametrize('bucket', ['', None])
    def test_without_a_bucket_the_refusal_names_the_storage(self, monkeypatch, bucket):
        if bucket is None:
            monkeypatch.delenv('RAW_DATA_BUCKET', raising=False)
        else:
            monkeypatch.setenv('RAW_DATA_BUCKET', bucket)
        with pytest.raises(ConfigurationError) as exc:
            projects._copy_prototype_html('src', 'd1', 'dst', 'd2')
        assert str(exc.value) == 'Prototype storage not configured'

    def test_the_copy_targets_the_new_key_and_replaces_the_metadata(self, monkeypatch):
        monkeypatch.setenv('RAW_DATA_BUCKET', 'the-bucket')
        s3 = MagicMock()
        s3.copy_object.return_value = {
            'CopyObjectResult': {'ETag': '"etag-1"'}, 'VersionId': 'v-7',
        }
        with patch.object(projects, 'get_s3_client', return_value=s3):
            identity = projects._copy_prototype_html('src', 'd1', 'dst', 'd2')
        s3.copy_object.assert_called_once_with(
            Bucket='the-bucket',
            Key='prototypes/dst/d2.html',
            CopySource={'Bucket': 'the-bucket', 'Key': 'prototypes/src/d1.html'},
            ContentType='text/html; charset=utf-8',
            MetadataDirective='REPLACE',
        )
        assert identity == {'prototype_etag': '"etag-1"', 'prototype_version_id': 'v-7'}

    @pytest.mark.parametrize(('response', 'expected'), [
        ({}, {}),
        ({'CopyObjectResult': {}}, {}),
        ({'CopyObjectResult': {'ETag': 'e'}}, {'prototype_etag': 'e'}),
        ({'VersionId': 'v'}, {'prototype_version_id': 'v'}),
        ({'CopyObjectResult': {'ETag': ''}, 'VersionId': ''}, {}),
    ])
    def test_only_the_identity_fields_s3_returned_are_recorded(self, monkeypatch, response, expected):
        monkeypatch.setenv('RAW_DATA_BUCKET', 'the-bucket')
        s3 = MagicMock()
        s3.copy_object.return_value = response
        with patch.object(projects, 'get_s3_client', return_value=s3):
            assert projects._copy_prototype_html('src', 'd1', 'dst', 'd2') == expected

    def test_a_failed_copy_is_logged_and_asks_for_a_retry(self, monkeypatch, log):
        monkeypatch.setenv('RAW_DATA_BUCKET', 'the-bucket')
        s3 = MagicMock()
        error = _client_error('NoSuchKey', 'CopyObject')
        s3.copy_object.side_effect = error
        with patch.object(projects, 'get_s3_client', return_value=s3), \
                pytest.raises(ServiceError) as exc:
            projects._copy_prototype_html('src', 'd1', 'dst', 'd2')
        assert str(exc.value) == 'Could not copy the prototype. Please retry.'
        assert exc.value.__cause__ is error
        log.exception.assert_called_once_with('Prototype copy failed')


class TestDuplicateSummary:
    def test_it_carries_exactly_the_four_identity_fields(self):
        item = {'document_id': 'd9', 'document_type': 'prd', 'title': 'T', 'content': 'hidden',
                'pk': 'PROJECT#x'}
        assert projects._duplicate_summary(item, 'dst') == {
            'project_id': 'dst', 'document_id': 'd9', 'document_type': 'prd', 'title': 'T',
        }

    def test_missing_fields_read_as_none(self):
        assert projects._duplicate_summary({}, 'dst') == {
            'project_id': 'dst', 'document_id': None, 'document_type': None, 'title': None,
        }


def _source(sk: str, **extra) -> dict:
    return {
        'pk': 'PROJECT#src', 'sk': sk, 'gsi1pk': 'PROJECT#src#DOCUMENTS', 'gsi1sk': '2025',
        'document_id': 'd1', 'title': 'Source title', 'base_title': 'Source base', 'version': 3,
        'version_allocation_id': 'alloc', 'prototype_etag': 'e', 'prototype_version_id': 'v',
        'prototype_url': 'u', 'created_at': '2025', 'updated_at': '2025', 'job_id': 'j',
        'document_type': 'custom', 'content': 'body', **extra,
    }


CUSTOM_DIGEST = hashlib.sha256(b'duplicate:src:d1|dst').hexdigest()[:20]


class TestDuplicateDocument:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.duplicate_document('src', 'd1', 'dst')
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_the_same_project_is_refused_before_any_read(self, table):
        with pytest.raises(ValidationError) as exc:
            projects.duplicate_document('src', 'd1', 'src')
        assert str(exc.value) == 'target_project_id must name a different project'
        table.get_item.assert_not_called()

    def test_the_source_is_read_consistently_under_its_stored_sort_key(self, table):
        table.get_item.return_value = {'Item': _source('DOC#d1')}
        with patch.object(projects, '_find_document', return_value={'sk': 'DOC#d1'}) as find, \
                patch.object(projects, 'put_project_item_and_increment'):
            projects.duplicate_document('src', 'd1', 'dst')
        find.assert_called_once_with('src', 'd1')
        table.get_item.assert_called_once_with(
            Key={'pk': 'PROJECT#src', 'sk': 'DOC#d1'}, ConsistentRead=True,
        )

    @pytest.mark.parametrize('item', [None, 'not a dict', {'document_id': 'other'}])
    def test_a_source_that_is_not_the_document_is_not_found(self, table, item):
        table.get_item.return_value = {'Item': item}
        with patch.object(projects, '_find_document', return_value={'sk': 'DOC#d1'}), \
                pytest.raises(NotFoundError) as exc:
            projects.duplicate_document('src', 'd1', 'dst')
        assert str(exc.value) == 'Document not found'

    def test_a_custom_copy_drops_identity_fields_and_derives_its_id(self, table):
        table.get_item.return_value = {'Item': _source('DOC#d1')}
        with patch.object(projects, '_find_document', return_value={'sk': 'DOC#d1'}), \
                patch.object(projects, 'put_project_item_and_increment') as put:
            result = projects.duplicate_document('src', 'd1', 'dst')
        expected_item = {
            'document_type': 'custom',
            'content': 'body',
            'gsi1pk': 'PROJECT#dst#DOCUMENTS',
            'gsi1sk': NOW,
            'created_at': NOW,
            'updated_at': NOW,
            'duplicated_from': {'project_id': 'src', 'document_id': 'd1'},
            'pk': 'PROJECT#dst',
            'sk': f'DOC#dup_{CUSTOM_DIGEST}',
            'document_id': f'dup_{CUSTOM_DIGEST}',
            'title': 'Source title',
        }
        put.assert_called_once_with(table, 'dst', expected_item, 'document_count')
        assert result == {'success': True, 'document': {
            'project_id': 'dst', 'document_id': f'dup_{CUSTOM_DIGEST}',
            'document_type': 'custom', 'title': 'Source title',
        }}

    def test_the_copy_keeps_the_source_prefix_and_defaults_an_empty_title(self, table):
        table.get_item.return_value = {'Item': _source('RESEARCH#d1', title='')}
        with patch.object(projects, '_find_document', return_value={'sk': 'RESEARCH#d1'}), \
                patch.object(projects, 'put_project_item_and_increment') as put:
            projects.duplicate_document('src', 'd1', 'dst')
        item = put.call_args.args[2]
        assert (item['sk'], item['title']) == (f'RESEARCH#dup_{CUSTOM_DIGEST}', 'Untitled')

    def test_a_cancelled_transaction_returns_the_existing_copy(self, table):
        existing = {'document_id': 'dup_x', 'document_type': 'custom', 'title': 'Kept'}
        table.get_item.side_effect = [{'Item': _source('DOC#d1')}, {'Item': existing}]
        with patch.object(projects, '_find_document', return_value={'sk': 'DOC#d1'}), \
                patch.object(projects, 'put_project_item_and_increment',
                             side_effect=_client_error('TransactionCanceledException')):
            result = projects.duplicate_document('src', 'd1', 'dst')
        assert table.get_item.call_args_list[1] == call(
            Key={'pk': 'PROJECT#dst', 'sk': f'DOC#dup_{CUSTOM_DIGEST}'}, ConsistentRead=True,
        )
        assert result == {'success': True, 'document': {
            'project_id': 'dst', 'document_id': 'dup_x', 'document_type': 'custom', 'title': 'Kept',
        }}

    def test_a_cancelled_transaction_without_a_copy_names_the_target(self, table):
        table.get_item.side_effect = [{'Item': _source('DOC#d1')}, {}]
        error = _client_error('TransactionCanceledException')
        with patch.object(projects, '_find_document', return_value={'sk': 'DOC#d1'}), \
                patch.object(projects, 'put_project_item_and_increment', side_effect=error), \
                pytest.raises(ServiceError) as exc:
            projects.duplicate_document('src', 'd1', 'dst')
        assert str(exc.value) == 'The target project is not accepting documents'
        assert exc.value.__cause__ is error

    def test_any_other_client_error_propagates_without_a_re_read(self, table):
        table.get_item.return_value = {'Item': _source('DOC#d1')}
        error = _client_error('ProvisionedThroughputExceededException')
        with patch.object(projects, '_find_document', return_value={'sk': 'DOC#d1'}), \
                patch.object(projects, 'put_project_item_and_increment', side_effect=error), \
                pytest.raises(ClientError) as exc:
            projects.duplicate_document('src', 'd1', 'dst')
        assert exc.value is error
        assert table.get_item.call_count == 1

    @pytest.mark.parametrize(('sk', 'doc_type'), [
        ('PRD#d1', 'prd'), ('PRFAQ#d1', 'prfaq'),
    ])
    def test_a_managed_copy_joins_the_target_version_series(self, table, sk, doc_type):
        table.get_item.return_value = {'Item': _source(sk, base_title='Base (v3)', title='Base (v3)')}
        persisted = {'document_id': 'new', 'document_type': doc_type, 'title': 'Base (v1)'}
        with patch.object(projects, '_find_document', return_value={'sk': sk}), \
                patch.object(projects, 'persist_versioned_document', return_value=persisted) as persist, \
                patch.object(projects, 'put_project_item_and_increment') as put:
            result = projects.duplicate_document('src', 'd1', 'dst')
        put.assert_not_called()
        persist.assert_called_once_with(table, 'dst', doc_type, 'Base', 'duplicate:src:d1', {
            'document_type': 'custom', 'content': 'body',
            'gsi1pk': 'PROJECT#dst#DOCUMENTS', 'gsi1sk': NOW, 'created_at': NOW, 'updated_at': NOW,
            'duplicated_from': {'project_id': 'src', 'document_id': 'd1'},
        })
        assert result == {'success': True, 'document': {
            'project_id': 'dst', 'document_id': 'new', 'document_type': doc_type, 'title': 'Base (v1)',
        }}

    @pytest.mark.parametrize(('fields', 'title'), [
        ({'base_title': 'B', 'title': 'T'}, 'B'),
        ({'base_title': '', 'title': 'T'}, 'T'),
        ({'base_title': None, 'title': ''}, 'Untitled'),
    ])
    def test_the_series_title_prefers_base_title_then_title(self, table, fields, title):
        table.get_item.return_value = {'Item': _source('PRD#d1', **fields)}
        with patch.object(projects, '_find_document', return_value={'sk': 'PRD#d1'}), \
                patch.object(projects, 'persist_versioned_document', return_value={}) as persist:
            projects.duplicate_document('src', 'd1', 'dst')
        assert persist.call_args.args[3] == title

    def test_a_prototype_copy_is_returned_when_the_allocation_already_exists(self, table):
        table.get_item.return_value = {'Item': _source('PROTOTYPE#d1')}
        existing = {'document_id': 'proto_old', 'document_type': 'prototype', 'title': 'P v1'}
        with patch.object(projects, '_find_document', return_value={'sk': 'PROTOTYPE#d1'}), \
                patch.object(projects, 'get_versioned_document_by_allocation',
                             return_value=existing) as lookup, \
                patch.object(projects, '_copy_prototype_html') as copy_html, \
                patch.object(projects, 'persist_versioned_document') as persist:
            result = projects.duplicate_document('src', 'd1', 'dst')
        lookup.assert_called_once_with(table, 'dst', 'prototype', 'duplicate:src:d1')
        copy_html.assert_not_called()
        persist.assert_not_called()
        assert result == {'success': True, 'document': {
            'project_id': 'dst', 'document_id': 'proto_old', 'document_type': 'prototype',
            'title': 'P v1',
        }}

    def test_a_new_prototype_copy_copies_the_html_to_the_target_key(self, table):
        table.get_item.return_value = {'Item': _source('PROTOTYPE#d1', base_title='Proto')}
        with patch.object(projects, '_find_document', return_value={'sk': 'PROTOTYPE#d1'}), \
                patch.object(projects, 'get_versioned_document_by_allocation', return_value=None), \
                patch.object(projects, 'versioned_document_id', return_value='proto_new') as new_id, \
                patch.object(projects, '_copy_prototype_html',
                             return_value={'prototype_etag': 'E'}) as copy_html, \
                patch.object(projects, 'persist_versioned_document', return_value={}) as persist:
            projects.duplicate_document('src', 'd1', 'dst')
        new_id.assert_called_once_with('dst', 'prototype', 'duplicate:src:d1')
        copy_html.assert_called_once_with('src', 'd1', 'dst', 'proto_new')
        fields = persist.call_args.args[5]
        assert fields['prototype_etag'] == 'E'
        assert persist.call_args.args[:5] == (table, 'dst', 'prototype', 'Proto', 'duplicate:src:d1')


# ===========================================================================
# Personas: manual create / update / delete, notes, avatar
# ===========================================================================


class TestCreatePersona:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.create_persona('p1', {})
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_one_utc_reading_stamps_the_id_and_every_timestamp(self, table, clock):
        with patch.object(project_writes, 'put_project_item_and_increment') as put:
            result = projects.create_persona('p1', {})
        clock.now.assert_called_once_with(UTC)
        item = {
            'pk': 'PROJECT#p1',
            'sk': f'PERSONA#persona_{ID}',
            'gsi1pk': 'PROJECT#p1#PERSONAS',
            'gsi1sk': NOW,
            'persona_id': f'persona_{ID}',
            'name': 'New Persona',
            'tagline': '',
            'identity': {},
            'goals_motivations': {},
            'pain_points': {},
            'behaviors': {},
            'context_environment': {},
            'quotes': [],
            'scenario': {},
            'research_notes': [],
            'created_at': NOW,
            'updated_at': NOW,
        }
        put.assert_called_once_with(table, 'p1', item, 'persona_count')
        assert result == {'success': True, 'persona': item}

    @pytest.mark.usefixtures('table')
    def test_every_section_of_the_body_is_stored_as_given(self):
        body = {
            'name': 'Ada', 'tagline': 'Builds', 'identity': {'age_range': '30-40'},
            'goals_motivations': {'primary_goal': 'ship'}, 'pain_points': {'emotional_impact': 'x'},
            'behaviors': {'tools_used': ['vim']}, 'context_environment': {'where': 'home'},
            'quotes': ['q'], 'scenario': {'title': 't'}, 'research_notes': [{'note_id': 'n'}],
        }
        with patch.object(project_writes, 'put_project_item_and_increment') as put:
            projects.create_persona('p1', body)
        item = put.call_args.args[2]
        assert {key: item[key] for key in body} == body


FULL_PERSONA_UPDATE = {
    'name': 'AdaLovelace', 'tagline': 't', 'confidence': 0.5, 'identity': {'a': 1}, **PERSONA_SECTIONS,
    'research_notes': [], 'avatar_url': 'u', 'avatar_prompt': 'pr',
}


class TestUpdatePersona:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.update_persona('p1', 'per_1', {})
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_every_field_is_aliased_in_declaration_order(self, table):
        result = projects.update_persona('p1', 'per_1', dict(FULL_PERSONA_UPDATE))
        fields = list(FULL_PERSONA_UPDATE)
        assert _only_kwargs(table.update_item) == {
            'Key': PERSONA_KEY,
            'UpdateExpression': 'SET updated_at = :now, ' + ', '.join(
                f'#{field} = :{field}' for field in fields),
            'ConditionExpression': EXISTS,
            'ExpressionAttributeValues': {
                ':now': NOW, **{f':{field}': value for field, value in FULL_PERSONA_UPDATE.items()},
                ':name': 'Ada Lovelace',
            },
            'ExpressionAttributeNames': {f'#{field}': field for field in fields},
        }
        assert result == {'success': True}

    def test_with_no_known_field_only_the_timestamp_moves_and_no_names_are_sent(self, table):
        projects.update_persona('p1', 'per_1', {'persona_id': 'forged', 'pk': 'x'})
        assert _only_kwargs(table.update_item) == {
            'Key': PERSONA_KEY,
            'UpdateExpression': 'SET updated_at = :now',
            'ConditionExpression': EXISTS,
            'ExpressionAttributeValues': {':now': NOW},
        }

    @pytest.mark.parametrize(('name', 'stored'), [
        ('AdaLovelace', 'Ada Lovelace'), ('Ada', 'Ada'), ('', ''),
    ])
    def test_a_camel_cased_name_is_spaced_and_an_empty_one_left_alone(self, table, name, stored):
        projects.update_persona('p1', 'per_1', {'name': name})
        assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':name'] == stored

    def test_a_failed_write_is_logged_with_its_cause_and_reported(self, table, log):
        error = RuntimeError('boom')
        table.update_item.side_effect = error
        with pytest.raises(ServiceError) as exc:
            projects.update_persona('p1', 'per_1', {'tagline': 't'})
        assert str(exc.value) == 'Failed to update persona'
        assert exc.value.__cause__ is error
        log.exception.assert_called_once_with('Failed to update persona: boom')


class TestAddPersonaNote:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.add_persona_note('p1', 'per_1', {'text': 'x'})
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    @pytest.mark.parametrize('body', [{}, {'text': ''}])
    def test_an_empty_note_is_refused_before_any_write(self, table, body):
        with pytest.raises(ValidationError) as exc:
            projects.add_persona_note('p1', 'per_1', body)
        assert str(exc.value) == 'Note text is required'
        table.update_item.assert_not_called()

    def test_the_note_is_appended_with_its_defaults(self, table):
        result = projects.add_persona_note('p1', 'per_1', {'text': 'Spoke to 3 users'})
        note = {
            'note_id': f'note_{ID}', 'text': 'Spoke to 3 users', 'author': 'anonymous',
            'created_at': NOW, 'updated_at': None, 'tags': [],
        }
        assert _only_kwargs(table.update_item) == {
            'Key': PERSONA_KEY,
            'UpdateExpression': (
                'SET research_notes = list_append(if_not_exists(research_notes, :empty), :note), '
                'updated_at = :now'
            ),
            'ConditionExpression': EXISTS,
            'ExpressionAttributeValues': {':note': [note], ':empty': [], ':now': NOW},
        }
        assert result == {'success': True, 'note': note}

    @pytest.mark.usefixtures('table')
    def test_author_and_tags_are_taken_from_the_body(self):
        note = projects.add_persona_note(
            'p1', 'per_1', {'text': 'x', 'author': 'ada', 'tags': ['ux']},
        )['note']
        assert (note['author'], note['tags']) == ('ada', ['ux'])

    def test_a_failed_write_is_logged_with_its_cause_and_reported(self, table, log):
        error = RuntimeError('boom')
        table.update_item.side_effect = error
        with pytest.raises(ServiceError) as exc:
            projects.add_persona_note('p1', 'per_1', {'text': 'x'})
        assert str(exc.value) == 'Failed to add note'
        assert exc.value.__cause__ is error
        log.exception.assert_called_once_with('Failed to add persona note: boom')


def _persona_with_notes(table: MagicMock) -> None:
    table.get_item.return_value = {'Item': {
        **PERSONA_KEY, 'research_notes': [{'note_id': 'n0'}, {'note_id': 'n1'}, {'note_id': 'n2'}],
    }}


class TestUpdatePersonaNote:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.update_persona_note('p1', 'per_1', 'n1', {})
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_text_and_tags_address_the_note_by_position(self, table):
        _persona_with_notes(table)
        result = projects.update_persona_note('p1', 'per_1', 'n1', {'text': 'new', 'tags': ['a']})
        assert _only_kwargs(table.update_item) == {
            'Key': PERSONA_KEY,
            'UpdateExpression': (
                'SET research_notes[1].updated_at = :now, research_notes[1].#text = :text, '
                'research_notes[1].tags = :tags, updated_at = :persona_updated'
            ),
            'ExpressionAttributeValues': {
                ':now': NOW, ':text': 'new', ':tags': ['a'], ':persona_updated': NOW,
            },
            'ExpressionAttributeNames': {'#text': 'text'},
        }
        assert result == {'success': True}

    def test_a_tags_only_edit_sends_no_names(self, table):
        _persona_with_notes(table)
        projects.update_persona_note('p1', 'per_1', 'n2', {'tags': []})
        assert _only_kwargs(table.update_item) == {
            'Key': PERSONA_KEY,
            'UpdateExpression': (
                'SET research_notes[2].updated_at = :now, research_notes[2].tags = :tags, '
                'updated_at = :persona_updated'
            ),
            'ExpressionAttributeValues': {':now': NOW, ':tags': [], ':persona_updated': NOW},
        }

    def test_an_empty_edit_still_touches_both_timestamps(self, table):
        _persona_with_notes(table)
        projects.update_persona_note('p1', 'per_1', 'n0', {})
        assert table.update_item.call_args.kwargs['UpdateExpression'] == (
            'SET research_notes[0].updated_at = :now, updated_at = :persona_updated'
        )

    def test_a_failed_write_is_logged_with_its_cause_and_reported(self, table, log):
        _persona_with_notes(table)
        error = RuntimeError('boom')
        table.update_item.side_effect = error
        with pytest.raises(ServiceError) as exc:
            projects.update_persona_note('p1', 'per_1', 'n1', {'text': 'x'})
        assert str(exc.value) == 'Failed to update note'
        assert exc.value.__cause__ is error
        log.exception.assert_called_once_with('Failed to update persona note: boom')


class TestDeletePersonaNote:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.delete_persona_note('p1', 'per_1', 'n1')
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_the_note_is_removed_by_position_and_the_persona_timestamp_moves(self, table):
        _persona_with_notes(table)
        result = projects.delete_persona_note('p1', 'per_1', 'n2')
        assert _only_kwargs(table.update_item) == {
            'Key': PERSONA_KEY,
            'UpdateExpression': 'REMOVE research_notes[2] SET updated_at = :now',
            'ExpressionAttributeValues': {':now': NOW},
        }
        assert result == {'success': True}

    def test_a_failed_write_is_logged_with_its_cause_and_reported(self, table, log):
        _persona_with_notes(table)
        error = RuntimeError('boom')
        table.update_item.side_effect = error
        with pytest.raises(ServiceError) as exc:
            projects.delete_persona_note('p1', 'per_1', 'n0')
        assert str(exc.value) == 'Failed to delete note'
        assert exc.value.__cause__ is error
        log.exception.assert_called_once_with('Failed to delete persona note: boom')


class TestRegeneratePersonaAvatar:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.regenerate_persona_avatar('p1', 'per_1')
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_the_stored_persona_is_handed_to_the_generator_with_its_project(self, table):
        persona = {**PERSONA_KEY, 'name': 'Ada'}
        table.get_item.return_value = {'Item': persona}
        generated = {'avatar_url': 's3://b/avatars/per_1/abc.png', 'avatar_prompt': 'portrait'}
        with patch.object(projects, 'generate_persona_avatar', return_value=generated) as generate, \
                patch.object(projects, 'get_avatar_cdn_url', return_value='https://cdn/signed') as sign, \
                patch.object(projects, '_sweep_superseded_avatar') as sweep:
            result = projects.regenerate_persona_avatar('p1', 'per_1')
        generate.assert_called_once_with(persona, project_id='p1')
        assert _only_kwargs(table.update_item) == {
            'Key': PERSONA_KEY,
            'UpdateExpression': 'SET avatar_url = :url, avatar_prompt = :prompt, updated_at = :now',
            'ConditionExpression': EXISTS,
            'ExpressionAttributeValues': {
                ':url': 's3://b/avatars/per_1/abc.png', ':prompt': 'portrait', ':now': NOW,
            },
        }
        sweep.assert_called_once_with('p1', 'per_1', None, 's3://b/avatars/per_1/abc.png')
        sign.assert_called_once_with('s3://b/avatars/per_1/abc.png')
        assert result == {
            'success': True, 'avatar_url': 'https://cdn/signed', 'avatar_prompt': 'portrait',
        }

    @pytest.mark.parametrize('generated', [{}, {'avatar_url': ''}, {'avatar_url': None}])
    def test_a_generation_without_a_url_is_reported_and_writes_nothing(self, table, generated):
        table.get_item.return_value = {'Item': dict(PERSONA_KEY)}
        with patch.object(projects, 'generate_persona_avatar', return_value=generated), \
                pytest.raises(ServiceError) as exc:
            projects.regenerate_persona_avatar('p1', 'per_1')
        assert str(exc.value) == 'Avatar generation failed'
        table.update_item.assert_not_called()


class TestDeletePersona:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.delete_persona('p1', 'per_1')
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_the_transaction_deletes_the_row_and_decrements_a_live_project(self, table):
        result = projects.delete_persona('p1', 'per_1')
        table.meta.client.transact_write_items.assert_called_once_with(TransactItems=[
            {
                'Delete': {
                    'TableName': 'projects-table',
                    'Key': PERSONA_KEY,
                    'ConditionExpression': EXISTS,
                },
            },
            {
                'Update': {
                    'TableName': 'projects-table',
                    'Key': META_KEY,
                    'UpdateExpression': 'SET persona_count = persona_count - :one, updated_at = :now',
                    'ConditionExpression': f'{PROJECT_WRITABLE_CONDITION} AND persona_count >= :one',
                    'ExpressionAttributeNames': PROJECT_WRITABLE_ATTRIBUTE_NAMES,
                    'ExpressionAttributeValues': {
                        **PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':one': 1, ':now': NOW,
                    },
                },
            },
        ])
        assert result == {'success': True}

    def test_a_failed_transaction_is_logged_with_its_cause_and_reported(self, table, log):
        error = RuntimeError('boom')
        table.meta.client.transact_write_items.side_effect = error
        with pytest.raises(ServiceError) as exc:
            projects.delete_persona('p1', 'per_1')
        assert str(exc.value) == 'Failed to delete persona'
        assert exc.value.__cause__ is error
        log.exception.assert_called_once_with('Failed to delete persona: boom')


# ===========================================================================
# run_research (synchronous fallback)
# ===========================================================================

FEEDBACK = [{'feedback_id': 'f1'}, {'feedback_id': 'f2'}]
TRUNCATION_SUFFIX = '\n\n---\n\n*[Report truncated due to size limits]*'
MAX_REPORT = 350000


@pytest.fixture
def research_env(table) -> Iterator[dict[str, MagicMock]]:
    """Every collaborator of run_research stubbed; yields them by name."""
    with patch.object(projects, 'get_project',
                      return_value={'project': {'filters': {'sources': ['app'], 'days': 7}}}) as project, \
            patch.object(projects, 'get_scoped_feedback_context', return_value=list(FEEDBACK)) as query, \
            patch.object(projects, 'format_feedback_for_llm', return_value='CTX') as fmt, \
            patch.object(projects, 'get_feedback_statistics', return_value='STATS') as stats, \
            patch.object(projects, 'get_research_analysis_steps', return_value=['step']) as steps, \
            patch.object(projects, 'converse_chain',
                         return_value=['DETAIL', 'SUMMARY', 'VALIDATION']) as chain, \
            patch.object(project_writes, 'put_project_item_and_increment') as put:
        yield {'project': project, 'query': query, 'fmt': fmt, 'stats': stats, 'steps': steps,
               'chain': chain, 'put': put, 'table': table}


def _report(question: str, filters_line: str, results=('DETAIL', 'SUMMARY', 'VALIDATION')) -> str:
    return (
        f'# Research Report: {question}\n\n'
        f'**Generated:** 2026-03-04\n'
        f'**Feedback Analyzed:** 2 items\n'
        f'**Filters:** {filters_line}\n\n---\n\n'
        f'## Executive Summary & Key Findings\n\n{results[1]}\n\n---\n\n'
        f'## Detailed Analysis\n\n{results[0]}\n\n---\n\n'
        f'## Validation & Confidence Assessment\n\n{results[2]}\n'
    )


class TestRunResearch:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.run_research('p1', {}, category_scope=None)
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_body_filters_win_over_the_project_filters_when_any_is_set(self, research_env, log):
        projects.run_research('p1', {'categories': ['billing']}, category_scope={'all': False})
        filters = {'sources': [], 'categories': ['billing'], 'sentiments': [], 'days': 30,
                   'date_basis': 'imported'}
        research_env['query'].assert_called_once_with(filters, 100, {'all': False})
        assert log.info.call_args_list[:2] == [
            call(f'Fetching feedback with filters: {filters}'),
            call('Found 2 feedback items for research'),
        ]

    def test_without_body_filters_the_project_filters_are_used(self, research_env):
        projects.run_research('p1', {'days': 90}, category_scope=None)
        research_env['query'].assert_called_once_with(
            {'sources': ['app'], 'days': 7, 'date_basis': 'imported'}, 100, None,
        )

    def test_a_project_without_filters_keeps_the_body_defaults(self, research_env):
        research_env['project'].return_value = {'project': {}}
        projects.run_research('p1', {}, category_scope=None)
        research_env['query'].assert_called_once_with(
            {'sources': [], 'categories': [], 'sentiments': [], 'days': 30, 'date_basis': 'imported'},
            100, None,
        )

    def test_no_feedback_is_a_named_refusal_before_any_model_call(self, research_env):
        research_env['query'].return_value = []
        with pytest.raises(ValidationError) as exc:
            projects.run_research('p1', {}, category_scope=None)
        assert str(exc.value) == (
            'No feedback data found matching the filters. Try adjusting your filter criteria.'
        )
        research_env['chain'].assert_not_called()

    def test_the_chain_is_built_from_the_formatted_corpus_and_run_on_the_documents_surface(
        self, research_env,
    ):
        projects.run_research('p1', {'question': 'Why churn?', 'response_language': 'fr'},
                              category_scope=None)
        research_env['fmt'].assert_called_once_with(FEEDBACK)
        research_env['stats'].assert_called_once_with(FEEDBACK)
        research_env['steps'].assert_called_once_with(
            research_question='Why churn?', feedback_stats='STATS', feedback_context='CTX',
            feedback_count=2, response_language='fr',
        )
        research_env['chain'].assert_called_once_with(['step'], surface='documents')

    def test_the_default_question_and_an_absent_language(self, research_env):
        projects.run_research('p1', {}, category_scope=None)
        assert research_env['steps'].call_args.kwargs['research_question'] == (
            'What are the main customer pain points?'
        )
        assert research_env['steps'].call_args.kwargs['response_language'] is None

    def test_the_saved_document_and_its_report(self, research_env, log):
        body = {'question': 'Why churn?', 'sources': ['web', 'app'], 'categories': ['billing', 'ux'],
                'sentiments': ['negative', 'mixed'], 'days': 14, 'date_basis': 'review'}
        result = projects.run_research('p1', body, category_scope=None)
        content = _report(
            'Why churn?',
            'Sources: web, app | Categories: billing, ux | Sentiments: negative, mixed | Days: 14 '
            '| Date basis: review',
        )
        item = {
            'pk': 'PROJECT#p1',
            'sk': f'RESEARCH#research_{ID}',
            'gsi1pk': 'PROJECT#p1#DOCUMENTS',
            'gsi1sk': NOW,
            'document_id': f'research_{ID}',
            'document_type': 'research',
            'title': 'Research: Why churn?',
            'question': 'Why churn?',
            'content': content,
            'feedback_count': 2,
            'date_basis': 'review',
            'created_at': NOW,
        }
        research_env['put'].assert_called_once_with(research_env['table'], 'p1', item, 'document_count')
        assert result == {'success': True, 'document': item}
        assert log.info.call_args_list[2] == call(
            f'Saving research document, content size: {len(content)} chars, feedback items: 2',
        )

    def test_empty_filters_read_all_and_the_project_days_default_to_30(self, research_env):
        research_env['project'].return_value = {'project': {'filters': {}}}
        projects.run_research('p1', {}, category_scope=None)
        content = research_env['put'].call_args.args[2]['content']
        assert content == _report(
            'What are the main customer pain points?',
            'Sources: All | Categories: All | Sentiments: All | Days: 30 | Date basis: imported',
        )

    @pytest.mark.parametrize(('length', 'title'), [
        (50, 'Research: ' + 'q' * 50), (51, 'Research: ' + 'q' * 50),
    ])
    def test_the_default_title_keeps_fifty_characters_of_the_question(self, research_env, length, title):
        projects.run_research('p1', {'question': 'q' * length}, category_scope=None)
        assert research_env['put'].call_args.args[2]['title'] == title

    def test_a_given_title_is_kept(self, research_env):
        projects.run_research('p1', {'title': 'Mine'}, category_scope=None)
        assert research_env['put'].call_args.args[2]['title'] == 'Mine'

    def _padded(self, research_env, extra: int) -> str:
        """The saved content for a report whose length is the limit plus ``extra``."""
        research_env['project'].return_value = {'project': {'filters': {}}}
        base = len(_report('Q', 'Sources: All | Categories: All | Sentiments: All | Days: 30 '
                                '| Date basis: imported', ('', 'SUMMARY', 'VALIDATION')))
        research_env['chain'].return_value = ['x' * (MAX_REPORT - base + extra), 'SUMMARY', 'VALIDATION']
        projects.run_research('p1', {'question': 'Q'}, category_scope=None)
        return research_env['put'].call_args.args[2]['content']

    def test_a_report_of_exactly_the_limit_is_saved_whole(self, research_env, log):
        content = self._padded(research_env, 0)
        assert len(content) == MAX_REPORT
        assert not content.endswith(TRUNCATION_SUFFIX)
        log.warning.assert_not_called()

    def test_one_character_more_is_truncated_and_warned_about(self, research_env, log):
        content = self._padded(research_env, 1)
        assert len(content) == MAX_REPORT + len(TRUNCATION_SUFFIX)
        # The report's final newline is the one character over the limit.
        assert content.endswith('VALIDATION' + TRUNCATION_SUFFIX)
        log.warning.assert_called_once_with(
            f'Research report truncated from {MAX_REPORT + len(TRUNCATION_SUFFIX)} to {MAX_REPORT} chars',
        )

    def test_a_failed_chain_is_logged_with_its_cause_and_reported(self, research_env, log):
        error = RuntimeError('boom')
        research_env['chain'].side_effect = error
        with pytest.raises(ServiceError) as exc:
            projects.run_research('p1', {}, category_scope=None)
        assert str(exc.value) == 'Failed to run research. Please try again.'
        assert exc.value.__cause__ is error
        log.exception.assert_called_once_with('Research failed: boom')
        research_env['put'].assert_not_called()


# ===========================================================================
# Project sharing: plumbing
# ===========================================================================


class TestCognitoClient:
    def test_importing_the_module_creates_no_client(self):
        # Lazy on purpose: nothing in this module needs Cognito config at import,
        # and the sentinel the lazy getter tests for is None, not any falsy value.
        assert projects._cognito_client is None

    def test_the_client_is_created_once_and_cached(self):
        with patch.object(projects, '_cognito_client', None), \
                patch.object(projects.boto3, 'client', return_value='the-client') as factory:
            first = projects._get_cognito_client()
            second = projects._get_cognito_client()
        factory.assert_called_once_with('cognito-idp')
        assert (first, second) == ('the-client', 'the-client')


class TestUserPoolId:
    @pytest.mark.parametrize('raw', ['', '   '])
    def test_a_blank_pool_is_a_configuration_error(self, monkeypatch, raw):
        monkeypatch.setenv('USER_POOL_ID', raw)
        with pytest.raises(ConfigurationError) as exc:
            projects._user_pool_id()
        assert str(exc.value) == 'User pool not configured'

    def test_the_pool_id_is_stripped(self, monkeypatch):
        monkeypatch.setenv('USER_POOL_ID', '  us-east-1_abc ')
        assert projects._user_pool_id() == 'us-east-1_abc'


class TestNowIso:
    def test_one_utc_reading(self, clock):
        assert projects._now_iso() == NOW
        clock.now.assert_called_once_with(UTC)


class TestErrorClassification:
    @pytest.mark.parametrize(('response', 'code'), [
        ({'Error': {'Code': 'X'}}, 'X'),
        ({'Error': {}}, ''),
        ({}, ''),
        ({'Error': {'Code': None}}, ''),
    ])
    def test_the_code_or_an_empty_string(self, response, code):
        assert projects._error_code(ClientError(response, 'Op')) == code

    @pytest.mark.parametrize(('code', 'conditional', 'missing_member'), [
        ('ConditionalCheckFailedException', True, True),
        ('ValidationException', False, True),
        ('ProvisionedThroughputExceededException', False, False),
        ('', False, False),
    ])
    def test_each_classifier(self, code, conditional, missing_member):
        error = _client_error(code)
        assert projects._is_conditional_failure(error) is conditional
        assert projects._is_missing_member_failure(error) is missing_member

    def test_the_member_limit_names_the_cap(self):
        error = projects._member_limit_error()
        assert isinstance(error, ValidationError)
        assert str(error) == f'A project can have at most {CAP} members'
        assert CAP == 100


class TestReadProjectMeta:
    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_the_refusal_names_it(self):
        with pytest.raises(ConfigurationError) as exc:
            projects.read_project_meta('p1')
        assert str(exc.value) == TABLE_NOT_CONFIGURED

    def test_a_consistent_read_of_the_meta_row(self, table):
        meta = {**META_KEY, 'name': 'Atlas'}
        table.get_item.return_value = {'Item': meta}
        assert projects.read_project_meta('p1') == meta
        table.get_item.assert_called_once_with(Key=META_KEY, ConsistentRead=True)

    @pytest.mark.parametrize('response', [
        {}, {'Item': None}, {'Item': 'text'}, 'not a dict',
        {'Item': {**META_KEY, 'status': 'deleting'}},
        {'Item': {**META_KEY, 'status': 'deleted'}},
    ])
    def test_missing_malformed_or_tombstoned_is_not_found(self, table, response):
        table.get_item.return_value = response
        with pytest.raises(NotFoundError) as exc:
            projects.read_project_meta('p1')
        assert str(exc.value) == 'Project not found'


class TestGuardedMetaUpdate:
    def test_without_a_condition_the_writable_fence_alone_guards(self, table):
        table.update_item.return_value = {'Attributes': {}}
        result = projects._guarded_meta_update('p1', 'SET a = :a', values={':a': 1})
        assert _only_kwargs(table.update_item) == {
            'Key': META_KEY,
            'UpdateExpression': 'SET a = :a',
            'ConditionExpression': PROJECT_WRITABLE_CONDITION,
            'ExpressionAttributeNames': PROJECT_WRITABLE_ATTRIBUTE_NAMES,
            'ExpressionAttributeValues': {**PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':a': 1},
            'ReturnValues': 'NONE',
        }
        assert result == {'Attributes': {}}

    def test_a_condition_is_anded_in_parentheses_and_names_merged(self, table):
        projects._guarded_meta_update(
            'p1', 'SET #x = :x', condition='attribute_exists(#x)', names={'#x': 'x'},
            values={':x': 2}, return_values='ALL_NEW',
        )
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['ConditionExpression'] == f'({PROJECT_WRITABLE_CONDITION}) AND (attribute_exists(#x))'
        assert kwargs['ExpressionAttributeNames'] == {**PROJECT_WRITABLE_ATTRIBUTE_NAMES, '#x': 'x'}
        assert kwargs['ExpressionAttributeValues'] == {**PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':x': 2}
        assert kwargs['ReturnValues'] == 'ALL_NEW'

    def test_a_client_error_propagates_untouched(self, table):
        error = _client_error('ConditionalCheckFailedException')
        table.update_item.side_effect = error
        with pytest.raises(ClientError) as exc:
            projects._guarded_meta_update('p1', 'SET a = :a')
        assert exc.value is error


class TestEnsureMembersMap:
    def test_an_existing_map_needs_no_write(self):
        with patch.object(projects, '_guarded_meta_update') as update:
            assert projects._ensure_members_map('p1', {'members': {}}) is None
        update.assert_not_called()

    @pytest.mark.parametrize('meta', [{}, {'members': None}, {'members': []}])
    def test_a_missing_map_is_created_only_if_still_absent(self, meta):
        with patch.object(projects, '_guarded_meta_update') as update:
            projects._ensure_members_map('p1', meta)
        update.assert_called_once_with(
            'p1', 'SET #members = :empty', condition='attribute_not_exists(#members)',
            names={'#members': 'members'}, values={':empty': {}},
        )

    def test_losing_the_race_re_reads_the_project(self):
        with patch.object(projects, '_guarded_meta_update',
                          side_effect=_client_error('ConditionalCheckFailedException')), \
                patch.object(projects, 'read_project_meta') as read:
            projects._ensure_members_map('p1', {})
        read.assert_called_once_with('p1')

    def test_any_other_failure_propagates(self):
        error = _client_error('ValidationException')
        with patch.object(projects, '_guarded_meta_update', side_effect=error), \
                patch.object(projects, 'read_project_meta') as read, \
                pytest.raises(ClientError) as exc:
            projects._ensure_members_map('p1', {})
        assert exc.value is error
        read.assert_not_called()


class TestSetProjectVisibility:
    @pytest.mark.parametrize('body', [None, 'public', ['public']])
    def test_a_non_object_body_is_refused(self, body):
        with pytest.raises(ValidationError) as exc:
            projects.set_project_visibility('p1', body)
        assert str(exc.value) == 'Request body must be a JSON object'

    def test_an_unknown_visibility_is_refused_before_any_write(self):
        with patch.object(projects, '_guarded_meta_update') as update, \
                pytest.raises(ValidationError) as exc:
            projects.set_project_visibility('p1', {'visibility': 'secret'})
        assert str(exc.value) == "visibility must be 'public' or 'private'"
        update.assert_not_called()

    def test_the_write_and_the_answer(self):
        with patch.object(projects, '_guarded_meta_update') as update:
            result = projects.set_project_visibility('p1', {'visibility': 'public'})
        update.assert_called_once_with(
            'p1', 'SET #visibility = :visibility, updated_at = :now',
            names={'#visibility': 'visibility'}, values={':visibility': 'public', ':now': NOW},
        )
        assert result == {'success': True, 'visibility': 'public'}

    def test_a_failed_condition_is_a_missing_project(self):
        error = _client_error('ConditionalCheckFailedException')
        with patch.object(projects, '_guarded_meta_update', side_effect=error), \
                pytest.raises(NotFoundError) as exc:
            projects.set_project_visibility('p1', {'visibility': 'private'})
        assert str(exc.value) == 'Project not found'
        assert exc.value.__cause__ is error

    def test_any_other_failure_propagates(self):
        error = _client_error('ValidationException')
        with patch.object(projects, '_guarded_meta_update', side_effect=error), \
                pytest.raises(ClientError) as exc:
            projects.set_project_visibility('p1', {'visibility': 'private'})
        assert exc.value is error


# ===========================================================================
# Cognito lookups
# ===========================================================================


class TestValidatedFilterValue:
    @pytest.mark.parametrize('raw', [None, 3, ['q']])
    def test_a_non_string_names_the_field(self, raw):
        with pytest.raises(ValidationError) as exc:
            projects._validated_filter_value(raw, 'q', 64)
        assert str(exc.value) == 'q must be a string'

    def test_the_value_is_stripped(self):
        assert projects._validated_filter_value('  sam ', 'q', 64) == 'sam'

    def test_the_maximum_is_inclusive_after_stripping(self):
        assert projects._validated_filter_value(' ' + 'x' * 64, 'q', 64) == 'x' * 64
        with pytest.raises(ValidationError) as exc:
            projects._validated_filter_value('x' * 65, 'q', 64)
        assert str(exc.value) == 'q must be at most 64 characters'

    @pytest.mark.parametrize('raw', ['a"b', 'a\\b'])
    def test_a_quote_or_backslash_cannot_escape_the_filter(self, raw):
        with pytest.raises(ValidationError) as exc:
            projects._validated_filter_value(raw, 'sub', 128)
        assert str(exc.value) == 'sub contains unsupported characters'

    def test_the_forbidden_set_is_exactly_the_two_escape_characters(self):
        assert projects._COGNITO_FILTER_FORBIDDEN == ('"', '\\')


class TestValidatedUserSub:
    @pytest.mark.parametrize('raw', ['', '  ', 'mcp:tok', 'agent:ag_1'])
    def test_a_blank_or_synthetic_sub_is_refused(self, raw):
        with pytest.raises(ValidationError) as exc:
            projects._validated_user_sub(raw)
        assert str(exc.value) == 'sub must identify a user'

    def test_the_sub_limit_is_128(self):
        assert projects._validated_user_sub('s' * 128) == 's' * 128
        with pytest.raises(ValidationError) as exc:
            projects._validated_user_sub('s' * 129)
        assert str(exc.value) == 'sub must be at most 128 characters'

    def test_a_non_string_names_the_field(self):
        with pytest.raises(ValidationError) as exc:
            projects._validated_user_sub(None)
        assert str(exc.value) == 'sub must be a string'


def _cognito_user(sub, username='sam', email='sam@example.com', **extra) -> dict:
    return {
        'Username': username,
        'Attributes': [{'Name': 'sub', 'Value': sub}, {'Name': 'email', 'Value': email}],
        **extra,
    }


def _resolved(sub: str, username: str = 'sam', email: str = 'sam@example.com') -> dict:
    return {'sub': sub, 'username': username, 'email': email, 'name': ''}


class TestPublicUser:
    def test_the_four_public_fields(self):
        user = _cognito_user('u1', name='x')
        user['Attributes'].append({'Name': 'name', 'Value': 'Sam S'})
        user['Attributes'].append({'Name': 'phone_number', 'Value': '+1'})
        assert projects._public_user(user) == {
            'sub': 'u1', 'username': 'sam', 'email': 'sam@example.com', 'name': 'Sam S',
        }

    def test_a_disabled_user_is_unusable_but_an_unflagged_one_is_kept(self):
        assert projects._public_user(_cognito_user('u1', Enabled=False)) is None
        assert projects._public_user(_cognito_user('u1', Enabled=True)) == _resolved('u1')
        assert projects._public_user(_cognito_user('u1')) == _resolved('u1')

    @pytest.mark.parametrize('attributes', [
        [], [{'Name': 'sub', 'Value': ''}], [{'Name': 'sub', 'Value': 7}], ['sub'],
    ])
    def test_without_a_string_sub_the_user_is_unusable(self, attributes):
        assert projects._public_user({'Username': 'sam', 'Attributes': attributes}) is None

    def test_missing_username_email_and_name_read_as_empty_strings(self):
        assert projects._public_user({'Attributes': [{'Name': 'sub', 'Value': 'u1'}]}) == {
            'sub': 'u1', 'username': '', 'email': '', 'name': '',
        }


@pytest.fixture
def cognito() -> Iterator[MagicMock]:
    client = MagicMock()
    client.list_users.return_value = {'Users': []}
    with patch.object(projects, '_get_cognito_client', return_value=client):
        yield client


class TestListUsers:
    def test_the_filter_and_limit_reach_cognito_and_unusable_users_are_dropped(self, cognito):
        cognito.list_users.return_value = {'Users': [
            _cognito_user('u1'), _cognito_user('u2', Enabled=False), _cognito_user('u3', username='z'),
        ]}
        users = projects._list_users('username ^= "s"', 7)
        cognito.list_users.assert_called_once_with(
            UserPoolId='us-east-1_testpool', Limit=7, Filter='username ^= "s"',
        )
        assert [u['sub'] for u in users] == ['u1', 'u3']

    @pytest.mark.parametrize('expression', [None, ''])
    def test_without_a_filter_none_is_sent(self, cognito, expression):
        projects._list_users(expression, 1)
        cognito.list_users.assert_called_once_with(UserPoolId='us-east-1_testpool', Limit=1)

    def test_a_response_without_users_is_empty(self, cognito):
        cognito.list_users.return_value = {}
        assert projects._list_users(None, 1) == []

    def test_a_failed_lookup_is_logged_and_reported(self, cognito, log):
        error = _client_error('TooManyRequestsException', 'ListUsers')
        cognito.list_users.side_effect = error
        with pytest.raises(ServiceError) as exc:
            projects._list_users(None, 1)
        assert str(exc.value) == 'Could not look up users'
        assert exc.value.__cause__ is error
        log.exception.assert_called_once_with('Cognito ListUsers failed')


class TestResolveUser:
    def test_an_exact_sub_filter_with_a_limit_of_one(self, cognito):
        cognito.list_users.return_value = {'Users': [_cognito_user('u1')]}
        assert projects._resolve_user('u1') == {
            'sub': 'u1', 'username': 'sam', 'email': 'sam@example.com', 'name': '',
        }
        cognito.list_users.assert_called_once_with(
            UserPoolId='us-east-1_testpool', Limit=1, Filter='sub = "u1"',
        )

    @pytest.mark.parametrize('users', [[], [_cognito_user('other')], [_cognito_user('u1', Enabled=False)]])
    def test_no_enabled_user_with_that_sub_is_not_found(self, cognito, users):
        cognito.list_users.return_value = {'Users': users}
        with pytest.raises(NotFoundError) as exc:
            projects._resolve_user('u1')
        assert str(exc.value) == 'User not found'


class TestSearchMemberCandidates:
    @pytest.fixture
    def meta(self) -> Iterator[dict]:
        meta = {'owner_sub': 'owner-sub', 'members': {'member-sub': {'role': 'viewer'}}}
        with patch.object(projects, 'read_project_meta', return_value=meta):
            yield meta

    @pytest.mark.parametrize('query', [None, '', 'sa', ' sa '])
    def test_fewer_than_three_characters_are_refused_before_any_read(self, query, cognito):
        with patch.object(projects, 'read_project_meta') as read, \
                pytest.raises(ValidationError) as exc:
            projects.search_member_candidates('p1', query)
        assert str(exc.value) == 'Type at least 3 characters to search for people'
        read.assert_not_called()
        cognito.list_users.assert_not_called()

    @pytest.mark.usefixtures('meta')
    def test_three_characters_search_username_then_email_with_the_page_size(self, cognito):
        projects.search_member_candidates('p1', ' sam ')
        assert cognito.list_users.call_args_list == [
            call(UserPoolId='us-east-1_testpool', Limit=20, Filter='username ^= "sam"'),
            call(UserPoolId='us-east-1_testpool', Limit=20, Filter='email ^= "sam"'),
        ]

    @pytest.mark.usefixtures('cognito')
    def test_a_long_query_is_refused_with_the_field_name(self):
        with pytest.raises(ValidationError) as exc:
            projects.search_member_candidates('p1', 'q' * 65)
        assert str(exc.value) == 'q must be at most 64 characters'

    @pytest.mark.usefixtures('meta')
    def test_owner_and_members_are_excluded_and_duplicates_merged(self, cognito):
        cognito.list_users.side_effect = [
            {'Users': [_cognito_user('owner-sub', 'olivia'), _cognito_user('zed-sub', 'Zed'),
                       _cognito_user('amy-sub', 'Amy')]},
            {'Users': [_cognito_user('member-sub', 'mem'), _cognito_user('zed-sub', 'Zed'),
                       _cognito_user('amy2-sub', 'amy')]},
        ]
        result = projects.search_member_candidates('p1', 'sam')
        # Case-insensitive by username, then by sub: 'Zed' sorts after 'amy', not before.
        assert [(u['username'], u['sub']) for u in result['users']] == [
            ('Amy', 'amy-sub'), ('amy', 'amy2-sub'), ('Zed', 'zed-sub'),
        ]

    def test_a_project_without_an_owner_excludes_only_members(self, cognito):
        cognito.list_users.side_effect = [{'Users': [_cognito_user('a-sub', 'a')]}, {'Users': []}]
        with patch.object(projects, 'read_project_meta', return_value={'owner_sub': None, 'members': {}}):
            result = projects.search_member_candidates('p1', 'abc')
        assert [u['sub'] for u in result['users']] == ['a-sub']

    @pytest.mark.parametrize(('found', 'listed'), [(20, 20), (21, 20)])
    @pytest.mark.usefixtures('meta')
    def test_the_twentieth_candidate_is_listed_and_the_twenty_first_is_not(self, cognito, found, listed):
        cognito.list_users.side_effect = [
            {'Users': [_cognito_user(f'u{i:02d}', f'user{i:02d}') for i in range(found)]},
            {'Users': []},
        ]
        result = projects.search_member_candidates('p1', 'user')
        assert len(result['users']) == listed
        assert result['users'][-1]['sub'] == f'u{listed - 1:02d}'


# ===========================================================================
# Members
# ===========================================================================


class TestRoleAndMemberHelpers:
    @pytest.mark.parametrize('value', ['owner', 'admin', '', None, 'Viewer'])
    def test_an_unknown_role_is_a_validation_error_with_the_policy_wording(self, value):
        with pytest.raises(ValidationError) as exc:
            projects._validated_role(value)
        assert str(exc.value) == "role must be 'viewer' or 'editor'"

    @pytest.mark.parametrize('role', ['viewer', 'editor'])
    def test_the_two_member_roles_pass(self, role):
        assert projects._validated_role(role) == role

    def test_a_public_member_row(self):
        entry = {'role': 'editor', 'username': 'eddie', 'email': 'e@x', 'added_by': 'owner-sub',
                 'added_at': NOW}
        assert projects._public_member('editor-sub', entry) == {
            'sub': 'editor-sub', 'role': 'editor', 'username': 'eddie', 'email': 'e@x',
            'added_by': 'owner-sub', 'added_at': NOW,
        }


MEMBERS_META = {
    **META_KEY, 'owner_sub': 'owner-sub', 'owner_username': 'olivia', 'owner_email': 'olivia@example.com',
    'visibility': 'private',
    'members': {'editor-sub': {'role': 'editor', 'username': 'eddie', 'email': 'eddie@example.com',
                               'added_by': 'owner-sub', 'added_at': NOW}},
}


class TestGetProjectMembers:
    def test_a_manager_sees_visibility_owner_members_and_their_access(self):
        with patch.object(projects, 'read_project_meta', return_value=MEMBERS_META) as read:
            result = projects.get_project_members('p1', OWNER)
        read.assert_called_once_with('p1')
        assert result == {
            'visibility': 'private',
            'owner': {'sub': 'owner-sub', 'username': 'olivia', 'email': 'olivia@example.com'},
            'members': [{'sub': 'editor-sub', 'role': 'editor', 'username': 'eddie',
                         'email': 'eddie@example.com', 'added_by': 'owner-sub', 'added_at': NOW}],
            'access': {'role': 'owner', 'can_view': True, 'can_edit': True, 'can_manage': True},
        }

    def test_a_member_sees_no_emails(self):
        with patch.object(projects, 'read_project_meta', return_value=MEMBERS_META):
            result = projects.get_project_members('p1', Caller(subject='editor-sub'))
        assert result['owner'] == {'sub': 'owner-sub', 'username': 'olivia'}
        assert 'email' not in result['members'][0]
        assert result['access'] == {'role': 'editor', 'can_view': True, 'can_edit': True,
                                    'can_manage': False}


def _full(count: int) -> dict:
    return {f'user-{i}': {'role': 'viewer'} for i in range(count)}


class TestMemberAddRefusal:
    def test_the_owner(self):
        with pytest.raises(ConflictError) as exc:
            projects._member_add_refusal({'owner_sub': 'u1', 'members': {}}, 'u1')
        assert str(exc.value) == 'User already owns this project'

    def test_an_existing_member(self):
        with pytest.raises(ConflictError) as exc:
            projects._member_add_refusal({'members': {'u1': {'role': 'viewer'}}}, 'u1')
        assert str(exc.value) == 'User is already a member of this project'

    def test_ninety_nine_members_accept_a_hundredth_and_a_hundred_refuse(self):
        assert projects._member_add_refusal({'members': _full(CAP - 1)}, 'new') is None
        with pytest.raises(ValidationError) as exc:
            projects._member_add_refusal({'members': _full(CAP)}, 'new')
        assert str(exc.value) == f'A project can have at most {CAP} members'


class TestAddProjectMember:
    @pytest.fixture
    def env(self) -> Iterator[dict[str, MagicMock]]:
        with patch.object(projects, 'read_project_meta', return_value=dict(MEMBERS_META)) as read, \
                patch.object(projects, '_resolve_user', return_value=_resolved('new-sub')) as resolve, \
                patch.object(projects, '_ensure_members_map') as ensure, \
                patch.object(projects, '_guarded_meta_update') as update:
            yield {'read': read, 'resolve': resolve, 'ensure': ensure, 'update': update}

    @pytest.mark.parametrize('body', [None, 'x', []])
    def test_a_non_object_body_is_refused(self, body):
        with pytest.raises(ValidationError) as exc:
            projects.add_project_member('p1', body, OWNER)
        assert str(exc.value) == 'Request body must be a JSON object'

    def test_the_sub_is_validated_before_the_role_and_both_before_any_read(self, env):
        with pytest.raises(ValidationError) as exc:
            projects.add_project_member('p1', {'sub': '', 'role': 'owner'}, OWNER)
        assert str(exc.value) == 'sub must identify a user'
        with pytest.raises(ValidationError) as exc:
            projects.add_project_member('p1', {'sub': 'new-sub', 'role': 'owner'}, OWNER)
        assert str(exc.value) == "role must be 'viewer' or 'editor'"
        env['read'].assert_not_called()

    def test_the_entry_the_write_and_the_answer(self, env):
        result = projects.add_project_member('p1', {'sub': 'new-sub', 'role': 'viewer'}, OWNER)
        entry = {'role': 'viewer', 'username': 'sam', 'email': 'sam@example.com',
                 'added_by': 'owner-sub', 'added_at': NOW}
        env['resolve'].assert_called_once_with('new-sub')
        env['ensure'].assert_called_once_with('p1', MEMBERS_META)
        env['update'].assert_called_once_with(
            'p1', 'SET #members.#sub = :entry, updated_at = :now',
            condition=(
                'attribute_not_exists(#members.#sub) AND size(#members) < :max '
                'AND (attribute_not_exists(owner_sub) OR owner_sub <> :sub)'
            ),
            names={'#members': 'members', '#sub': 'new-sub'},
            values={':entry': entry, ':now': NOW, ':max': CAP, ':sub': 'new-sub'},
        )
        assert result == {'success': True, 'member': {'sub': 'new-sub', **entry}}

    def test_a_refusal_from_the_read_stops_before_the_directory_lookup(self, env):
        with pytest.raises(ConflictError) as exc:
            projects.add_project_member('p1', {'sub': 'editor-sub', 'role': 'viewer'}, OWNER)
        assert str(exc.value) == 'User is already a member of this project'
        env['resolve'].assert_not_called()
        env['update'].assert_not_called()

    def test_losing_the_race_re_reads_and_reports_the_current_reason(self, env):
        env['update'].side_effect = _client_error('ConditionalCheckFailedException')
        env['read'].side_effect = [dict(MEMBERS_META), {**MEMBERS_META, 'owner_sub': 'new-sub'}]
        with pytest.raises(ConflictError) as exc:
            projects.add_project_member('p1', {'sub': 'new-sub', 'role': 'viewer'}, OWNER)
        assert str(exc.value) == 'User already owns this project'
        assert env['read'].call_args_list == [call('p1'), call('p1')]

    def test_losing_the_race_without_a_visible_reason_asks_for_a_retry(self, env):
        error = _client_error('ConditionalCheckFailedException')
        env['update'].side_effect = error
        with pytest.raises(ConflictError) as exc:
            projects.add_project_member('p1', {'sub': 'new-sub', 'role': 'viewer'}, OWNER)
        assert str(exc.value) == 'Project changed while adding the member; please retry'
        assert exc.value.__cause__ is error

    def test_any_other_failure_propagates_without_a_re_read(self, env):
        error = _client_error('ValidationException')
        env['update'].side_effect = error
        with pytest.raises(ClientError) as exc:
            projects.add_project_member('p1', {'sub': 'new-sub', 'role': 'viewer'}, OWNER)
        assert exc.value is error
        assert env['read'].call_count == 1


class TestUpdateProjectMember:
    @pytest.mark.parametrize('body', [None, 'x'])
    def test_a_non_object_body_is_refused(self, body):
        with pytest.raises(ValidationError) as exc:
            projects.update_project_member('p1', 'editor-sub', body)
        assert str(exc.value) == 'Request body must be a JSON object'

    def test_the_role_is_validated_before_any_write(self):
        with patch.object(projects, '_guarded_meta_update') as update, \
                pytest.raises(ValidationError) as exc:
            projects.update_project_member('p1', 'editor-sub', {'role': 'owner'})
        assert str(exc.value) == "role must be 'viewer' or 'editor'"
        update.assert_not_called()

    def test_the_write_reads_back_the_whole_row_and_answers_with_the_member(self):
        attributes = {'members': {'editor-sub': {'role': 'viewer', 'username': 'eddie', 'email': 'e@x',
                                                 'added_by': 'owner-sub', 'added_at': 'then'}}}
        with patch.object(projects, '_guarded_meta_update',
                          return_value={'Attributes': attributes}) as update:
            result = projects.update_project_member('p1', 'editor-sub', {'role': 'viewer'})
        update.assert_called_once_with(
            'p1', 'SET #members.#sub.#role = :role, updated_at = :now',
            condition='attribute_exists(#members.#sub)',
            names={'#members': 'members', '#sub': 'editor-sub', '#role': 'role'},
            values={':role': 'viewer', ':now': NOW},
            return_values='ALL_NEW',
        )
        assert result == {'success': True, 'member': {
            'sub': 'editor-sub', 'role': 'viewer', 'username': 'eddie', 'email': 'e@x',
            'added_by': 'owner-sub', 'added_at': 'then',
        }}

    @pytest.mark.parametrize('response', [{}, {'Attributes': None}, {'Attributes': {'members': {}}}])
    def test_a_row_that_came_back_without_the_member_is_not_found(self, response):
        with patch.object(projects, '_guarded_meta_update', return_value=response), \
                pytest.raises(NotFoundError) as exc:
            projects.update_project_member('p1', 'editor-sub', {'role': 'viewer'})
        assert str(exc.value) == 'Member not found'


MANAGE = project_access.ProjectAccess(role='owner')
VIEW = project_access.ProjectAccess(role='viewer')


class TestRemoveProjectMember:
    @pytest.mark.parametrize('caller', [
        Caller(subject='viewer-sub'),                        # someone else
        Caller(subject='editor-sub', delegated=True),        # a token acting as the member
        Caller(subject=''),                                  # no subject at all
    ])
    def test_only_a_manager_or_the_member_in_person_may_remove(self, caller):
        with patch.object(projects, '_guarded_meta_update') as update, \
                pytest.raises(AuthorizationError) as exc:
            projects.remove_project_member('p1', 'editor-sub', caller, VIEW)
        assert str(exc.value) == 'You do not have permission to manage this project'
        update.assert_not_called()

    @pytest.mark.parametrize('caller', [Caller(subject='editor-sub'), Caller(subject='owner-sub')])
    def test_leaving_or_managing_removes_the_member(self, caller):
        access = MANAGE if caller.subject == 'owner-sub' else VIEW
        with patch.object(projects, '_guarded_meta_update') as update:
            result = projects.remove_project_member('p1', 'editor-sub', caller, access)
        update.assert_called_once_with(
            'p1', 'REMOVE #members.#sub SET updated_at = :now',
            condition='attribute_exists(#members.#sub)',
            names={'#members': 'members', '#sub': 'editor-sub'},
            values={':now': NOW},
        )
        assert result == {'success': True}

    def test_a_nameless_member_cannot_be_left_by_a_nameless_caller(self):
        with patch.object(projects, '_guarded_meta_update') as update, \
                pytest.raises(AuthorizationError):
            projects.remove_project_member('p1', '', Caller(subject=''), VIEW)
        update.assert_not_called()


# The two member writes guarded by `attribute_exists(#members.#sub)`; each must translate a failed
# condition the same way, so the failure cases run once per write.
MEMBER_WRITES = [
    pytest.param(lambda: projects.update_project_member('p1', 'editor-sub', {'role': 'viewer'}), id='update'),
    pytest.param(lambda: projects.remove_project_member('p1', 'editor-sub', OWNER, MANAGE), id='remove'),
]


@pytest.mark.parametrize('write', MEMBER_WRITES)
class TestAGuardedMemberWriteThatFails:
    @pytest.mark.parametrize('code', ['ConditionalCheckFailedException', 'ValidationException'])
    def test_a_missing_member_404s_the_project_first(self, write, code):
        error = _client_error(code)
        with patch.object(projects, '_guarded_meta_update', side_effect=error), \
                patch.object(projects, 'read_project_meta') as read, \
                pytest.raises(NotFoundError) as exc:
            write()
        read.assert_called_once_with('p1')
        assert str(exc.value) == 'Member not found'
        assert exc.value.__cause__ is error

    def test_any_other_failure_propagates(self, write):
        error = _client_error('ProvisionedThroughputExceededException')
        with patch.object(projects, '_guarded_meta_update', side_effect=error), \
                pytest.raises(ClientError) as exc:
            write()
        assert exc.value is error


# ===========================================================================
# Ownership transfer
# ===========================================================================

PREVIOUS = {'sub': 'owner-sub', 'username': 'olivia', 'email': 'olivia@example.com'}
NEW_OWNER = {'sub': 'new-sub', 'username': 'sam', 'email': 'sam@example.com'}
TRANSFER_SET = (
    'SET owner_sub = :new_sub, owner_username = :new_username, owner_email = :new_email, '
    'updated_at = :now'
)
PREV_ENTRY = {'role': 'editor', 'username': 'olivia', 'email': 'olivia@example.com',
              'added_by': 'owner-sub', 'added_at': NOW}


class TestNewOwnerIdentity:
    def test_identity_is_taken_from_the_directory_without_the_display_name(self):
        with patch.object(projects, '_resolve_user', return_value=_resolved('new-sub')) as resolve:
            assert projects._new_owner_identity('new-sub') == NEW_OWNER
        resolve.assert_called_once_with('new-sub')


class TestOwnerTransferUpdate:
    def test_a_previous_owner_and_a_non_admin_caller(self):
        assert projects._owner_transfer_update(PREVIOUS, NEW_OWNER, OWNER, NOW) == (
            f'{TRANSFER_SET}, #members.#prev = :prev_entry REMOVE #members.#new',
            'owner_sub = :prev_sub AND (attribute_exists(#members.#new) OR size(#members) < :max) '
            'AND owner_sub = :caller_sub',
            {'#members': 'members', '#new': 'new-sub', '#prev': 'owner-sub'},
            {':new_sub': 'new-sub', ':new_username': 'sam', ':new_email': 'sam@example.com',
             ':now': NOW, ':prev_entry': PREV_ENTRY, ':prev_sub': 'owner-sub', ':max': CAP,
             ':caller_sub': 'owner-sub'},
        )

    def test_a_previous_owner_and_an_admin_caller(self):
        update, condition, _, values = projects._owner_transfer_update(
            PREVIOUS, NEW_OWNER, ADMIN, NOW,
        )
        assert update == f'{TRANSFER_SET}, #members.#prev = :prev_entry REMOVE #members.#new'
        assert condition == (
            'owner_sub = :prev_sub AND (attribute_exists(#members.#new) OR size(#members) < :max)'
        )
        assert ':caller_sub' not in values
        assert values[':prev_entry']['added_by'] == 'admin-sub'

    def test_a_legacy_project_and_an_admin_caller(self):
        assert projects._owner_transfer_update(None, NEW_OWNER, ADMIN, NOW) == (
            f'{TRANSFER_SET} REMOVE #members.#new',
            'attribute_not_exists(owner_sub)',
            {'#members': 'members', '#new': 'new-sub'},
            {':new_sub': 'new-sub', ':new_username': 'sam', ':new_email': 'sam@example.com', ':now': NOW},
        )

    def test_a_legacy_project_and_a_non_admin_caller(self):
        _, condition, _, values = projects._owner_transfer_update(None, NEW_OWNER, OWNER, NOW)
        assert condition == 'attribute_not_exists(owner_sub) AND owner_sub = :caller_sub'
        assert values[':caller_sub'] == 'owner-sub'


class TestTransferProjectOwner:
    @pytest.fixture
    def env(self) -> Iterator[dict[str, MagicMock]]:
        with patch.object(projects, 'read_project_meta', return_value=dict(MEMBERS_META)) as read, \
                patch.object(projects, '_new_owner_identity', return_value=dict(NEW_OWNER)) as identity, \
                patch.object(projects, '_ensure_members_map') as ensure, \
                patch.object(projects, '_guarded_meta_update') as update:
            yield {'read': read, 'identity': identity, 'ensure': ensure, 'update': update}

    @pytest.mark.parametrize('body', [None, 'x'])
    def test_a_non_object_body_is_refused(self, body):
        with pytest.raises(ValidationError) as exc:
            projects.transfer_project_owner('p1', body, OWNER)
        assert str(exc.value) == 'Request body must be a JSON object'

    def test_the_sub_is_validated_before_any_read(self, env):
        with pytest.raises(ValidationError) as exc:
            projects.transfer_project_owner('p1', {'sub': 'mcp:x'}, OWNER)
        assert str(exc.value) == 'sub must identify a user'
        env['read'].assert_not_called()

    @pytest.mark.parametrize('meta', [
        {**MEMBERS_META, 'owner_sub': 'someone-else'},
        {**MEMBERS_META, 'owner_sub': None},
    ])
    def test_a_non_admin_who_no_longer_owns_the_project_is_told_it_changed(self, env, meta):
        env['read'].return_value = meta
        with pytest.raises(ConflictError) as exc:
            projects.transfer_project_owner('p1', {'sub': 'new-sub'}, OWNER)
        assert str(exc.value) == 'Project ownership changed; reload and retry'
        assert projects.OWNERSHIP_CHANGED_MESSAGE == 'Project ownership changed; reload and retry'
        env['update'].assert_not_called()

    def test_handing_over_to_the_current_owner_writes_nothing(self, env):
        result = projects.transfer_project_owner('p1', {'sub': 'owner-sub'}, OWNER)
        assert result == {'success': True, 'owner': PREVIOUS}
        env['identity'].assert_not_called()
        env['ensure'].assert_not_called()
        env['update'].assert_not_called()

    def test_the_compare_and_swap_is_built_against_the_read_and_the_write_is_fenced(self, env):
        expected = projects._owner_transfer_update(PREVIOUS, NEW_OWNER, OWNER, NOW)
        result = projects.transfer_project_owner('p1', {'sub': 'new-sub'}, OWNER)
        env['identity'].assert_called_once_with('new-sub')
        env['ensure'].assert_called_once_with('p1', MEMBERS_META)
        env['update'].assert_called_once_with(
            'p1', expected[0], condition=expected[1], names=expected[2], values=expected[3],
        )
        assert result == {'success': True, 'owner': NEW_OWNER}

    def test_a_full_project_refuses_an_outsider_before_the_directory_lookup(self, env):
        env['read'].return_value = {**MEMBERS_META, 'members': _full(CAP)}
        with pytest.raises(ValidationError) as exc:
            projects.transfer_project_owner('p1', {'sub': 'new-sub'}, OWNER)
        assert str(exc.value) == f'A project can have at most {CAP} members'
        env['identity'].assert_not_called()

    def test_a_full_project_still_hands_over_to_a_member(self, env):
        env['read'].return_value = {**MEMBERS_META, 'members': {**_full(CAP - 1), 'new-sub': {'role': 'viewer'}}}
        assert projects.transfer_project_owner('p1', {'sub': 'new-sub'}, OWNER)['success'] is True

    def test_ninety_nine_members_accept_an_outsider(self, env):
        env['read'].return_value = {**MEMBERS_META, 'members': _full(CAP - 1)}
        assert projects.transfer_project_owner('p1', {'sub': 'new-sub'}, OWNER)['success'] is True

    def test_a_legacy_project_has_no_previous_owner_to_re_add_so_no_cap_applies(self, env):
        env['read'].return_value = {**META_KEY, 'members': _full(CAP)}
        expected = projects._owner_transfer_update(None, NEW_OWNER, ADMIN, NOW)
        projects.transfer_project_owner('p1', {'sub': 'new-sub'}, ADMIN)
        env['update'].assert_called_once_with(
            'p1', expected[0], condition=expected[1], names=expected[2], values=expected[3],
        )

    def test_losing_the_race_re_reads_then_reports_the_change(self, env):
        error = _client_error('ConditionalCheckFailedException')
        env['update'].side_effect = error
        with pytest.raises(ConflictError) as exc:
            projects.transfer_project_owner('p1', {'sub': 'new-sub'}, OWNER)
        assert str(exc.value) == 'Project ownership changed; reload and retry'
        assert exc.value.__cause__ is error
        assert env['read'].call_args_list == [call('p1'), call('p1')]

    def test_any_other_failure_propagates_without_a_re_read(self, env):
        error = _client_error('ValidationException')
        env['update'].side_effect = error
        with pytest.raises(ClientError) as exc:
            projects.transfer_project_owner('p1', {'sub': 'new-sub'}, OWNER)
        assert exc.value is error
        assert env['read'].call_count == 1
