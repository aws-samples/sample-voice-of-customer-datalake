"""Mutation hardening for `api/projects.py` lines 1-1265 (budget env overrides,
project list/create/get/update, the chat context, email redaction, the
deletion fence and the S3 sweeps).

`test_projects.py`, `test_project_permissions.py`,
`test_persona_context_limits.py`, `test_projects_prototype_urls.py` and
`test_project_delete_lifecycle_moto.py` pin that a viewer gets no emails, that a
tombstone is not a project and that a delete sweeps every artifact, but a
mutation run found what they cannot see:

* the WORDING of every refusal and every operator-facing log line: the
  `ValidationError` bodies a user reads in the browser (``purpose must be at
  most 2000 characters``, ``Select at most 20 documents``) and the warnings an
  operator greps for in CloudWatch (``Ignoring non-numeric ...``, ``JOBS_TABLE
  is not configured ...``) with their exact `extra` keys.
* the exact DynamoDB and S3 arguments the stubs ignore: the by-type index name
  and its descending order, the projection of every read (the chat-context
  read must never project `content`), `ConsistentRead` on every partition read,
  the deletion fence's update/condition expressions, the `Quiet` delete and the
  `Bucket`/`Prefix` of each sweep.
* the ACCEPTED side of each bound: a 2000-character purpose saves and the
  2001st character is refused; exactly 20 selected documents and a
  128-character id pass; a non-JSON reply is logged with exactly its first 200
  characters; 1000 avatar keys go in one delete batch and the 1001st opens a
  second; the fence is attempted exactly four times.
* the shape of every response: `list_projects` and `create_project` rows key
  by key, every `update_project` SET clause, and the chat-context summaries'
  field allowlists.
"""
import json
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import ClassVar
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

import projects
from shared import category_access, project_access
from shared.exceptions import (
    AuthorizationError,
    ConfigurationError,
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
from shared.tables import get_feedback_table, get_projects_table

OWNER = Caller(subject='owner-sub', username='owner', email='owner@example.com')
ADMIN = Caller(subject='admin-sub', is_admin=True, username='admin', email='admin@example.com')
VIEWER = Caller(subject='viewer-sub', username='viewer', email='viewer@example.com')
STRANGER = Caller(subject='stranger-sub', username='stranger', email='stranger@example.com')
FIXED_NOW = datetime(2026, 3, 4, 5, 6, 7, tzinfo=UTC)
FIXED_ISO = '2026-03-04T05:06:07+00:00'


def _meta(**overrides) -> dict:
    meta = {
        'pk': 'PROJECT#proj_1', 'sk': 'META', 'project_id': 'proj_1', 'name': 'Project One',
        'description': 'desc', 'owner_sub': 'owner-sub', 'owner_username': 'owner',
        'owner_email': 'owner@example.com', 'visibility': 'private',
        'members': {
            'viewer-sub': {
                'role': 'viewer', 'username': 'viewer', 'email': 'viewer@example.com',
                'added_by': 'owner-sub', 'added_at': '2026-01-01T00:00:00+00:00',
            },
        },
        'created_at': '2026-01-01T00:00:00+00:00', 'updated_at': '2026-01-02T00:00:00+00:00',
    }
    meta.update(overrides)
    return meta


@pytest.fixture
def table() -> Iterator[MagicMock]:
    with patch.object(projects, 'projects_table') as stub:
        yield stub


@pytest.fixture
def log() -> Iterator[MagicMock]:
    with patch.object(projects, 'logger') as logger:
        yield logger


@pytest.fixture
def frozen_clock() -> Iterator[MagicMock]:
    with patch.object(projects, 'datetime') as clock:
        clock.now.return_value = FIXED_NOW
        yield clock


def _client_error(code: str) -> ClientError:
    return ClientError({'Error': {'Code': code}}, 'UpdateItem')


# ---------------------------------------------------------------------------
# Budget env overrides and named limits
# ---------------------------------------------------------------------------


class TestEnvPositiveInt:
    @pytest.mark.parametrize('raw', ['', None])
    def test_an_absent_or_empty_variable_is_none_without_a_warning(self, log, monkeypatch, raw):
        if raw is None:
            monkeypatch.delenv('MAX_PERSONA_CONTEXT_CHARS', raising=False)
        else:
            monkeypatch.setenv('MAX_PERSONA_CONTEXT_CHARS', raw)
        assert projects._env_positive_int('MAX_PERSONA_CONTEXT_CHARS') is None
        log.warning.assert_not_called()

    def test_a_non_numeric_value_is_named_in_the_warning(self, log, monkeypatch):
        monkeypatch.setenv('MAX_PERSONA_CONTEXT_CHARS', 'lots')
        assert projects._env_positive_int('MAX_PERSONA_CONTEXT_CHARS') is None
        log.warning.assert_called_once_with(
            "Ignoring non-numeric MAX_PERSONA_CONTEXT_CHARS='lots'; using the derived default"
        )

    @pytest.mark.parametrize('raw', ['0', '-7'])
    def test_a_non_positive_value_is_named_in_the_warning(self, log, monkeypatch, raw):
        monkeypatch.setenv('FEEDBACK_LIMIT_PERSONA', raw)
        assert projects._env_positive_int('FEEDBACK_LIMIT_PERSONA') is None
        log.warning.assert_called_once_with(
            f'Ignoring non-positive FEEDBACK_LIMIT_PERSONA={int(raw)}; using the derived default '
            "(a non-positive character budget would mean 'no limit')"
        )

    def test_one_is_the_smallest_accepted_value(self, log, monkeypatch):
        monkeypatch.setenv('FEEDBACK_LIMIT_PERSONA', '1')
        assert projects._env_positive_int('FEEDBACK_LIMIT_PERSONA') == 1
        log.warning.assert_not_called()


class TestPersonaContextBudget:
    def test_both_numbers_derive_from_the_documents_surface_window(self, monkeypatch):
        monkeypatch.delenv('MAX_PERSONA_CONTEXT_CHARS', raising=False)
        monkeypatch.delenv('FEEDBACK_LIMIT_PERSONA', raising=False)
        with patch.object(projects, 'surface_context_window_tokens', return_value=50_000) as window, \
                patch.object(projects, 'feedback_char_budget', return_value=70_000) as budget, \
                patch.object(projects, 'feedback_item_limit', return_value=35) as limit:
            assert projects.persona_context_budget() == (70_000, 35)
        window.assert_called_once_with('documents')
        budget.assert_called_once_with(window_tokens=50_000)
        limit.assert_called_once_with(70_000)

    def test_a_pinned_budget_still_derives_the_limit_from_it(self, monkeypatch):
        monkeypatch.setenv('MAX_PERSONA_CONTEXT_CHARS', '9000')
        monkeypatch.delenv('FEEDBACK_LIMIT_PERSONA', raising=False)
        with patch.object(projects, 'feedback_item_limit', return_value=4) as limit:
            assert projects.persona_context_budget() == (9000, 4)
        limit.assert_called_once_with(9000)

    def test_a_pinned_limit_is_not_derived(self, monkeypatch):
        monkeypatch.delenv('MAX_PERSONA_CONTEXT_CHARS', raising=False)
        monkeypatch.setenv('FEEDBACK_LIMIT_PERSONA', '12')
        with patch.object(projects, 'feedback_char_budget', return_value=70_000), \
                patch.object(projects, 'feedback_item_limit') as limit:
            assert projects.persona_context_budget() == (70_000, 12)
        limit.assert_not_called()


class TestNamedConstants:
    @pytest.mark.parametrize(('name', 'value'), [
        ('ENV_MAX_PERSONA_CONTEXT_CHARS', 'MAX_PERSONA_CONTEXT_CHARS'),
        ('ENV_FEEDBACK_LIMIT_PERSONA', 'FEEDBACK_LIMIT_PERSONA'),
        ('FEEDBACK_LIMIT_RESEARCH', 100),
        ('FEEDBACK_LIMIT_AUTOFILL', 20),
        ('FEEDBACK_LIMIT_BRIEF', 40),
        ('FEEDBACK_LIMIT_RESEARCH_SUGGEST', 40),
        ('PERSONA_PROMPT_VERSION', '2.2.0'),
        ('PERSONA_SURFACE', 'documents'),
        ('MAX_PROJECT_PURPOSE_CHARS', 2000),
        ('MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS', 20),
        ('MAX_CHAT_CONTEXT_ID_LENGTH', 128),
        ('DOCUMENT_DELETE_ATTEMPTS', 4),
        ('PROJECT_DELETE_FENCE_ATTEMPTS', 4),
        ('S3_DELETE_BATCH_SIZE', 1000),
    ])
    def test_each_literal_is_exactly_its_documented_value(self, name, value):
        assert getattr(projects, name) == value

    def test_the_document_sort_key_prefixes_in_order(self):
        assert projects._DOCUMENT_SORT_KEY_PREFIXES == (
            'PRD#', 'PRFAQ#', 'RESEARCH#', 'DOC#', 'PRODUCT_REPORT#', 'PROTOTYPE#',
        )

    def test_the_chat_context_field_allowlists(self):
        assert projects._CHAT_CONTEXT_PROJECT_FIELDS == ('sk', 'name')
        assert projects._CHAT_CONTEXT_PERSONA_FIELDS == (
            'sk', 'persona_id', 'name', 'tagline', 'quotes', 'goals_motivations',
            'pain_points', 'avatar_url',
        )
        assert projects._CHAT_CONTEXT_DOCUMENT_FIELDS == (
            'sk', 'document_id', 'document_type', 'title', 'base_title', 'version',
        )

    def test_the_default_export_prompt_opens_and_closes_as_documented(self):
        prompt = projects.KIRO_DEFAULT_EXPORT_PROMPT
        assert prompt.startswith(
            'Build against the project material provided here rather than from assumptions.\n\n'
            '- The personas described here are the audience.'
        )
        assert prompt.endswith(
            'If two documents disagree, surface the conflict instead of picking one.'
        )
        assert prompt.count('\n- ') == 5


# ---------------------------------------------------------------------------
# Thin wrappers and feedback reads
# ---------------------------------------------------------------------------


class TestModuleWiring:
    def test_the_module_tables_are_the_shared_resources(self):
        assert projects.projects_table is get_projects_table()
        assert projects.feedback_table is get_feedback_table()

    @pytest.mark.parametrize('name', [
        'list_projects', 'create_project', 'get_project', '_query_project_chat_items',
        'get_project_chat_context', 'update_project', '_start_project_deletion',
        '_delete_project_job_rows', '_delete_objects_under_prefix', '_delete_project_avatar_objects',
    ])
    def test_every_entry_point_is_the_tracer_wrapper_around_the_named_function(self, name):
        # functools.wraps stores __wrapped__ in the function's __dict__; a dropped
        # decorator is a missing key, not a renamed function.
        assert vars(getattr(projects, name))['__wrapped__'].__qualname__ == name


class TestWrappers:
    def test_the_avatar_wrapper_forwards_every_argument_in_order(self):
        with patch.object(projects, '_generate_persona_avatar', return_value={'avatar_url': 'u'}) as inner:
            result = projects.generate_persona_avatar({'name': 'A'}, 'bucket', 'proj_1')
        assert result == {'avatar_url': 'u'}
        inner.assert_called_once_with({'name': 'A'}, 'bucket', 'proj_1')

    def test_the_feedback_wrapper_reads_the_module_table_with_the_given_limit(self):
        with patch.object(projects, '_get_feedback_context', return_value=[{'id': 1}]) as inner, \
                patch.object(projects, 'feedback_table') as feedback_table:
            assert projects.get_feedback_context({'days': 3}, 7) == [{'id': 1}]
        inner.assert_called_once_with(feedback_table, {'days': 3}, 7)


class TestScopedFeedbackContext:
    def test_a_client_scope_key_is_replaced_by_the_callers_scope(self):
        with patch.object(projects, 'get_feedback_context', return_value=['row']) as read:
            result = projects.get_scoped_feedback_context(
                {'days': 7, category_access.SCOPE_CONFIG_KEY: {'all': True}, 'date_basis': 'REVIEW'},
                25, {'all': False, 'categories': ['billing']},
            )
        assert result == ['row']
        read.assert_called_once_with(
            {'days': 7, 'date_basis': 'review', 'category_scope': {'all': False, 'categories': ['billing']}},
            limit=25,
        )

    def test_a_none_scope_reads_unrestricted_and_an_empty_scope_is_still_a_scope(self):
        with patch.object(projects, 'get_feedback_context', return_value=[]) as read:
            projects.get_scoped_feedback_context({'days': 1}, 5, None)
            projects.get_scoped_feedback_context({'days': 1}, 5, {})
        assert read.call_args_list == [
            call({'days': 1, 'date_basis': 'imported'}, limit=5),
            call({'days': 1, 'date_basis': 'imported', 'category_scope': {}}, limit=5),
        ]

    @pytest.mark.parametrize('filters', ['not-a-dict', None, ['days']])
    def test_non_dict_filters_read_only_the_default_basis(self, filters):
        with patch.object(projects, 'get_feedback_context', return_value=[]) as read:
            projects.get_scoped_feedback_context(filters, 3, None)
        read.assert_called_once_with({'date_basis': 'imported'}, limit=3)


class TestFixPersonaName:
    @pytest.mark.parametrize(('name', 'fixed'), [
        ('VeronicaChen-OBrien', 'Veronica Chen-OBrien'),
        ('MaryJaneWatson', 'Mary Jane Watson'),
        ('John Smith', 'John Smith'),
        ('ABC', 'ABC'),
        ('a1B', 'a1B'),
        ('', ''),
    ])
    def test_only_a_lower_to_upper_transition_gains_a_space(self, name, fixed):
        assert projects.fix_persona_name(name) == fixed


class TestFeedbackFiltersFromBody:
    def test_an_empty_body_gives_every_default(self):
        assert projects.feedback_filters_from_body({}) == {
            'sources': [], 'categories': [], 'sentiments': [], 'days': 30,
        }

    def test_given_values_pass_through_and_days_is_validated(self):
        assert projects.feedback_filters_from_body({
            'sources': ['web'], 'categories': ['billing'], 'sentiments': ['negative'],
            'days': '14', 'extra': 'dropped',
        }) == {'sources': ['web'], 'categories': ['billing'], 'sentiments': ['negative'], 'days': 14}


# ---------------------------------------------------------------------------
# Pagination helpers and their exact query arguments
# ---------------------------------------------------------------------------


class TestPaginatedItems:
    def test_follows_the_cursor_and_skips_non_dict_items_without_mutating_the_query(self, table):
        table.query.side_effect = [
            {'Items': [{'sk': 'A'}, 'junk', {'sk': 'B'}], 'LastEvaluatedKey': {'pk': 'p', 'sk': 'B'}},
            {'Items': 'not-a-list', 'LastEvaluatedKey': {}},
        ]
        query = {'KeyConditionExpression': 'k'}
        assert list(projects._paginated_items(query)) == [{'sk': 'A'}, {'sk': 'B'}]
        assert query == {'KeyConditionExpression': 'k'}
        assert table.query.call_args_list == [
            call(KeyConditionExpression='k'),
            call(KeyConditionExpression='k', ExclusiveStartKey={'pk': 'p', 'sk': 'B'}),
        ]

    @pytest.mark.parametrize('response', ['not-a-dict', None, {'Items': [{'sk': 'A'}], 'LastEvaluatedKey': 'x'}])
    def test_a_malformed_page_or_cursor_ends_the_walk(self, table, response):
        table.query.side_effect = [response]
        items = list(projects._paginated_items({'k': 'v'}))
        assert items == ([{'sk': 'A'}] if isinstance(response, dict) else [])
        table.query.assert_called_once_with(k='v')

    def test_a_caller_that_stops_early_reads_no_further_page(self, table):
        table.query.side_effect = [{'Items': [{'sk': 'A'}, {'sk': 'B'}], 'LastEvaluatedKey': {'pk': 'p'}}]
        assert next(projects._paginated_items({})) == {'sk': 'A'}
        table.query.assert_called_once_with()


class TestIndexAndPartitionReads:
    def test_the_project_index_is_read_newest_first(self, table):
        table.query.return_value = {'Items': [{'sk': 'META'}]}
        assert list(projects._iter_project_index_rows()) == [{'sk': 'META'}]
        table.query.assert_called_once_with(
            IndexName='gsi1-by-type',
            KeyConditionExpression=Key('gsi1pk').eq('TYPE#PROJECT'),
            ScanIndexForward=False,
        )

    def test_children_are_counted_from_a_sort_key_only_projection(self, table):
        table.query.return_value = {'Items': [
            {'sk': 'META'}, {'sk': 7}, {}, {'sk': 'PERSONA#a'}, {'sk': 'PRD#1'}, {'sk': 'PRFAQ#1'},
            {'sk': 'RESEARCH#1'}, {'sk': 'VOTE#1'}, {'sk': 'DOC#1'}, {'sk': 'PRODUCT_REPORT#1'},
            {'sk': 'PROTOTYPE#1'}, {'sk': 'PERSONA#b'},
        ]}
        assert projects._count_project_children('proj_1') == (2, 6)
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('PROJECT#proj_1'),
            ProjectionExpression='sk',
        )

    def test_a_whole_partition_is_read_consistently(self, table):
        table.query.return_value = {'Items': [{'sk': 'META'}]}
        assert projects._query_partition_items('PROJECT#proj_1') == [{'sk': 'META'}]
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('PROJECT#proj_1'), ConsistentRead=True,
        )

    def test_a_document_lookup_projects_only_its_identity_and_stops_at_the_match(self, table):
        table.query.side_effect = [
            {'Items': [{'document_id': 'other'}], 'LastEvaluatedKey': {'pk': 'p', 'sk': 'x'}},
            {'Items': [{'document_id': 'doc_1', 'sk': 'PRD#doc_1'}, {'document_id': 'doc_2'}],
             'LastEvaluatedKey': {'pk': 'p', 'sk': 'y'}},
            {'Items': [{'document_id': 'doc_3'}]},
        ]
        assert projects._find_document('proj_1', 'doc_1') == {'document_id': 'doc_1', 'sk': 'PRD#doc_1'}
        expected = {
            'KeyConditionExpression': Key('pk').eq('PROJECT#proj_1'),
            'ConsistentRead': True,
            'ProjectionExpression': 'pk, sk, document_id, #type, #title, base_title, #version',
            'ExpressionAttributeNames': {'#type': 'document_type', '#title': 'title', '#version': 'version'},
        }
        assert table.query.call_args_list == [
            call(**expected), call(**expected, ExclusiveStartKey={'pk': 'p', 'sk': 'x'}),
        ]

    def test_a_missing_document_is_none_after_every_page(self, table):
        table.query.return_value = {'Items': [{'document_id': 'other'}]}
        assert projects._find_document('proj_1', 'doc_1') is None

    def test_partition_keys_project_pk_and_sk_and_drop_malformed_rows(self, table):
        table.query.return_value = {'Items': [
            {'pk': 'PROJECT#p', 'sk': 'META', 'name': 'extra'}, {'pk': 'PROJECT#p'}, {'pk': 1, 'sk': 'x'},
            {'pk': 'PROJECT#p', 'sk': 2},
        ]}
        assert list(projects._iter_partition_keys('PROJECT#p')) == [{'pk': 'PROJECT#p', 'sk': 'META'}]
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('PROJECT#p'), ConsistentRead=True,
            ProjectionExpression='pk, sk',
        )


# ---------------------------------------------------------------------------
# list_projects
# ---------------------------------------------------------------------------


class TestListProjects:
    def test_without_a_table_the_list_is_empty(self):
        with patch.object(projects, 'projects_table', None):
            assert projects.list_projects(ADMIN) == {'projects': []}

    @pytest.mark.usefixtures('table')
    def test_each_visible_row_is_built_key_by_key_for_a_manager(self):
        with patch.object(projects, '_iter_project_index_rows', return_value=iter([
            _meta(deletion_started_at='x'),
            _meta(project_id='fixture', verification_fixture_id='vf'),
            _meta(project_id='hidden', owner_sub='someone-else', members={}),
            _meta(purpose='Keep the lights on', status='archived', created_by_agent='agent-1'),
        ])), patch.object(projects, '_count_project_children', return_value=(3, 4)) as counts:
            result = projects.list_projects(OWNER)
        counts.assert_called_once_with('proj_1')
        assert result == {'projects': [{
            'project_id': 'proj_1', 'name': 'Project One', 'description': 'desc',
            'purpose': 'Keep the lights on', 'status': 'archived',
            'created_at': '2026-01-01T00:00:00+00:00', 'updated_at': '2026-01-02T00:00:00+00:00',
            'persona_count': 3, 'document_count': 4, 'created_by_agent': 'agent-1',
            'visibility': 'private',
            'owner': {'sub': 'owner-sub', 'username': 'owner', 'email': 'owner@example.com'},
            'access': {'role': 'owner', 'can_view': True, 'can_edit': True, 'can_manage': True},
            'member_count': 1,
        }]}

    @pytest.mark.usefixtures('table')
    def test_defaults_apply_and_a_viewer_gets_no_owner_email(self):
        meta = _meta(created_by_agent=7)
        with patch.object(projects, '_iter_project_index_rows', return_value=iter([meta])), \
                patch.object(projects, '_count_project_children', return_value=(0, 0)):
            [row] = projects.list_projects(VIEWER)['projects']
        assert row['purpose'] == ''
        assert row['status'] == 'active'
        assert 'created_by_agent' not in row
        assert row['owner'] == {'sub': 'owner-sub', 'username': 'owner'}
        assert row['access'] == {'role': 'viewer', 'can_view': True, 'can_edit': False, 'can_manage': False}

    @pytest.mark.usefixtures('table')
    def test_a_hidden_project_costs_no_count_query(self):
        with patch.object(projects, '_iter_project_index_rows', return_value=iter([_meta()])), \
                patch.object(projects, '_count_project_children') as counts:
            assert projects.list_projects(STRANGER) == {'projects': []}
        counts.assert_not_called()


# ---------------------------------------------------------------------------
# create_project
# ---------------------------------------------------------------------------


class TestCreateProject:
    def test_without_a_table_the_create_is_a_configuration_error(self):
        with patch.object(projects, 'projects_table', None), \
                pytest.raises(ConfigurationError, match=r'^Projects table not configured$'):
            projects.create_project({}, OWNER)

    @pytest.mark.parametrize('caller', [
        Caller(subject='minter-sub', delegated=True),
        Caller(subject=''),
        Caller(subject='', delegated=True),
    ])
    def test_a_credential_or_subjectless_caller_cannot_own_a_project(self, table, caller):
        with pytest.raises(AuthorizationError, match=r'^Only a signed-in user can create a project$'):
            projects.create_project({}, caller)
        table.put_item.assert_not_called()

    def test_the_stored_item_and_the_response_for_a_bare_body(self, table, frozen_clock, fixed_id_suffix):
        result = projects.create_project({}, OWNER)
        project_id = f'proj_20260304050607_{fixed_id_suffix}'
        item = {
            'pk': f'PROJECT#{project_id}', 'sk': 'META', 'gsi1pk': 'TYPE#PROJECT',
            'gsi1sk': FIXED_ISO, 'project_id': project_id, 'name': 'New Project',
            'description': '', 'purpose': '', 'status': 'active', 'created_at': FIXED_ISO,
            'updated_at': FIXED_ISO, 'persona_count': 0, 'document_count': 0, 'filters': {},
            'owner_sub': 'owner-sub', 'owner_username': 'owner',
            'owner_email': 'owner@example.com', 'members': {}, 'visibility': 'private',
        }
        table.put_item.assert_called_once_with(
            Item=item, ConditionExpression='attribute_not_exists(pk) AND attribute_not_exists(sk)',
        )
        assert result == {'success': True, 'project': {
            **item,
            'members': [],
            'owner': {'sub': 'owner-sub', 'username': 'owner', 'email': 'owner@example.com'},
            'access': {'role': 'owner', 'can_view': True, 'can_edit': True, 'can_manage': True},
            'member_count': 0,
        }}
        # One UTC reading stamps the id and every timestamp (it was a naive local
        # reading for the id and a UTC one for the timestamps).
        assert frozen_clock.now.call_args_list == [call(UTC)]

    @pytest.mark.usefixtures('frozen_clock')
    def test_every_body_field_lands_and_the_purpose_is_trimmed(self, table):
        projects.create_project({
            'name': 'Named', 'description': 'Described', 'purpose': '  why  ', 'visibility': 'public',
            'filters': {'days': 7}, 'kiro_export_prompt': 'Do this', 'ignored': 'x',
        }, OWNER)
        item = table.put_item.call_args.kwargs['Item']
        assert item['name'] == 'Named'
        assert item['description'] == 'Described'
        assert item['purpose'] == 'why'
        assert item['visibility'] == 'public'
        assert item['filters'] == {'days': 7}
        # The per-project Kiro prompt is no longer stored (3.00.00).
        assert 'kiro_export_prompt' not in item
        assert 'ignored' not in item

    def test_an_invalid_visibility_is_the_validators_message(self, table):
        with pytest.raises(ValidationError) as refusal:
            projects.create_project({'visibility': 'secret'}, OWNER)
        with pytest.raises(ValueError, match=r'visibility') as original:
            project_access.validate_visibility('secret')
        assert str(refusal.value) == str(original.value)
        table.put_item.assert_not_called()

    @pytest.mark.usefixtures('frozen_clock')
    def test_an_agent_creates_for_its_handoff_target(self, table):
        agent = Caller(subject='agent-owner', delegated=True, agent_id='agent-1')
        sharing = {'owner_sub': 'target', 'owner_username': 't', 'owner_email': 't@x', 'members': {},
                   'created_by_agent': 'agent-1'}
        with patch.object(projects, '_agent_created_sharing', return_value=sharing) as shared:
            result = projects.create_project({}, agent)
        shared.assert_called_once_with(agent)
        item = table.put_item.call_args.kwargs['Item']
        assert item['owner_sub'] == 'target'
        assert item['created_by_agent'] == 'agent-1'
        assert result['project']['access'] == {
            'role': 'editor', 'can_view': True, 'can_edit': True, 'can_manage': False,
        }


class TestValidatedPurpose:
    @pytest.mark.parametrize('value', [None, 7, ['x']])
    def test_a_non_string_is_refused(self, value):
        with pytest.raises(ValidationError, match=r'^purpose must be a string$'):
            projects._validated_purpose(value)

    def test_exactly_the_limit_saves_trimmed_and_one_more_is_refused(self):
        assert projects._validated_purpose('  ' + 'p' * 2000 + '  ') == 'p' * 2000
        with pytest.raises(ValidationError, match=r'^purpose must be at most 2000 characters$'):
            projects._validated_purpose('p' * 2001)


class TestAgentCreatedSharing:
    AGENT = Caller(
        subject='acting', delegated=True, agent_id='agent-1', agent_owner_sub='target',
        agent_editor_subs=('target', 'gone', 'editor-1'),
    )

    def test_the_owner_and_each_resolvable_editor_are_recorded(self, log):
        def resolve(sub: str) -> dict:
            if sub == 'gone':
                raise NotFoundError('User not found')
            return {'sub': sub, 'username': f'{sub}-name', 'email': f'{sub}@x'}

        with patch.object(projects, '_new_owner_identity', return_value={'username': 'tn', 'email': 't@x'}) as owner, \
                patch.object(projects, '_resolve_user', side_effect=resolve) as users, \
                patch.object(projects, '_now_iso', return_value='NOW'):
            sharing = projects._agent_created_sharing(self.AGENT)
        owner.assert_called_once_with('target')
        assert users.call_args_list == [call('gone'), call('editor-1')]
        assert sharing == {
            'owner_sub': 'target', 'owner_username': 'tn', 'owner_email': 't@x',
            'members': {'editor-1': {
                'role': 'editor', 'username': 'editor-1-name', 'email': 'editor-1@x',
                'added_by': 'agent:agent-1', 'added_at': 'NOW',
            }},
            'created_by_agent': 'agent-1',
        }
        log.warning.assert_called_once_with('Skipping an inactive editor for an agent-created project')

    def test_an_agent_without_an_owner_is_refused_before_any_lookup(self):
        with patch.object(projects, '_new_owner_identity') as owner, \
                pytest.raises(AuthorizationError, match=r'^This agent has no owner to create a project for$'):
            projects._agent_created_sharing(Caller(subject='', delegated=True, agent_id='agent-1'))
        owner.assert_not_called()

    def test_an_inactive_owner_is_refused(self):
        with patch.object(projects, '_new_owner_identity', side_effect=NotFoundError('User not found')), \
                pytest.raises(ValidationError, match=r'^The project owner is not an active user$'):
            projects._agent_created_sharing(self.AGENT)


# ---------------------------------------------------------------------------
# Email redaction
# ---------------------------------------------------------------------------


class TestEmailRedaction:
    def test_a_viewer_loses_every_email_but_keeps_everything_else(self):
        meta = _meta()
        payload = {
            'owner_email': 'owner@example.com', 'owner': {'sub': 'o', 'email': 'o@x', 'username': 'o'},
            'members': [{'sub': 'm', 'email': 'm@x'}, 'odd'], 'name': 'kept',
        }
        assert projects._without_emails_unless_manager(payload, meta, VIEWER) == {
            'owner': {'sub': 'o', 'username': 'o'}, 'members': [{'sub': 'm'}, 'odd'], 'name': 'kept',
        }

    def test_a_manager_gets_the_payload_object_untouched(self):
        payload = {'owner_email': 'owner@example.com'}
        assert projects._without_emails_unless_manager(payload, _meta(), OWNER) is payload
        assert projects._without_emails_unless_manager(payload, _meta(), ADMIN) is payload

    def test_a_payload_without_owner_or_list_members_is_only_stripped_of_owner_email(self):
        assert projects._without_emails_unless_manager(
            {'owner_email': 'x', 'members': {'m': {'email': 'kept'}}}, _meta(), VIEWER,
        ) == {'members': {'m': {'email': 'kept'}}}

    @pytest.mark.parametrize('entry', ['text', None, 3])
    def test_a_non_dict_entry_is_returned_as_is(self, entry):
        assert projects._without_email(entry) is entry

    def test_stored_meta_loses_owner_email_and_each_member_email(self):
        meta = _meta(members={'a': {'role': 'viewer', 'email': 'a@x'}, 'b': {'role': 'editor'}})
        redacted = projects._without_stored_emails(meta)
        assert 'owner_email' not in redacted
        assert redacted['members'] == {'a': {'role': 'viewer'}, 'b': {'role': 'editor'}}
        assert redacted['owner_username'] == 'owner'
        assert meta['owner_email'] == 'owner@example.com'

    def test_stored_meta_with_list_members_keeps_them_untouched(self):
        assert projects._without_stored_emails({'members': ['x'], 'owner_email': 'o'}) == {'members': ['x']}

    def test_with_sharing_fields_replaces_the_member_map_by_the_public_list(self):
        result = projects._with_sharing_fields(_meta(), OWNER)
        assert result['members'] == [{
            'sub': 'viewer-sub', 'role': 'viewer', 'username': 'viewer', 'email': 'viewer@example.com',
            'added_by': 'owner-sub', 'added_at': '2026-01-01T00:00:00+00:00',
        }]
        assert result['visibility'] == 'private'
        assert result['member_count'] == 1
        assert result['owner_email'] == 'owner@example.com'


# ---------------------------------------------------------------------------
# Prototype URLs
# ---------------------------------------------------------------------------


class TestSignedPrototypeUrl:
    def test_a_signed_url_overwrites_the_stored_one_for_an_s3_backed_prototype(self):
        item = {'document_type': 'prototype', 'document_id': 'd1', 'prototype_url': 'stale'}
        with patch.object(projects, 'prototype_signed_url', return_value='https://signed') as sign:
            assert projects._with_signed_prototype_url(item, 'proj_1') == {
                'document_type': 'prototype', 'document_id': 'd1', 'prototype_url': 'https://signed',
            }
        sign.assert_called_once_with('proj_1', 'd1')

    def test_an_unsignable_prototype_loses_its_stale_url(self):
        item = {'document_type': 'prototype', 'document_id': 'd1', 'prototype_url': 'stale'}
        with patch.object(projects, 'prototype_signed_url', return_value=None):
            assert projects._with_signed_prototype_url(item, 'proj_1') == {
                'document_type': 'prototype', 'document_id': 'd1',
            }

    def test_an_inline_prototype_is_never_signed(self):
        item = {'document_type': 'prototype', 'document_id': 'd1', 'content': '<html>', 'prototype_url': 'stale'}
        with patch.object(projects, 'prototype_signed_url') as sign:
            assert projects._with_signed_prototype_url(item, 'proj_1') == {
                'document_type': 'prototype', 'document_id': 'd1', 'content': '<html>',
            }
        sign.assert_not_called()

    @pytest.mark.parametrize('item', [
        {'document_type': 'prd', 'document_id': 'd1', 'prototype_url': 'kept'},
        {'document_type': 'prototype', 'prototype_url': 'kept'},
        {'document_type': 'prototype', 'document_id': '', 'prototype_url': 'kept'},
    ])
    def test_other_documents_and_id_less_prototypes_are_returned_as_is(self, item):
        with patch.object(projects, 'prototype_signed_url') as sign:
            assert projects._with_signed_prototype_url(item, 'proj_1') is item
        sign.assert_not_called()
        assert item['prototype_url'] == 'kept'


# ---------------------------------------------------------------------------
# Prompt helpers
# ---------------------------------------------------------------------------


class TestProductContextOrPlaceholder:
    def test_a_built_block_is_returned_for_the_project(self):
        with patch('product_context.build_product_context_block', return_value='BLOCK') as build:
            assert projects._product_context_or_placeholder('proj_1') == 'BLOCK'
        build.assert_called_once_with('proj_1')

    def test_a_failure_logs_its_traceback_and_degrades_to_the_placeholder(self, log):
        with patch('product_context.build_product_context_block', side_effect=RuntimeError('boom')):
            assert projects._product_context_or_placeholder('proj_1') == '(No product context provided.)'
        log.exception.assert_called_once_with('Failed to build product context')


class TestWithoutCodeFence:
    def test_text_not_opening_with_a_fence_is_unchanged(self):
        assert projects._without_code_fence('  ```json\n{}\n```') == '  ```json\n{}\n```'
        assert projects._without_code_fence('{"a": 1}') == '{"a": 1}'

    def test_fence_lines_are_dropped_and_the_rest_joined_and_stripped(self):
        assert projects._without_code_fence('```json\n{"a": 1,\n\n "b": 2}\n  ```  \n') == '{"a": 1,\n\n "b": 2}'


class TestFencedJson:
    def test_a_fenced_object_is_parsed(self, log):
        assert projects._fenced_json(' ```json\n{"k": "v"}\n``` ', 'Bad') == {'k': 'v'}
        log.warning.assert_not_called()

    @pytest.mark.parametrize('raw', [None, ''])
    def test_nothing_is_logged_as_unparseable_with_an_empty_raw(self, log, raw):
        assert projects._fenced_json(raw, 'Bad reply') == {}
        log.warning.assert_called_once_with('Bad reply raw=')

    def test_unparseable_text_is_logged_with_exactly_its_first_200_characters(self, log):
        assert projects._fenced_json('x' * 250, 'Bad reply') == {}
        log.warning.assert_called_once_with('Bad reply raw=' + 'x' * 200)

    def test_a_non_object_is_logged_as_such_with_exactly_its_first_200_characters(self, log):
        raw = json.dumps(list(range(100)))
        assert len(raw) > 200
        assert projects._fenced_json(raw, 'Bad reply') == {}
        log.warning.assert_called_once_with('Bad reply (not a JSON object) raw=' + raw[:200])


# ---------------------------------------------------------------------------
# Stored-record helpers and their 404s
# ---------------------------------------------------------------------------


class TestStoredRecordHelpers:
    def test_a_stored_persona_is_read_by_its_exact_key(self, table):
        table.get_item.return_value = {'Item': {'sk': 'PERSONA#p1'}}
        assert projects._stored_persona('proj_1', 'p1') == {'sk': 'PERSONA#p1'}
        table.get_item.assert_called_once_with(Key={'pk': 'PROJECT#proj_1', 'sk': 'PERSONA#p1'})

    @pytest.mark.parametrize('response', [{}, {'Item': None}, {'Item': {}}])
    def test_a_missing_persona_is_a_named_404(self, table, response):
        table.get_item.return_value = response
        with pytest.raises(NotFoundError, match=r'^Persona not found$'):
            projects._stored_persona('proj_1', 'p1')

    def test_a_note_is_found_by_position(self):
        persona = {'research_notes': [{'note_id': 'a'}, {'note_id': 'b'}, {'note_id': 'c'}]}
        assert projects._persona_note_index(persona, 'c') == 2
        assert projects._persona_note_index(persona, 'a') == 0

    @pytest.mark.parametrize('persona', [{}, {'research_notes': []}, {'research_notes': [{'note_id': 'a'}]}])
    def test_a_missing_note_is_a_named_404(self, persona):
        with pytest.raises(NotFoundError, match=r'^Note not found$'):
            projects._persona_note_index(persona, 'zzz')

    def test_require_document_returns_the_found_document_or_a_named_404(self):
        assert projects._require_document({'sk': 'PRD#1'}) == {'sk': 'PRD#1'}
        with pytest.raises(NotFoundError, match=r'^Document not found$'):
            projects._require_document(None)

    @pytest.mark.parametrize('prefix', ['PRD#', 'PRFAQ#', 'RESEARCH#', 'DOC#', 'PRODUCT_REPORT#', 'PROTOTYPE#'])
    def test_every_document_prefix_is_an_accepted_sort_key(self, prefix):
        assert projects._stored_document_sort_key({'sk': f'{prefix}d1'}) == f'{prefix}d1'

    @pytest.mark.parametrize('sk', [None, 7, 'META', 'PERSONA#p', 'prd#1'])
    def test_any_other_sort_key_is_a_named_500(self, sk):
        with pytest.raises(ServiceError, match=r'^Stored document has an invalid sort key$'):
            projects._stored_document_sort_key({'sk': sk})

    def test_a_missing_document_is_a_404_before_the_key_is_inspected(self):
        with pytest.raises(NotFoundError, match=r'^Document not found$'):
            projects._stored_document_sort_key(None)


# ---------------------------------------------------------------------------
# get_project
# ---------------------------------------------------------------------------


class TestGetProject:
    def _partition(self) -> list[dict]:
        return [
            _meta(),
            {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'avatar_url': 's3://bucket/avatars/p1.png'},
            {'sk': 'PERSONA#p2', 'persona_id': 'p2', 'avatar_url': 'https://cdn/kept.png'},
            {'sk': 'PERSONA#p3', 'persona_id': 'p3'},
            {'sk': 'PRD#d1', 'document_id': 'd1', 'document_type': 'prd', 'title': 'T', 'version': 1,
             'base_title': 'T', 'created_at': '2026-01-01T00:00:00+00:00'},
            {'sk': 'VOTE#1'},
        ]

    def test_without_a_table_the_read_is_a_configuration_error(self):
        with patch.object(projects, 'projects_table', None), \
                pytest.raises(ConfigurationError, match=r'^Projects table not configured$'):
            projects.get_project('proj_1', OWNER)

    def test_an_empty_partition_is_a_named_404(self):
        with patch.object(projects, '_query_partition_items', return_value=[]) as read, \
                pytest.raises(NotFoundError, match=r'^Project not found$'):
            projects.get_project('proj_1', OWNER)
        read.assert_called_once_with('PROJECT#proj_1')

    @pytest.mark.parametrize('rows', [
        [{'sk': 'PERSONA#p1'}],
        [_meta(deletion_started_at='x')],
        [_meta(status='deleted')],
    ])
    def test_a_partition_without_a_live_meta_is_a_metadata_404(self, rows):
        with patch.object(projects, '_query_partition_items', return_value=rows), \
                pytest.raises(NotFoundError, match=r'^Project metadata not found$'):
            projects.get_project('proj_1', OWNER)

    def test_a_refused_caller_gets_the_generic_404_before_any_signing(self):
        with patch.object(projects, '_query_partition_items', return_value=self._partition()), \
                patch.object(projects, 'get_avatar_cdn_url') as sign_avatar, \
                patch.object(projects, '_with_signed_prototype_url') as sign_prototype, \
                pytest.raises(NotFoundError, match=r'^Project not found$'):
            projects.get_project('proj_1', STRANGER)
        sign_avatar.assert_not_called()
        sign_prototype.assert_not_called()

    def test_a_manager_gets_sharing_fields_signed_avatars_and_the_default_prompt(self):
        with patch.object(projects, '_query_partition_items', return_value=self._partition()), \
                patch.object(projects, 'get_avatar_cdn_url', return_value='https://cdn/signed') as sign_avatar, \
                patch.object(projects, '_with_signed_prototype_url', side_effect=lambda item, _pid: {**item, 'signed': True}) as sign_prototype, \
                patch.object(projects, 'normalize_document_versions', side_effect=lambda docs: [{**d, 'normalized': True} for d in docs]):
            result = projects.get_project('proj_1', OWNER)
        sign_avatar.assert_called_once_with('s3://bucket/avatars/p1.png')
        sign_prototype.assert_called_once_with(self._partition()[4], 'proj_1')
        assert result['personas'] == [
            {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'avatar_url': 'https://cdn/signed'},
            {'sk': 'PERSONA#p2', 'persona_id': 'p2', 'avatar_url': 'https://cdn/kept.png'},
            {'sk': 'PERSONA#p3', 'persona_id': 'p3'},
        ]
        assert result['documents'] == [{**self._partition()[4], 'signed': True, 'normalized': True}]
        project = result['project']
        assert project['kiro_default_export_prompt'] == projects.KIRO_DEFAULT_EXPORT_PROMPT
        assert project['owner_email'] == 'owner@example.com'
        assert project['access'] == {'role': 'owner', 'can_view': True, 'can_edit': True, 'can_manage': True}
        assert project['members'] == project_access.public_members(_meta())
        assert set(result) == {'project', 'personas', 'documents'}

    def test_an_internal_read_redacts_every_email_and_computes_no_sharing(self):
        with patch.object(projects, '_query_partition_items', return_value=self._partition()), \
                patch.object(projects, 'get_avatar_cdn_url', return_value='signed'):
            project = projects.get_project('proj_1')['project']
        assert 'owner_email' not in project
        assert project['members'] == {'viewer-sub': {
            'role': 'viewer', 'username': 'viewer', 'added_by': 'owner-sub',
            'added_at': '2026-01-01T00:00:00+00:00',
        }}
        assert 'access' not in project
        assert project['kiro_default_export_prompt'] == projects.KIRO_DEFAULT_EXPORT_PROMPT


# ---------------------------------------------------------------------------
# Chat context
# ---------------------------------------------------------------------------


class TestValidatedChatContextDocumentIds:
    @pytest.mark.parametrize('raw', ['d1', None, {'d1': 1}])
    def test_a_non_array_is_refused(self, raw):
        with pytest.raises(ValidationError, match=r'^selected_document_ids must be an array$'):
            projects._validated_chat_context_document_ids(raw)

    def test_exactly_twenty_pass_and_the_twenty_first_is_refused(self):
        assert projects._validated_chat_context_document_ids([f'd{i}' for i in range(20)]) == [
            f'd{i}' for i in range(20)
        ]
        with pytest.raises(ValidationError, match=r'^Select at most 20 documents$'):
            projects._validated_chat_context_document_ids([f'd{i}' for i in range(21)])

    @pytest.mark.parametrize('value', [7, None, '', ' d1', 'd1 ', 'd' * 129])
    def test_each_malformed_id_is_refused_with_the_bound(self, value):
        with pytest.raises(
            ValidationError,
            match=r'^Each selected document id must be a non-empty string of at most 128 characters$',
        ):
            projects._validated_chat_context_document_ids(['ok', value])

    def test_a_128_character_id_passes_and_duplicates_keep_first_position(self):
        long_id = 'd' * 128
        assert projects._validated_chat_context_document_ids(['b', long_id, 'a', 'b', long_id]) == [
            'b', long_id, 'a',
        ]


class TestQueryProjectChatItems:
    EXPECTED_QUERY: ClassVar[dict] = {
        'KeyConditionExpression': Key('pk').eq('PROJECT#proj_1'),
        'ConsistentRead': True,
        'ProjectionExpression': (
            'pk, sk, project_id, #name, #status, #deleting, persona_id, '
            'tagline, quotes, goals_motivations, pain_points, avatar_url, '
            'document_id, #type, #title, base_title, #version, created_at, '
            'owner_sub, owner_username, owner_email, #visibility, #members, created_by_agent'
        ),
        'ExpressionAttributeNames': {
            '#name': 'name', '#status': 'status', '#deleting': 'deletion_started_at',
            '#type': 'document_type', '#title': 'title', '#version': 'version',
            '#visibility': 'visibility', '#members': 'members',
        },
    }

    def test_the_read_projects_exactly_the_summary_fields_and_follows_pages(self, table):
        table.query.side_effect = [
            {'Items': [{'sk': 'META'}, 'junk'], 'LastEvaluatedKey': {'pk': 'p', 'sk': 'META'}},
            {'Items': [{'sk': 'PRD#1'}], 'LastEvaluatedKey': {}},
        ]
        assert projects._query_project_chat_items('proj_1') == [{'sk': 'META'}, {'sk': 'PRD#1'}]
        assert table.query.call_args_list == [
            call(**self.EXPECTED_QUERY),
            call(**self.EXPECTED_QUERY, ExclusiveStartKey={'pk': 'p', 'sk': 'META'}),
        ]

    @pytest.mark.parametrize('response', ['nope', {'Items': 'nope'}, {'Items': [{'sk': 'A'}], 'LastEvaluatedKey': 'x'}])
    def test_a_malformed_page_or_cursor_ends_the_walk(self, table, response):
        table.query.side_effect = [response]
        expected = [{'sk': 'A'}] if isinstance(response, dict) and isinstance(response['Items'], list) else []
        assert projects._query_project_chat_items('proj_1') == expected
        table.query.assert_called_once()


class TestGetProjectChatContext:
    ITEMS: ClassVar[list[dict]] = [
        _meta(),
        {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'P', 'tagline': 't', 'quotes': ['q'],
         'goals_motivations': ['g'], 'pain_points': ['pp'], 'avatar_url': 'a', 'identity': 'hidden'},
        {'sk': 'PRD#d1', 'document_id': 'd1', 'document_type': 'prd', 'title': 'T', 'base_title': 'T',
         'version': 1, 'created_at': '2026-01-01T00:00:00+00:00', 'status': 'hidden'},
        {'sk': 'PROTOTYPE#d2', 'document_id': 'd2', 'document_type': 'prd', 'title': 'Proto', 'base_title': 'Proto',
         'version': 1, 'created_at': '2026-01-01T00:00:00+00:00'},
        {'sk': 'DOC#d3', 'document_id': 'd3', 'document_type': 'prototype', 'title': 'Also proto',
         'base_title': 'Also proto', 'version': 1, 'created_at': '2026-01-01T00:00:00+00:00'},
        {'sk': 7},
    ]

    @pytest.mark.parametrize('project_id', [7, None, '', ' p1', 'p1 ', 'p' * 129])
    def test_a_malformed_project_id_is_refused_before_the_ids_are_checked(self, table, project_id):
        with pytest.raises(ValidationError, match=r'^project_id must be 1-128 characters$'):
            projects.get_project_chat_context(project_id, 'not-a-list', OWNER)
        table.query.assert_not_called()

    def test_a_128_character_project_id_reaches_the_read(self, table):
        table.query.return_value = {'Items': []}
        with pytest.raises(NotFoundError, match=r'^Project not found$'):
            projects.get_project_chat_context('p' * 128, [], OWNER)
        table.query.assert_called_once()

    @pytest.mark.parametrize('items', [[], [_meta(deletion_started_at='x')], [_meta(status='deleting')]])
    def test_a_missing_or_tombstoned_project_is_a_named_404(self, table, items):
        table.query.return_value = {'Items': items}
        with pytest.raises(NotFoundError, match=r'^Project not found$'):
            projects.get_project_chat_context('proj_1', [], OWNER)

    def test_a_refused_caller_gets_the_same_404(self, table):
        table.query.return_value = {'Items': self.ITEMS}
        with pytest.raises(NotFoundError, match=r'^Project not found$'):
            projects.get_project_chat_context('proj_1', [], STRANGER)
        table.get_item.assert_not_called()

    def test_summaries_carry_exactly_the_allowlisted_fields_and_the_access(self, table):
        table.query.return_value = {'Items': self.ITEMS}
        result = projects.get_project_chat_context('proj_1', [], VIEWER)
        assert result == {
            'project': {'sk': 'META', 'name': 'Project One'},
            'personas': [{
                'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'P', 'tagline': 't', 'quotes': ['q'],
                'goals_motivations': ['g'], 'pain_points': ['pp'], 'avatar_url': 'a',
            }],
            'documents': [
                {'sk': 'PRD#d1', 'document_id': 'd1', 'document_type': 'prd', 'title': 'T (v1)',
                 'base_title': 'T', 'version': 1},
                {'sk': 'PROTOTYPE#d2', 'document_id': 'd2', 'document_type': 'prd', 'title': 'Proto (v1)',
                 'base_title': 'Proto', 'version': 1},
                {'sk': 'DOC#d3', 'document_id': 'd3', 'document_type': 'prototype', 'title': 'Also proto (v1)',
                 'base_title': 'Also proto', 'version': 1},
            ],
            'access': {'role': 'viewer', 'can_view': True, 'can_edit': False, 'can_manage': False},
        }
        table.get_item.assert_not_called()

    def test_a_selected_document_is_read_consistently_for_its_content_only(self, table):
        table.query.return_value = {'Items': self.ITEMS}
        table.get_item.return_value = {'Item': {'document_id': 'd1', 'content': 'BODY'}}
        result = projects.get_project_chat_context('proj_1', ['d1', 'd2', 'd3'], OWNER)
        table.get_item.assert_called_once_with(
            Key={'pk': 'PROJECT#proj_1', 'sk': 'PRD#d1'}, ConsistentRead=True,
            ProjectionExpression='document_id, content',
        )
        assert result['documents'][0]['content'] == 'BODY'
        assert 'content' not in result['documents'][1]
        assert 'content' not in result['documents'][2]

    @pytest.mark.parametrize('response', [
        'nope', {}, {'Item': {'document_id': 'other', 'content': 'BODY'}}, {'Item': {'document_id': 'd1', 'content': 7}},
    ])
    def test_a_mismatched_or_non_text_point_read_adds_no_content(self, table, response):
        table.query.return_value = {'Items': self.ITEMS}
        table.get_item.return_value = response
        result = projects.get_project_chat_context('proj_1', ['d1'], OWNER)
        assert 'content' not in result['documents'][0]


# ---------------------------------------------------------------------------
# update_project
# ---------------------------------------------------------------------------


class TestUpdateProject:
    def test_without_a_table_the_update_is_a_configuration_error(self):
        with patch.object(projects, 'projects_table', None), \
                pytest.raises(ConfigurationError, match=r'^Projects table not configured$'):
            projects.update_project('proj_1', {'name': 'x'})

    @pytest.mark.parametrize('status', [None, 7, 'deleting', 'deleted', 'Active', ''])
    def test_a_status_outside_the_public_pair_is_refused(self, table, status):
        with pytest.raises(ValidationError, match=r'^Project status must be active or archived$'):
            projects.update_project('proj_1', {'status': status})
        table.update_item.assert_not_called()

    @pytest.mark.usefixtures('frozen_clock')
    def test_an_empty_body_still_touches_updated_at_under_the_writable_condition(self, table):
        assert projects.update_project('proj_1', {}) == {'success': True}
        table.update_item.assert_called_once_with(
            Key={'pk': 'PROJECT#proj_1', 'sk': 'META'},
            UpdateExpression='SET updated_at = :now',
            ConditionExpression=PROJECT_WRITABLE_CONDITION,
            ExpressionAttributeValues={**PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':now': FIXED_ISO},
            ExpressionAttributeNames=dict(PROJECT_WRITABLE_ATTRIBUTE_NAMES),
        )

    @pytest.mark.usefixtures('frozen_clock')
    def test_every_writable_field_has_its_own_set_clause(self, table):
        projects.update_project('proj_1', {
            'name': 'N', 'description': 'D', 'purpose': ' P ', 'status': 'archived',
            'filters': {'days': 3}, 'kiro_export_prompt': 'K', 'owner_sub': 'ignored',
        })
        params = table.update_item.call_args.kwargs
        assert params['UpdateExpression'] == (
            'SET updated_at = :now, #name = :name, description = :desc, purpose = :purpose, '
            '#status = :status, filters = :filters'
        )
        assert params['ExpressionAttributeValues'] == {
            **PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':now': FIXED_ISO, ':name': 'N', ':desc': 'D',
            ':purpose': 'P', ':status': 'archived', ':filters': {'days': 3},
        }
        assert params['ExpressionAttributeNames'] == {**PROJECT_WRITABLE_ATTRIBUTE_NAMES, '#name': 'name'}

    @pytest.mark.parametrize(('body', 'clause', 'values'), [
        ({'name': 'N'}, ', #name = :name', {':name': 'N'}),
        ({'description': 'D'}, ', description = :desc', {':desc': 'D'}),
        ({'purpose': 'P'}, ', purpose = :purpose', {':purpose': 'P'}),
        ({'status': 'active'}, ', #status = :status', {':status': 'active'}),
        ({'filters': {}}, ', filters = :filters', {':filters': {}}),
    ])
    @pytest.mark.usefixtures('frozen_clock')
    def test_each_field_alone_adds_only_its_clause(self, table, body, clause, values):
        projects.update_project('proj_1', body)
        params = table.update_item.call_args.kwargs
        assert params['UpdateExpression'] == 'SET updated_at = :now' + clause
        assert params['ExpressionAttributeValues'] == {
            **PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':now': FIXED_ISO, **values,
        }

    @pytest.mark.parametrize('name', ['', '   ', None, 7, ['x']])
    def test_a_blank_or_non_string_name_is_refused_before_the_write(self, table, name):
        with pytest.raises(ValidationError, match=r'^Project name must be a non-empty string$'):
            projects.update_project('proj_1', {'name': name})
        table.update_item.assert_not_called()

    @pytest.mark.usefixtures('frozen_clock')
    def test_the_name_is_stored_trimmed(self, table):
        projects.update_project('proj_1', {'name': '  Renamed  '})
        assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':name'] == 'Renamed'

    @pytest.mark.parametrize('description', [None, 3, {'text': 'x'}])
    def test_a_non_string_description_is_refused_before_the_write(self, table, description):
        with pytest.raises(ValidationError, match=r'^Project description must be a string$'):
            projects.update_project('proj_1', {'description': description})
        table.update_item.assert_not_called()

    def test_an_empty_description_clears_it(self, table):
        projects.update_project('proj_1', {'description': ''})
        assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':desc'] == ''

    def test_an_over_long_purpose_is_refused_before_the_write(self, table):
        with pytest.raises(ValidationError, match=r'^purpose must be at most 2000 characters$'):
            projects.update_project('proj_1', {'purpose': 'p' * 2001})
        table.update_item.assert_not_called()


# ---------------------------------------------------------------------------
# Deletion fence
# ---------------------------------------------------------------------------


class TestConditionalWrite:
    def test_a_landed_write_is_true(self):
        write = MagicMock(return_value='ignored')
        assert projects._conditional_write(write) is True
        write.assert_called_once_with()

    def test_a_failed_condition_is_false(self):
        assert projects._conditional_write(MagicMock(side_effect=_client_error('ConditionalCheckFailedException'))) is False

    @pytest.mark.parametrize('error', [
        _client_error('ProvisionedThroughputExceededException'),
        ClientError({}, 'UpdateItem'),
        ClientError({'Error': {}}, 'UpdateItem'),
    ])
    def test_any_other_client_error_propagates(self, error):
        with pytest.raises(ClientError):
            projects._conditional_write(MagicMock(side_effect=error))


class TestStartProjectDeletion:
    META_KEY: ClassVar[dict[str, str]] = {'pk': 'PROJECT#proj_1', 'sk': 'META'}

    def test_an_existing_meta_is_marked_with_the_exact_update(self, table):
        projects._start_project_deletion('proj_1', self.META_KEY, 'NOW')
        table.update_item.assert_called_once_with(
            Key=self.META_KEY,
            UpdateExpression=(
                'SET #deleting = if_not_exists(#deleting, :now), #status = :deleting_status '
                'REMOVE gsi1pk, gsi1sk'
            ),
            ConditionExpression='attribute_exists(pk) AND attribute_exists(sk)',
            ExpressionAttributeNames={'#deleting': 'deletion_started_at', '#status': 'status'},
            ExpressionAttributeValues={':now': 'NOW', ':deleting_status': 'deleting'},
        )
        table.put_item.assert_not_called()

    def test_a_vanished_meta_gets_a_marker_row(self, table):
        table.update_item.side_effect = _client_error('ConditionalCheckFailedException')
        projects._start_project_deletion('proj_1', self.META_KEY, 'NOW')
        table.put_item.assert_called_once_with(
            Item={'pk': 'PROJECT#proj_1', 'sk': 'META', 'project_id': 'proj_1', 'status': 'deleting',
                  'deletion_started_at': 'NOW'},
            ConditionExpression='attribute_not_exists(pk) AND attribute_not_exists(sk)',
        )

    def test_the_pair_is_tried_exactly_four_times_before_a_named_500(self, table):
        table.update_item.side_effect = _client_error('ConditionalCheckFailedException')
        table.put_item.side_effect = _client_error('ConditionalCheckFailedException')
        with pytest.raises(ServiceError, match=r'^Could not establish the project deletion fence\. Please retry\.$'):
            projects._start_project_deletion('proj_1', self.META_KEY, 'NOW')
        assert table.update_item.call_count == 4
        assert table.put_item.call_count == 4

    def test_the_fourth_attempt_can_still_succeed(self, table):
        table.update_item.side_effect = [_client_error('ConditionalCheckFailedException')] * 4
        table.put_item.side_effect = [_client_error('ConditionalCheckFailedException')] * 3 + [{}]
        projects._start_project_deletion('proj_1', self.META_KEY, 'NOW')
        assert table.put_item.call_count == 4

    def test_a_non_conditional_error_propagates_at_once(self, table):
        table.update_item.side_effect = _client_error('InternalServerError')
        with pytest.raises(ClientError):
            projects._start_project_deletion('proj_1', self.META_KEY, 'NOW')
        table.update_item.assert_called_once()
        table.put_item.assert_not_called()


# ---------------------------------------------------------------------------
# S3 and job-row sweeps
# ---------------------------------------------------------------------------


class TestProjectPrefixes:
    def test_each_prefix_ends_with_a_slash_after_the_project_id(self):
        assert projects.prototype_project_prefix('proj_1') == 'prototypes/proj_1/'
        assert projects.product_docs_project_prefix('proj_1') == 'projects/proj_1/product_docs/'


class TestDeleteProjectJobRows:
    def test_without_a_jobs_table_the_warning_names_the_variable_and_the_project(self, log):
        with patch.object(projects, 'get_jobs_table', return_value=None):
            projects._delete_project_job_rows('proj_1')
        log.warning.assert_called_once_with(
            'JOBS_TABLE is not configured; project job rows were not deleted',
            extra={'project_id': 'proj_1'},
        )

    def test_every_well_formed_row_on_every_page_is_deleted(self):
        jobs = MagicMock()
        batch = MagicMock()
        jobs.batch_writer.return_value.__enter__ = MagicMock(return_value=batch)
        jobs.batch_writer.return_value.__exit__ = MagicMock(return_value=False)
        jobs.query.side_effect = [
            {'Items': [{'pk': 'PROJECT#proj_1', 'sk': 'JOB#1'}, {'pk': 'PROJECT#proj_1'}, {'pk': 1, 'sk': 'JOB#x'}],
             'LastEvaluatedKey': {'pk': 'PROJECT#proj_1', 'sk': 'JOB#1'}},
            {'Items': None, 'LastEvaluatedKey': {'pk': 'PROJECT#proj_1', 'sk': 'JOB#2'}},
            {'Items': [{'pk': 'PROJECT#proj_1', 'sk': 'JOB#3'}]},
        ]
        with patch.object(projects, 'get_jobs_table', return_value=jobs):
            projects._delete_project_job_rows('proj_1')
        base = {
            'KeyConditionExpression': Key('pk').eq('PROJECT#proj_1'), 'ConsistentRead': True,
            'ProjectionExpression': 'pk, sk',
        }
        assert jobs.query.call_args_list == [
            call(**base),
            call(**base, ExclusiveStartKey={'pk': 'PROJECT#proj_1', 'sk': 'JOB#1'}),
            call(**base, ExclusiveStartKey={'pk': 'PROJECT#proj_1', 'sk': 'JOB#2'}),
        ]
        assert batch.delete_item.call_args_list == [
            call(Key={'pk': 'PROJECT#proj_1', 'sk': 'JOB#1'}),
            call(Key={'pk': 'PROJECT#proj_1', 'sk': 'JOB#3'}),
        ]


class TestReportFailedDeletes:
    def test_a_partial_failure_is_a_warning_with_the_count(self, log):
        projects._report_failed_deletes({'Errors': [{'Key': 'a'}, {'Key': 'b'}]}, 'proj_1', 'persona avatars')
        log.warning.assert_called_once_with(
            'Some persona avatars could not be deleted; retry the delete',
            extra={'project_id': 'proj_1', 'failed_object_count': 2},
        )

    @pytest.mark.parametrize('response', [None, 'odd', {}, {'Errors': []}, {'Deleted': [{'Key': 'a'}]}])
    def test_a_clean_or_malformed_response_logs_nothing(self, log, response):
        projects._report_failed_deletes(response, 'proj_1', 'x')
        log.warning.assert_not_called()


class TestDeleteObjectsUnderPrefix:
    def test_each_page_with_keys_is_one_quiet_delete_and_its_failures_are_reported(self):
        client = MagicMock()
        client.get_paginator.return_value.paginate.return_value = [
            {'Contents': [{'Key': 'prototypes/proj_1/a.html'}, {'Size': 1}, {'Key': ''}]},
            {'Contents': []},
            {},
            {'Contents': [{'Key': 'prototypes/proj_1/b.html'}]},
        ]
        client.delete_objects.side_effect = [{'Errors': [{'Key': 'prototypes/proj_1/a.html'}]}, {}]
        with patch.object(projects, 'get_s3_client', return_value=client), \
                patch.object(projects, '_report_failed_deletes') as report:
            projects._delete_objects_under_prefix('proj_1', 'the-bucket', 'prototypes/proj_1/')
        client.get_paginator.assert_called_once_with('list_objects_v2')
        client.get_paginator.return_value.paginate.assert_called_once_with(
            Bucket='the-bucket', Prefix='prototypes/proj_1/',
        )
        assert client.delete_objects.call_args_list == [
            call(Bucket='the-bucket', Delete={'Objects': [{'Key': 'prototypes/proj_1/a.html'}], 'Quiet': True}),
            call(Bucket='the-bucket', Delete={'Objects': [{'Key': 'prototypes/proj_1/b.html'}], 'Quiet': True}),
        ]
        assert report.call_args_list == [
            call({'Errors': [{'Key': 'prototypes/proj_1/a.html'}]}, 'proj_1', 'objects under prototypes/proj_1/'),
            call({}, 'proj_1', 'objects under prototypes/proj_1/'),
        ]


class TestOwnedAvatarKeys:
    def test_only_keys_stamped_with_this_project_are_owned_and_foreign_ones_are_counted(self, log):
        owners = {
            'avatars/p1.png': 'proj_1', 'avatars/p1.jpeg': 'other', 'avatars/p1.jpg': None,
            'avatars/p1.webp': 'proj_1', 'avatars/p2.png': 'other', 'avatars/p2.jpeg': None,
            'avatars/p2.jpg': None, 'avatars/p2.webp': None,
        }
        client = MagicMock()
        with patch.object(projects, 'avatar_object_owner', side_effect=lambda _c, _b, key: owners[key]) as owner:
            owned = projects._owned_avatar_keys(client, 'the-bucket', 'proj_1', ['p1', 'p2'])
        assert owned == ['avatars/p1.png', 'avatars/p1.webp']
        assert owner.call_args_list == [call(client, 'the-bucket', key) for key in owners]
        log.warning.assert_called_once_with(
            'Some avatar objects are owned by another project and were kept',
            extra={'project_id': 'proj_1', 'foreign_object_count': 2},
        )

    def test_unknown_owners_are_neither_owned_nor_foreign(self, log):
        with patch.object(projects, 'avatar_object_owner', return_value=None):
            assert projects._owned_avatar_keys(MagicMock(), 'b', 'proj_1', ['p1']) == []
        log.warning.assert_not_called()


class TestDeleteProjectAvatarObjects:
    def test_no_personas_means_no_client_at_all(self):
        with patch.object(projects, 'get_s3_client') as client:
            projects._delete_project_avatar_objects('proj_1', 'b', [])
        client.assert_not_called()

    def test_a_thousand_keys_are_one_batch_and_the_next_opens_another(self):
        keys = [f'avatars/p{i}.png' for i in range(1001)]
        client = MagicMock()
        client.delete_objects.side_effect = [{'Errors': [{'Key': keys[0]}]}, {}]
        with patch.object(projects, 'get_s3_client', return_value=client), \
                patch.object(projects, '_owned_avatar_keys', return_value=keys) as owned, \
                patch.object(projects, '_report_failed_deletes') as report:
            projects._delete_project_avatar_objects('proj_1', 'the-bucket', ['p1'])
        owned.assert_called_once_with(client, 'the-bucket', 'proj_1', ['p1'])
        assert client.delete_objects.call_args_list == [
            call(Bucket='the-bucket', Delete={'Objects': [{'Key': key} for key in keys[:1000]], 'Quiet': True}),
            call(Bucket='the-bucket', Delete={'Objects': [{'Key': keys[1000]}], 'Quiet': True}),
        ]
        assert report.call_args_list == [
            call({'Errors': [{'Key': keys[0]}]}, 'proj_1', 'persona avatars'),
            call({}, 'proj_1', 'persona avatars'),
        ]

    def test_nothing_owned_means_no_delete_call(self):
        client = MagicMock()
        with patch.object(projects, 'get_s3_client', return_value=client), \
                patch.object(projects, '_owned_avatar_keys', return_value=[]):
            projects._delete_project_avatar_objects('proj_1', 'b', ['p1'])
        client.delete_objects.assert_not_called()


class TestPersonaIdFromSortKey:
    def test_an_exact_persona_key_yields_its_id(self):
        assert projects._persona_id_from_sort_key('PERSONA#abc') == 'abc'

    @pytest.mark.parametrize('sk', ['META', 'PERSONA#', 'PERSONA#a#notes', 'persona#a', 'PRD#PERSONA#a'])
    def test_anything_else_is_none(self, sk):
        assert projects._persona_id_from_sort_key(sk) is None
