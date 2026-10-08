"""Mutation hardening for `shared/agents_store.py`, lines 1-580 (constants, ids, cursors, cron, validation).

`test_agents_store.py` proves that invalid agent bodies are refused and that the run lock holds, but a
mutation run over the first 580 lines found what it cannot see:

* the WORDING of every refusal. `POST/PUT /agents` returns `str(exc)` as the 400 body, so each label and
  each bound in a message is what an admin reads; every message is pinned as a literal here.
* the ACCEPTED side of each bound (`>` vs `>=`): an 80-character name, exactly 5 triggers, exactly
  6 fixed personas, 50 scope entries, a 120-character cron and cron values at each field's edge.
* the defaults a body may omit (trigger counts, cooldowns, windows, the private visibility, UTC).
* the stored vocabulary (gsi partitions, statuses, trigger kinds, event kinds): values persisted in
  `voc-agents` and read by the API, the heartbeat and the run interpreter.
* the plumbing nothing exercised directly: Decimal folding, cursor bytes, the cached table resource,
  index pagination, and the failure wrapping a DynamoDB error goes through.
"""
import re
from collections.abc import Mapping
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from types import MappingProxyType
from typing import Any, Final
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError, EndpointConnectionError

from shared import agents_store as store
from shared.category_access import CategoryScope
from shared.exceptions import ServiceError, ValidationError
from shared.model_config import ALLOWED_MODEL_IDS
from shared.test.agents_fixtures import CATEGORIES

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)  # a Sunday
SHIPPING_ONLY = CategoryScope(all=False, categories=frozenset({'shipping'}))
A_MODEL_ID = sorted(ALLOWED_MODEL_IDS)[0]


def _refused(body: dict[str, Any], message: str, base: dict[str, Any] | None = None) -> None:
    with pytest.raises(ValidationError, match=f'^{re.escape(message)}$'):
        store.normalize_agent(body, CATEGORIES, base=base)


def _agent(**overrides: Any) -> dict[str, Any]:
    return store.normalize_agent({'name': 'n', **overrides}, CATEGORIES)


def _trigger(trigger: dict[str, Any]) -> dict[str, Any]:
    return _agent(triggers=[trigger])['triggers'][0]


def _cron_refused(expression: object, message: str) -> None:
    with pytest.raises(ValueError, match=f'^{re.escape(message)}$'):
        store.parse_cron(expression)


class TestTheStoredVocabulary:
    @pytest.mark.parametrize(('value', 'literal'), [
        (store.AGENTS_TABLE_ENV, 'AGENTS_TABLE'),
        (store.STATE_MACHINE_ENV, 'AGENT_RUN_STATE_MACHINE_ARN'),
        (store.AGENTS_GSI_PK, 'AGENTS'),
        (store.WORKFLOWS_GSI_PK, 'WORKFLOWS'),
        (store.RUNS_ACTIVE_GSI_PK, 'RUNS_ACTIVE'),
        (store.META_SK, 'META'),
        (store.CURRENT_SK, 'CURRENT'),
        (store.AGENT_STATUS_ACTIVE, 'active'),
        (store.AGENT_STATUS_ARCHIVED, 'archived'),
        (store.WORKFLOW_STATUS_ARCHIVED, 'archived'),
        (store.RUN_QUEUED, 'queued'),
        (store.RUN_RUNNING, 'running'),
        (store.RUN_NEEDS_HUMAN, 'needs_human'),
        (store.RUN_COMPLETED, 'completed'),
        (store.RUN_FAILED, 'failed'),
        (store.RUN_CANCELLED, 'cancelled'),
        (store.ACTIVE_RUN_STATUSES, ('queued', 'running')),
        (store.TERMINAL_RUN_STATUSES, ('needs_human', 'completed', 'failed', 'cancelled')),
        (store.TRIGGER_MANUAL, 'manual'),
        (store.TRIGGER_SCHEDULE, 'schedule'),
        (store.TRIGGER_NEW_REVIEWS, 'new_reviews'),
        (store.TRIGGER_THRESHOLD, 'threshold'),
        (store.EVENT_KINDS, ('node_started', 'node_finished', 'node_failed', 'message', 'verdict', 'decision',
                             'artifact')),
        (store.EVENT_REF_KEYS, ('project_id', 'document_id', 'persona_id', 'job_id')),
        (store.EVENT_ROLES, ('orchestrator', 'worker', 'reviewer', 'persona', 'system')),
        (store.MAX_EVENT_SUMMARY_CHARS, 2000),
        (store.AGENTS_INDEX, 'gsi1-by-agents-listing'),
    ])
    def test_each_value_is_the_one_stored_and_read_back(self, value: object, literal: object) -> None:
        assert value == literal


class TestIdsAndKeys:
    def test_agent_and_workflow_ids_are_a_prefix_and_twelve_hex_digits(self) -> None:
        agent_id, workflow_id = store.new_agent_id(), store.new_workflow_id()
        assert re.fullmatch(r'ag_[0-9a-f]{12}', agent_id)
        assert re.fullmatch(r'wf_[0-9a-f]{12}', workflow_id)
        assert store.is_agent_id(agent_id)
        assert store.is_workflow_id(workflow_id)

    def test_a_run_id_starts_with_the_start_time_in_milliseconds(self) -> None:
        run_id = store.new_run_id(NOW)
        assert run_id.startswith('ar_01a106c90600')
        assert re.fullmatch(r'ar_01a106c90600[0-9a-f]{8}', run_id)

    def test_a_run_id_without_a_time_uses_the_clock(self) -> None:
        with patch.object(store, 'utc_now', return_value=NOW + timedelta(milliseconds=1)):
            assert store.new_run_id().startswith('ar_01a106c90601')

    @pytest.mark.parametrize(('value', 'expected'), [
        ('ag_0123456789ab', True), ('ag_0123456789a', False), ('ag_0123456789abc', False),
        ('ag_0123456789AB', False), ('wf_0123456789ab', False), (5, False), (None, False),
    ])
    def test_is_agent_id(self, value: object, expected: bool) -> None:
        assert store.is_agent_id(value) is expected

    @pytest.mark.parametrize(('value', 'expected'), [
        ('wf_default', True), ('wf_0123456789ab', True), ('wf_0123456789a', False),
        ('ag_0123456789ab', False), ('wf_defaults', False), (5, False), (None, False),
    ])
    def test_is_workflow_id(self, value: object, expected: bool) -> None:
        assert store.is_workflow_id(value) is expected

    @pytest.mark.parametrize(('value', 'expected'), [
        ('ar_' + 'a' * 12, True), ('ar_' + 'a' * 20, True), ('ar_' + 'a' * 11, False),
        ('ar_' + 'a' * 21, False), ('ag_' + 'a' * 12, False), (5, False),
    ])
    def test_is_run_id(self, value: object, expected: bool) -> None:
        assert store.is_run_id(value) is expected

    def test_row_keys(self) -> None:
        assert store.agent_key('ag_1') == {'pk': 'AGENT#ag_1', 'sk': 'META'}
        assert store.run_key('ag_1', 'ar_2') == {'pk': 'AGENT#ag_1', 'sk': 'RUN#ar_2'}
        assert store.workflow_current_key('wf_3') == {'pk': 'WORKFLOW#wf_3', 'sk': 'CURRENT'}
        assert store.workflow_revision_key('wf_3', 42) == {'pk': 'WORKFLOW#wf_3', 'sk': 'REV#000042'}


class TestClockValues:
    def test_iso_is_utc_to_the_second(self) -> None:
        moment = datetime(2026, 10, 4, 14, 0, 5, 999_999, tzinfo=timezone(timedelta(hours=2)))
        assert store.iso(moment) == '2026-10-04T12:00:05+00:00'

    @pytest.mark.parametrize('value', [None, '', 5, 'yesterday'])
    def test_parse_iso_refuses_what_is_not_a_timestamp(self, value: object) -> None:
        assert store.parse_iso(value) is None

    def test_parse_iso_assumes_utc_for_a_naive_value_and_keeps_an_offset(self) -> None:
        naive = store.parse_iso('2026-10-04T12:00:00')
        assert naive is not None
        assert naive.tzinfo is UTC
        assert naive == NOW
        aware = store.parse_iso('2026-10-04T14:00:00+02:00')
        assert aware is not None
        assert aware.utcoffset() == timedelta(hours=2)
        assert aware == NOW


class TestPlainValues:
    def test_decimals_fold_to_int_or_float_recursively(self) -> None:
        folded = store.plain({'a': Decimal('3'), 'b': [Decimal('2.5'), (Decimal('1'),)], 'c': 'x'})
        assert folded == {'a': 3, 'b': [2.5, [1]], 'c': 'x'}
        assert type(folded['a']) is int
        assert type(folded['b'][0]) is float

    def test_a_set_becomes_a_list(self) -> None:
        assert store.plain({Decimal('4')}) == [4]

    @pytest.mark.parametrize(('item', 'expected'), [
        ({'n': Decimal('4')}, 4), ({'n': 7}, 7), ({'n': True}, 0), ({'n': '4'}, 0),
        ({'n': Decimal('2.5')}, 0), ({}, 0),
    ])
    def test_int_attr(self, item: dict[str, Any], expected: int) -> None:
        assert store._int_attr(item, 'n') == expected


class TestCursorBytes:
    def test_the_cursor_is_sorted_json_in_url_safe_base64(self) -> None:
        cursor = store.encode_cursor({'sk': 'RUN#ar_1', 'pk': 'AGENT#ag_1', 'n': Decimal('3')})
        assert cursor == 'eyJuIjogMywgInBrIjogIkFHRU5UI2FnXzEiLCAic2siOiAiUlVOI2FyXzEifQ=='

    @pytest.mark.parametrize('last_key', [None, {}])
    def test_no_last_key_is_no_cursor(self, last_key: dict | None) -> None:
        assert store.encode_cursor(last_key) is None

    @pytest.mark.parametrize('cursor', [None, ''])
    def test_no_cursor_starts_at_the_beginning(self, cursor: object) -> None:
        assert store.decode_cursor(cursor, 'AGENT#ag_1') is None

    @pytest.mark.parametrize('cursor', [
        'é', '%%%', store.encode_cursor({'x': 1}), 'WzFd',  # 'WzFd' is [1]
        store.encode_cursor({'pk': 'AGENT#ag_2', 'sk': 'RUN#ar_1'}),
        store.encode_cursor({'pk': 'AGENT#ag_1', 'sk': 5}),
        store.encode_cursor({'pk': 'AGENT#ag_1'}),
    ])
    def test_a_foreign_or_broken_cursor_is_refused(self, cursor: str) -> None:
        with pytest.raises(ValidationError, match=r'^cursor is not valid$'):
            store.decode_cursor(cursor, 'AGENT#ag_1')


class TestTheTableResource:
    def test_none_without_the_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv('AGENTS_TABLE', raising=False)
        resource = MagicMock()
        with patch.object(store, 'get_dynamodb_resource', return_value=resource):
            assert store.get_agents_table() is None
        resource.Table.assert_not_called()

    def test_the_named_table_is_built_once_and_cached(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('AGENTS_TABLE', 'mutation-agents')
        store._table_cache.clear()
        resource = MagicMock()
        try:
            with patch.object(store, 'get_dynamodb_resource', return_value=resource):
                first = store.get_agents_table()
                assert store.get_agents_table() is first
            resource.Table.assert_called_once_with('mutation-agents')
            assert first is resource.Table.return_value
        finally:
            store._table_cache.clear()


def _client_error(code: str, reasons: list[Any] | None = None) -> ClientError:
    response: Any = {'Error': {'Code': code, 'Message': 'm'}}
    if reasons is not None:
        response['CancellationReasons'] = reasons
    return ClientError(response, 'TransactWriteItems')


class TestDynamoErrors:
    def test_cancellation_codes_name_every_reason(self) -> None:
        error = _client_error('TransactionCanceledException', [
            {'Code': 'ConditionalCheckFailed'}, None, {}, {'Code': ''}])
        assert store._cancellation_codes(error) == ['ConditionalCheckFailed', 'None', 'None', 'None']
        assert store._cancellation_codes(_client_error('TransactionCanceledException')) == []

    def test_only_a_cancelled_transaction_is_one(self) -> None:
        assert store._is_cancelled_transaction(_client_error('TransactionCanceledException')) is True
        assert store._is_cancelled_transaction(_client_error('ConditionalCheckFailedException')) is False
        assert store._is_cancelled_transaction(ClientError({}, 'GetItem')) is False
        assert store._is_cancelled_transaction(ValueError('TransactionCanceledException')) is False


class TestIndexPagination:
    def test_every_page_of_the_partition_is_read(self) -> None:
        table = MagicMock()
        table.query.side_effect = [
            {'Items': [{'id': 1}], 'LastEvaluatedKey': {'pk': 'a'}},
            {'LastEvaluatedKey': {'pk': 'b'}},
            {'Items': [{'id': 2}, {'id': 3}]},
        ]
        assert store.list_agents(table) == [{'id': 1}, {'id': 2}, {'id': 3}]
        condition = Key('gsi1pk').eq('AGENTS')
        assert [call.kwargs for call in table.query.call_args_list] == [
            {'IndexName': 'gsi1-by-agents-listing', 'KeyConditionExpression': condition},
            {'IndexName': 'gsi1-by-agents-listing', 'KeyConditionExpression': condition,
             'ExclusiveStartKey': {'pk': 'a'}},
            {'IndexName': 'gsi1-by-agents-listing', 'KeyConditionExpression': condition,
             'ExclusiveStartKey': {'pk': 'b'}},
        ]

    @pytest.mark.parametrize('error', [_client_error('ProvisionedThroughputExceededException'),
                                       EndpointConnectionError(endpoint_url='https://dynamodb')])
    def test_a_failed_read_is_a_retryable_service_error(self, error: Exception) -> None:
        table = MagicMock()
        table.query.side_effect = [error]
        logger = MagicMock()
        with patch.object(store, 'logger', logger), \
                pytest.raises(ServiceError, match=r'^Could not list agents\. Please retry\.$'):
            store.list_agents(table)
        logger.exception.assert_called_once_with('Agents store: list agents failed',
                                                 extra={'error_type': type(error).__name__})


class TestCronFields:
    def test_a_star_is_the_whole_range_of_each_field(self) -> None:
        spec = store.parse_cron('* * * * *')
        assert spec.minutes == frozenset(range(60))
        assert spec.hours == frozenset(range(24))
        assert spec.days == frozenset(range(1, 32))
        assert spec.months == frozenset(range(1, 13))
        assert spec.weekdays == frozenset(range(7))
        assert (spec.days_restricted, spec.weekdays_restricted) == (False, False)

    def test_each_field_lands_in_its_own_slot(self) -> None:
        spec = store.parse_cron('1 2 3 4 5')
        assert (spec.minutes, spec.hours, spec.days, spec.months, spec.weekdays) == (
            frozenset({1}), frozenset({2}), frozenset({3}), frozenset({4}), frozenset({5}))
        assert (spec.days_restricted, spec.weekdays_restricted) == (True, True)

    @pytest.mark.parametrize(('expression', 'restricted'), [
        ('* * 1 * *', (True, False)), ('* * * * 1', (False, True)), ('* * * 1 *', (False, False)),
    ])
    def test_which_day_fields_are_restricted(self, expression: str, restricted: tuple[bool, bool]) -> None:
        spec = store.parse_cron(expression)
        assert (spec.days_restricted, spec.weekdays_restricted) == restricted

    @pytest.mark.parametrize(('part', 'minutes'), [
        ('0', {0}), ('59', {59}), ('0-3', {0, 1, 2, 3}), ('5-5', {5}), ('0-59', set(range(60))),
        ('*/1', set(range(60))), ('*/20', {0, 20, 40}), ('5/20', {5, 25, 45}), ('10-30/10', {10, 20, 30}),
        ('0,12,0', {0, 12}),
    ])
    def test_minute_parts(self, part: str, minutes: set[int]) -> None:
        assert store.parse_cron(f'{part} * * * *').minutes == frozenset(minutes)

    @pytest.mark.parametrize(('weekday', 'folded'), [('7', {0}), ('0', {0}), ('6', {6}), ('5-7', {5, 6, 0})])
    def test_sunday_may_be_written_7(self, weekday: str, folded: set[int]) -> None:
        assert store.parse_cron(f'* * * * {weekday}').weekdays == frozenset(folded)

    def test_edges_of_every_field_parse(self) -> None:
        spec = store.parse_cron('0,59 0,23 1,31 1,12 0,7')
        assert (spec.minutes, spec.hours, spec.days, spec.months, spec.weekdays) == (
            frozenset({0, 59}), frozenset({0, 23}), frozenset({1, 31}), frozenset({1, 12}), frozenset({0}))

    def test_a_120_character_expression_is_accepted(self) -> None:
        expression = '0,' * 55 + '00 * * * *'
        assert len(expression) == 120
        assert store.parse_cron(expression).minutes == frozenset({0})
        _cron_refused('0' + expression, 'cron must be a string of at most 120 characters')

    @pytest.mark.parametrize(('expression', 'message'), [
        (None, 'cron must be a string of at most 120 characters'),
        ('* * * * * *', 'cron needs 5 fields: minute hour day-of-month month day-of-week'),
        ('60 * * * *', 'cron minute must be within 0-59'),
        ('* 24 * * *', 'cron hour must be within 0-23'),
        ('* * 0 * *', 'cron day of month must be within 1-31'),
        ('* * 32 * *', 'cron day of month must be within 1-31'),
        ('* * * 0 *', 'cron month must be within 1-12'),
        ('* * * 13 *', 'cron month must be within 1-12'),
        ('* * * * 8', 'cron day of week must be within 0-7'),
        ('3-2 * * * *', 'cron minute must be within 0-59'),
        ('50-60 * * * *', 'cron minute must be within 0-59'),
        ('a * * * *', 'cron minute: use numbers, ranges (a-b), lists (a,b), steps (*/n)'),
        ('1-a * * * *', 'cron minute: use numbers, ranges (a-b), lists (a,b), steps (*/n)'),
        ('*/x * * * *', 'cron minute: step must be a positive number'),
        ('*/0 * * * *', 'cron minute: step must be a positive number'),
    ])
    def test_every_refusal_names_its_field(self, expression: object, message: str) -> None:
        _cron_refused(expression, message)


class TestCronMatching:
    def test_a_parsed_spec_is_immutable_and_hashable(self) -> None:
        spec, field = store.parse_cron('0 0 * * *'), 'minutes'
        with pytest.raises(FrozenInstanceError):
            setattr(spec, field, frozenset({1}))
        assert hash(spec) == hash(store.parse_cron('0 0 * * *'))

    def test_each_of_minute_hour_and_month_must_match(self) -> None:
        spec = store.parse_cron('30 9 * 10 *')
        assert spec.matches(datetime(2026, 10, 7, 9, 30))
        assert not spec.matches(datetime(2026, 10, 7, 9, 31))
        assert not spec.matches(datetime(2026, 10, 7, 10, 30))
        assert not spec.matches(datetime(2026, 11, 7, 9, 30))

    def test_a_sunday_only_schedule_matches_sunday(self) -> None:
        spec = store.parse_cron('0 12 * * 0')
        assert spec.matches(NOW)
        assert not spec.matches(NOW + timedelta(days=1))

    def test_a_day_of_month_alone_needs_that_day(self) -> None:
        spec = store.parse_cron('0 0 1 * *')
        assert spec.matches(datetime(2026, 10, 1, 0, 0))
        assert not spec.matches(datetime(2026, 10, 2, 0, 0))

    def test_a_weekday_alone_needs_that_weekday(self) -> None:
        spec = store.parse_cron('0 0 * * 1')
        assert spec.matches(datetime(2026, 10, 5, 0, 0))
        assert not spec.matches(datetime(2026, 10, 6, 0, 0))

    def test_with_both_restricted_neither_matching_is_no_match(self) -> None:
        spec = store.parse_cron('0 0 1 * 1')
        assert not spec.matches(datetime(2026, 10, 6, 0, 0))


class TestResolveTimezone:
    @pytest.mark.parametrize('name', [None, '', 'UTC', 5])
    def test_utc_without_a_lookup_or_a_warning(self, name: object) -> None:
        logger = MagicMock()
        with patch.object(store, 'logger', logger):
            assert store.resolve_timezone(name) is UTC
        logger.warning.assert_not_called()

    def test_a_known_zone(self) -> None:
        assert store.resolve_timezone('Europe/Paris') == ZoneInfo('Europe/Paris')

    def test_an_unknown_zone_is_utc_and_logged(self) -> None:
        logger = MagicMock()
        with patch.object(store, 'logger', logger):
            assert store.resolve_timezone('Mars/Olympus') is UTC
        logger.warning.assert_called_once_with('Agent schedule timezone not found; using UTC')


class TestTheAgentBody:
    def test_every_editable_field_is_accepted_and_normalized(self) -> None:
        fields = store.normalize_agent({
            'name': ' Crew ', 'description': ' d ', 'enabled': True, 'owner_sub': ' sub-1 ',
            'scope': {'all': False, 'categories': ['shipping']}, 'instructions': ' be brief ',
            'personas': {'fixed': [{'project_id': 'p1', 'persona_id': 'q1'}], 'allow_generate': False},
            'triggers': [{'kind': 'new_reviews'}], 'models': {'worker': A_MODEL_ID},
            'output': {'visibility': 'public'}, 'workflow_id': 'wf_default',
            'budget': {'max_scheduled_runs_per_day': 0, 'max_model_calls_per_run': 10, 'monthly_call_cap': 0},
        }, CATEGORIES)
        assert fields == {
            'name': 'Crew', 'description': 'd', 'enabled': True, 'owner_sub': 'sub-1',
            'scope': {'all': False, 'categories': ['shipping'], 'subcategories': []},
            'instructions': 'be brief',
            'personas': {'fixed': [{'project_id': 'p1', 'persona_id': 'q1'}], 'allow_generate': False},
            'triggers': [{'kind': 'new_reviews', 'min_new': 1, 'cooldown_hours': 12}],
            'models': {'orchestrator': None, 'worker': A_MODEL_ID, 'reviewer': None, 'persona': None},
            'output': {'visibility': 'public'}, 'workflow_id': 'wf_default',
            'budget': {'max_scheduled_runs_per_day': 0, 'max_model_calls_per_run': 10, 'monthly_call_cap': 0},
        }

    def test_omitted_fields_take_their_defaults(self) -> None:
        fields = _agent()
        assert fields == {
            'name': 'n', 'description': '', 'enabled': False, 'owner_sub': None,
            'scope': {'all': True, 'categories': [], 'subcategories': []}, 'instructions': '',
            'personas': {'fixed': [], 'allow_generate': True}, 'triggers': [],
            'models': {'orchestrator': None, 'worker': None, 'reviewer': None, 'persona': None},
            'output': {'visibility': 'private'}, 'workflow_id': None,
            'budget': {'max_scheduled_runs_per_day': 2, 'max_model_calls_per_run': 150, 'monthly_call_cap': 5000},
        }

    def test_unknown_fields_are_named_in_order(self) -> None:
        _refused({'name': 'n', 'zeta': 1, 'alpha': 2}, 'unknown agent fields: alpha, zeta')

    def test_an_update_keeps_editable_base_fields_folds_decimals_and_ignores_the_rest(self) -> None:
        base = {**_agent(instructions='Be brief'), 'status': 'archived', 'runs_total': Decimal('4'),
                'budget': {'max_model_calls_per_run': Decimal('20')}}
        merged = store.normalize_agent({'description': 'new'}, CATEGORIES, base=base)
        assert merged['instructions'] == 'Be brief'
        assert merged['description'] == 'new'
        assert merged['budget']['max_model_calls_per_run'] == 20
        assert 'status' not in merged

    def test_a_body_value_wins_over_the_base(self) -> None:
        merged = store.normalize_agent({'name': 'new'}, CATEGORIES, base=_agent(name='old'))
        assert merged['name'] == 'new'

    @pytest.mark.parametrize(('length', 'field', 'limit'), [
        (80, 'name', 80), (2000, 'description', 2000), (8000, 'instructions', 8000), (254, 'owner_sub', 254),
    ])
    def test_text_at_its_limit_is_kept_and_one_more_is_refused(self, length: int, field: str, limit: int) -> None:
        assert _agent(**{field: 'x' * length})[field] == 'x' * length
        _refused({'name': 'n', field: 'x' * (length + 1)}, f'{field} must be at most {limit} characters')

    @pytest.mark.parametrize(('body', 'message'), [
        ({}, 'name is required'),
        ({'name': '   '}, 'name is required'),
        ({'name': 5}, 'name must be a string'),
        ({'name': 'n', 'description': 5}, 'description must be a string'),
        ({'name': 'n', 'owner_sub': ''}, 'owner_sub is required'),
        ({'name': 'n', 'enabled': 'yes'}, 'enabled must be true or false'),
        ({'name': 'n', 'workflow_id': 'nope'}, 'workflow_id is not a workflow id'),
        ({'name': 'n', 'output': 'public'}, 'output must be an object'),
        ({'name': 'n', 'output': {'visibility': 'team'}}, 'output.visibility must be one of: private, public'),
        ({'name': 'n', 'models': 'sonnet'}, 'models must be an object'),
        ({'name': 'n', 'models': {'janitor': None}},
         'models keys must be among: orchestrator, worker, reviewer, persona'),
        ({'name': 'n', 'models': {'reviewer': 'gpt-9'}}, 'models.reviewer must be an allowed model id or null'),
        ({'name': 'n', 'budget': 3}, 'budget must be an object'),
        ({'name': 'n', 'budget': {'max_scheduled_runs_per_day': 3}},
         'max_scheduled_runs_per_day must be a whole number from 0 to 2'),
        ({'name': 'n', 'budget': {'max_scheduled_runs_per_day': -1}},
         'max_scheduled_runs_per_day must be a whole number from 0 to 2'),
        ({'name': 'n', 'budget': {'max_model_calls_per_run': 9}},
         'max_model_calls_per_run must be a whole number from 10 to 500'),
        ({'name': 'n', 'budget': {'max_model_calls_per_run': 501}},
         'max_model_calls_per_run must be a whole number from 10 to 500'),
        ({'name': 'n', 'budget': {'max_model_calls_per_run': True}},
         'max_model_calls_per_run must be a whole number from 10 to 500'),
        ({'name': 'n', 'budget': {'max_model_calls_per_run': '20'}},
         'max_model_calls_per_run must be a whole number from 10 to 500'),
        ({'name': 'n', 'budget': {'monthly_call_cap': 1_000_001}},
         'monthly_call_cap must be a whole number from 0 to 1000000'),
        ({'name': 'n', 'budget': {'monthly_call_cap': -1}},
         'monthly_call_cap must be a whole number from 0 to 1000000'),
    ])
    def test_every_refusal_names_its_cause(self, body: dict[str, Any], message: str) -> None:
        _refused(body, message)

    def test_budget_upper_edges_are_accepted(self) -> None:
        budget = _agent(budget={'max_scheduled_runs_per_day': 2, 'max_model_calls_per_run': 500,
                                'monthly_call_cap': 1_000_000})['budget']
        assert budget == {'max_scheduled_runs_per_day': 2, 'max_model_calls_per_run': 500,
                          'monthly_call_cap': 1_000_000}

    def test_an_explicit_null_cap_is_uncapped(self) -> None:
        assert _agent(budget={'monthly_call_cap': None})['budget']['monthly_call_cap'] is None

    def test_a_null_model_and_a_custom_workflow_are_kept(self) -> None:
        fields = _agent(models={'persona': None, 'orchestrator': A_MODEL_ID}, workflow_id='wf_0123456789ab')
        assert fields['models']['orchestrator'] == A_MODEL_ID
        assert fields['models']['persona'] is None
        assert fields['workflow_id'] == 'wf_0123456789ab'


class TestTheScope:
    @pytest.mark.parametrize('scope', [None, {}, {'all': True}, {'all': True, 'categories': ['shipping']}])
    def test_all(self, scope: object) -> None:
        assert _agent(scope=scope)['scope'] == {'all': True, 'categories': [], 'subcategories': []}

    def test_categories_alone_mean_not_all_and_repeat_once(self) -> None:
        assert _agent(scope={'categories': ['shipping', 'billing', 'shipping']})['scope'] == {
            'all': False, 'categories': ['shipping', 'billing'], 'subcategories': []}

    def test_subcategories_alone_and_a_category_that_lists_none(self) -> None:
        scope = _agent(scope={'all': False, 'subcategories': [
            {'category': 'shipping', 'name': 'late'}, {'category': 'billing', 'name': 'refunds'},
            {'category': 'shipping', 'name': 'late'}]})['scope']
        assert scope == {'all': False, 'categories': [], 'subcategories': [
            {'category': 'shipping', 'name': 'late'}, {'category': 'billing', 'name': 'refunds'}]}

    def test_a_category_config_entry_without_a_name_is_ignored(self) -> None:
        fields = store.normalize_agent({'name': 'n', 'scope': {'categories': ['billing']}},
                                       [{'description': 'nameless'}, *CATEGORIES])
        assert fields['scope']['categories'] == ['billing']

    def test_fifty_entries_each_are_accepted(self) -> None:
        scope = _agent(scope={'categories': ['shipping'] * 50,
                              'subcategories': [{'category': 'shipping', 'name': 'late'}] * 50})['scope']
        assert scope['categories'] == ['shipping']
        assert scope['subcategories'] == [{'category': 'shipping', 'name': 'late'}]

    @pytest.mark.parametrize(('scope', 'message'), [
        ('all', 'scope must be an object'),
        ({'all': 'yes'}, 'scope.all must be true or false'),
        ({'categories': 'shipping'}, 'scope.categories and scope.subcategories must be lists'),
        ({'subcategories': {'category': 'shipping'}}, 'scope.categories and scope.subcategories must be lists'),
        ({'categories': ['shipping'] * 51}, 'scope lists at most 50 entries each'),
        ({'subcategories': [{'category': 'shipping', 'name': 'late'}] * 51}, 'scope lists at most 50 entries each'),
        ({'categories': ['returns']}, 'scope.categories must name configured categories'),
        ({'categories': [5]}, 'scope.categories must name configured categories'),
        ({'subcategories': ['late']}, 'scope.subcategories entry must be an object'),
        ({'subcategories': [{'category': 5, 'name': 'late'}]},
         'each scope subcategory needs a configured category and a name'),
        ({'subcategories': [{'category': 'returns', 'name': 'late'}]},
         'each scope subcategory needs a configured category and a name'),
        ({'subcategories': [{'category': 'shipping', 'name': 5}]},
         'each scope subcategory needs a configured category and a name'),
        ({'subcategories': [{'category': 'shipping', 'name': 'lost'}]},
         'a scope subcategory must belong to its category'),
        ({'all': False}, 'scope needs all: true, or at least one category or subcategory'),
        ({'categories': [], 'subcategories': []}, 'scope needs all: true, or at least one category or subcategory'),
    ])
    def test_every_refusal_names_its_cause(self, scope: object, message: str) -> None:
        _refused({'name': 'n', 'scope': scope}, message)

    def test_subcategory_names_drops_malformed_entries(self) -> None:
        assert store.subcategory_names({'subcategories': [{'name': 'a'}, 'b', {'name': 5}, {}, {'name': 'c'}]}) \
            == ['a', 'c']
        assert store.subcategory_names({'subcategories': 'abc'}) == []
        assert store.subcategory_names({}) == []


class TestTriggers:
    def test_defaults_per_kind(self) -> None:
        assert _trigger({'kind': 'new_reviews'}) == {'kind': 'new_reviews', 'min_new': 1, 'cooldown_hours': 12}
        assert _trigger({'kind': 'schedule', 'every': '24h'}) == {'kind': 'schedule', 'every': '24h',
                                                                  'timezone': 'UTC'}
        assert _trigger({'kind': 'threshold'}) == {'kind': 'threshold', 'count': 10, 'per': 'category',
                                                   'window_days': 7}

    def test_edges_are_accepted(self) -> None:
        assert _trigger({'kind': 'new_reviews', 'min_new': 10_000, 'cooldown_hours': 0}) == {
            'kind': 'new_reviews', 'min_new': 10_000, 'cooldown_hours': 0}
        assert _trigger({'kind': 'new_reviews', 'cooldown_hours': 168})['cooldown_hours'] == 168
        assert _trigger({'kind': 'threshold', 'count': 1, 'window_days': 1, 'per': 'subcategory'}) == {
            'kind': 'threshold', 'count': 1, 'per': 'subcategory', 'window_days': 1}
        assert _trigger({'kind': 'threshold', 'count': 100_000, 'window_days': 90}) == {
            'kind': 'threshold', 'count': 100_000, 'per': 'category', 'window_days': 90}

    def test_a_cron_schedule_keeps_its_normalized_expression_and_zone(self) -> None:
        assert _trigger({'kind': 'schedule', 'every': 'cron', 'cron': ' 0   9 * * 1-5 ',
                         'timezone': 'Europe/Paris'}) == {
            'kind': 'schedule', 'every': 'cron', 'timezone': 'Europe/Paris', 'cron': '0 9 * * 1-5'}

    def test_a_fixed_interval_ignores_a_cron_field(self) -> None:
        assert _trigger({'kind': 'schedule', 'every': '12h', 'cron': 'garbage'}) == {
            'kind': 'schedule', 'every': '12h', 'timezone': 'UTC'}

    def test_utc_is_never_looked_up(self) -> None:
        zone_info = MagicMock()
        with patch.object(store, 'ZoneInfo', zone_info):
            assert _trigger({'kind': 'schedule', 'every': '24h', 'timezone': 'UTC'})['timezone'] == 'UTC'
        zone_info.assert_not_called()

    def test_five_triggers_are_accepted(self) -> None:
        assert len(_agent(triggers=[{'kind': 'threshold'}] * 5)['triggers']) == 5

    @pytest.mark.parametrize(('triggers', 'message'), [
        ('daily', 'triggers must be a list of at most 5'),
        ([{'kind': 'threshold'}] * 6, 'triggers must be a list of at most 5'),
        (['daily'], 'trigger must be an object'),
        ([{}], 'trigger kind must be one of: new_reviews, schedule, threshold'),
        ([{'kind': 'new_reviews', 'min_new': 0}], 'min_new must be a whole number from 1 to 10000'),
        ([{'kind': 'new_reviews', 'min_new': 10_001}], 'min_new must be a whole number from 1 to 10000'),
        ([{'kind': 'new_reviews', 'cooldown_hours': -1}], 'cooldown_hours must be a whole number from 0 to 168'),
        ([{'kind': 'new_reviews', 'cooldown_hours': 169}], 'cooldown_hours must be a whole number from 0 to 168'),
        ([{'kind': 'schedule'}], 'schedule every must be one of: 12h, 24h, cron'),
        ([{'kind': 'schedule', 'every': '24h', 'timezone': 5}], 'timezone must be a string'),
        ([{'kind': 'schedule', 'every': '24h', 'timezone': 'x' * 65}], 'timezone must be at most 64 characters'),
        ([{'kind': 'schedule', 'every': '24h', 'timezone': 'Mars/Olympus'}],
         'timezone must be an IANA time zone such as Europe/Paris'),
        ([{'kind': 'schedule', 'every': 'cron'}], 'cron must be a string of at most 120 characters'),
        ([{'kind': 'schedule', 'every': 'cron', 'cron': '* 25 * * *'}], 'cron hour must be within 0-23'),
        ([{'kind': 'threshold', 'count': 0}], 'threshold count must be a whole number from 1 to 100000'),
        ([{'kind': 'threshold', 'count': 100_001}], 'threshold count must be a whole number from 1 to 100000'),
        ([{'kind': 'threshold', 'per': 'product'}], 'threshold per must be one of: category, subcategory'),
        ([{'kind': 'threshold', 'window_days': 0}], 'window_days must be a whole number from 1 to 90'),
        ([{'kind': 'threshold', 'window_days': 91}], 'window_days must be a whole number from 1 to 90'),
    ])
    def test_every_refusal_names_its_cause(self, triggers: object, message: str) -> None:
        _refused({'name': 'n', 'triggers': triggers}, message)


class TestPersonas:
    def test_six_fixed_personas_are_accepted(self) -> None:
        fixed = [{'project_id': f'p{i}', 'persona_id': f'q{i}'} for i in range(6)]
        assert _agent(personas={'fixed': fixed})['personas'] == {'fixed': fixed, 'allow_generate': True}

    def test_a_repeated_persona_is_kept_once(self) -> None:
        ref = {'project_id': 'p1', 'persona_id': 'q1'}
        assert _agent(personas={'fixed': [ref, ref]})['personas']['fixed'] == [ref]

    @pytest.mark.parametrize(('personas', 'message'), [
        ('all', 'personas must be an object'),
        ({'fixed': 'p1'}, 'personas.fixed must be a list of at most 6'),
        ({'fixed': [{'project_id': f'p{i}', 'persona_id': 'q'} for i in range(7)]},
         'personas.fixed must be a list of at most 6'),
        ({'fixed': ['p1']}, 'personas.fixed entry must be an object'),
        ({'fixed': [{'persona_id': 'q'}]}, 'project_id is required'),
        ({'fixed': [{'project_id': 'p'}]}, 'persona_id is required'),
        ({'allow_generate': 'no'}, 'personas.allow_generate must be true or false'),
    ])
    def test_every_refusal_names_its_cause(self, personas: object, message: str) -> None:
        _refused({'name': 'n', 'personas': personas}, message)


class TestAgentVisible:
    @pytest.mark.parametrize(('scope', 'visible'), [
        ({'all': False, 'categories': ['shipping', 5]}, True),
        ({'all': False, 'subcategories': [{'category': 'shipping', 'name': 'late'}, 'x']}, True),
        ({'all': False, 'subcategories': [{'category': 'billing', 'name': 'refunds'}]}, False),
        ({'all': False, 'categories': ['shipping'], 'subcategories': [{'category': None}]}, False),
        ({'all': False}, False),
        ({'all': None, 'categories': ['shipping']}, False),
        ('shipping', False),
    ])
    def test_a_restricted_viewer(self, scope: object, visible: bool) -> None:
        assert store.agent_visible(SHIPPING_ONLY, {'scope': scope}) is visible

    def test_an_unrestricted_viewer_sees_even_a_malformed_agent(self) -> None:
        assert store.agent_visible(CategoryScope(all=True, categories=frozenset()), {}) is True


SUBS_ONLY: Final = MappingProxyType({'all': False, 'subcategories': ['x', {'category': 'shipping', 'name': 'late'}]})


class TestItemInScope:
    @pytest.mark.parametrize(('scope', 'item', 'inside'), [
        ({'all': True}, {}, True),
        ({'all': 1, 'categories': []}, {'category': 'billing'}, False),
        ({'all': False, 'categories': ['other']}, {}, True),
        (SUBS_ONLY, {'category': 'shipping', 'subcategory': 'late'}, True),
        (SUBS_ONLY, {'category': 'billing', 'subcategory': 'late'}, False),
        (SUBS_ONLY, {'category': 'shipping', 'subcategory': 'damaged'}, False),
        (SUBS_ONLY, {'category': 'shipping'}, False),
        ({'all': False, 'categories': ['billing']}, {'category': 'shipping', 'subcategory': 'late'}, False),
    ])
    def test_scope_membership(self, scope: Mapping[str, Any], item: dict[str, Any], inside: bool) -> None:
        assert store.item_in_scope(scope, item) is inside
