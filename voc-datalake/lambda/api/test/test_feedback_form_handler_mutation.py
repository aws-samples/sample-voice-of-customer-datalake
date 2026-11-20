"""Mutation hardening for `api/feedback_form_handler.py`.

`test_feedback_form_handler.py` and `test_feedback_form_public_hardening.py`
drive every route end to end and pin the shape of the 400s (`'text' in error`),
the partition a stats read queries and the anchor write's condition. A mutation
run found what they cannot see:

* the WORDING of every refusal. The public routes answer the widget on a
  customer's site and the dashboard reads the 400 body verbatim, so each message
  is pinned as a literal here; a substring check lets ``XXrating must …XX``
  through.
* the ACCEPTED side of each bound (``>`` vs ``>=``): exactly 128 link characters
  and exactly 4096 URL characters save, 129 and 4097 are refused by name.
* the defaults a new form is stored with — every literal of
  ``DEFAULT_FORM_CONFIG`` and the Kiro palette, as the created form reports it.
* what the module reads from the environment at cold start, and what a record
  built by ``build_form_item`` carries (keys, id length, timestamps, brand).
* the anchor's two log lines, and that a conditional-check failure is told
  apart from any other DynamoDB error by its CODE, not its type.
"""
from __future__ import annotations

import importlib
import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from module_reload_fixtures import env_reloader

import feedback_form_handler as h
from shared.category_access import UNRESTRICTED, CategoryScope
from shared.exceptions import ConfigurationError, NotFoundError, ServiceError
from shared.form_theme import default_theme
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped
from shared.test.source_profile_fixtures import no_source_profiles

# Every category, but the restricted `support_tickets` source hidden.
NO_TICKETS = CategoryScope(all=True, source_deny=frozenset({'support_tickets'}))

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

FORM_ID = 'deadbeef'
QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/forms'
#: A theme read without one: every field, its defaults (shared/form_theme.py ``with_defaults``; their values are
#: pinned by shared/test/test_form_theme.py).
DEFAULT_THEME_READ = default_theme()
#: A version 1 form's rating and text steps as version 2 reads them (a text step without its placeholder).
V1_RATING = {'id': 'q_rating', 'type': 'rating', 'headline': {'en': 'How was your experience?'}, 'required': True,
             'scale': 'star', 'range': 5}
V1_TEXT = {'id': 'q_text', 'type': 'open_text', 'headline': {'en': 'Tell us more'}, 'required': True, 'long': True,
           'input_type': 'text'}


def _route(api_gateway_event, lambda_context, method: str, path: str, **kwargs) -> tuple[dict, dict]:
    return call_route(h.lambda_handler, api_gateway_event, lambda_context, method=method, path=path, **kwargs)


def _submit(api_gateway_event, lambda_context, body: object, form_id: str = FORM_ID) -> tuple[dict, dict]:
    return _route(api_gateway_event, lambda_context, 'POST', f'/feedback-forms/{form_id}/submit',
                  path_params={'form_id': form_id}, body=body)


def _conditional_check_failed() -> ClientError:
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'no'}}, 'UpdateItem')


@pytest.fixture
def table() -> Iterator[MagicMock]:
    with patch.object(h, 'aggregates_table') as mock:
        yield mock


@pytest.fixture
def sqs() -> Iterator[MagicMock]:
    with patch.object(h, 'sqs') as mock, patch.object(h, 'PROCESSING_QUEUE_URL', QUEUE):
        yield mock


@pytest.fixture
def logger() -> Iterator[MagicMock]:
    with patch.object(h, 'logger') as mock:
        yield mock


class TestTheColdStartModuleState:
    @pytest.fixture
    def reload_with_env(self, monkeypatch) -> Iterator[Callable[..., ModuleType]]:
        yield env_reloader(monkeypatch, h)
        monkeypatch.undo()
        importlib.reload(h)

    def test_every_table_queue_and_brand_is_the_one_named_in_the_environment(self, reload_with_env):
        module = reload_with_env(AGGREGATES_TABLE='named-aggregates', FEEDBACK_TABLE='named-feedback',
                                 PROCESSING_QUEUE_URL=QUEUE, BRAND_NAME='Acme')
        assert module.AGGREGATES_TABLE == 'named-aggregates'
        assert module.aggregates_table.name == 'named-aggregates'
        assert module.FEEDBACK_TABLE == 'named-feedback'
        assert module.feedback_table.name == 'named-feedback'
        assert module.PROCESSING_QUEUE_URL == QUEUE
        assert module.BRAND_NAME == 'Acme'
        assert module.sqs.meta.service_model.service_name == 'sqs'

    @pytest.mark.parametrize(('configured', 'answered'), [
        # Unset fails CLOSED: the local-dev origin, never every site.
        (None, 'http://localhost:5173'),
        ('*', '*'),
        ('https://shop.example', 'https://shop.example'),
    ])
    def test_the_preflight_answers_with_the_configured_origin_and_never_any_origin_when_unset(
            self, reload_with_env, api_gateway_event, lambda_context, configured, answered):
        module = reload_with_env(ALLOWED_ORIGIN=configured)
        event = api_gateway_event(method='OPTIONS', path=f'/feedback-forms/{FORM_ID}/config',
                                  headers={'Origin': answered})
        response = module.lambda_handler(event, lambda_context)
        headers = response.get('multiValueHeaders') or {}
        assert headers.get('Access-Control-Allow-Origin') == [answered]

    def test_an_unset_origin_does_not_answer_a_customer_site(self, reload_with_env, api_gateway_event, lambda_context):
        module = reload_with_env(ALLOWED_ORIGIN=None)
        event = api_gateway_event(method='OPTIONS', path=f'/feedback-forms/{FORM_ID}/config',
                                  headers={'Origin': 'https://shop.example'})
        headers = module.lambda_handler(event, lambda_context).get('multiValueHeaders') or {}
        assert 'Access-Control-Allow-Origin' not in headers

    def test_a_cold_start_has_read_no_widget_script_yet(self, reload_with_env):
        assert reload_with_env()._widget_js_cache is None

    def test_nothing_in_the_environment_means_no_tables_and_empty_strings(self, reload_with_env):
        module = reload_with_env(AGGREGATES_TABLE=None, FEEDBACK_TABLE=None, PROCESSING_QUEUE_URL=None,
                                 BRAND_NAME=None)
        assert module.AGGREGATES_TABLE == ''
        assert module.aggregates_table is None
        assert module.FEEDBACK_TABLE == ''
        assert module.feedback_table is None
        assert module.PROCESSING_QUEUE_URL == ''
        assert module.BRAND_NAME == ''
        with pytest.raises(ConfigurationError) as exc:
            module._forms_table()
        assert str(exc.value) == 'AGGREGATES_TABLE not configured'


class TestANewFormIsStoredWithTheDocumentedDefaults:
    @pytest.mark.parametrize(('field', 'value'), [
        ('name', 'New Feedback Form'),
        ('enabled', False),
        ('schema_version', 2),
        ('revision', 1),
        ('theme', DEFAULT_THEME_READ),
        ('custom_fields', []),
        ('category', ''),
        ('subcategory', ''),
        ('project_id', ''),
        ('document_id', ''),
    ])
    def test_the_created_form_reports_each_default(self, table, api_gateway_event, lambda_context, field, value):
        response, payload = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms', body={})
        assert response['statusCode'] == 200
        assert payload['form'][field] == value
        assert table.put_item.call_args.kwargs['Item'][field] == value

    def test_an_empty_body_is_the_version_1_defaults_migrated(self, table, api_gateway_event, lambda_context):
        _, payload = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms', body={})
        stored = table.put_item.call_args.kwargs['Item']
        definition = {key: stored[key] for key in ('language', 'languages', 'welcome', 'questions', 'hidden_fields',
                                                  'endings')}
        assert definition == {
            'language': 'en', 'languages': ['en'],
            'welcome': {'enabled': True, 'title': {'en': 'Share Your Feedback'},
                        'description': {'en': 'We value your opinion.'}},
            'questions': [V1_RATING, {**V1_TEXT, 'placeholder': {'en': 'Tell us about your experience...'}}],
            'hidden_fields': [], 'endings': [{'id': 'end_thanks', 'title': {'en': 'Thank you for your feedback!'}}],
        }
        assert not set(h.fv2.V1_FIELDS) & set(stored)
        assert stored['settings'] == {'test': {'link_enabled': False, 'record': 'tag'}}
        assert payload['form']['questions'] == definition['questions']

    def test_a_dashboard_created_form_is_a_standard_one(self, table, api_gateway_event, lambda_context):
        _, payload = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms', body={})
        assert payload['form']['form_type'] == 'standard'
        assert 'form_type' not in table.put_item.call_args.kwargs['Item']

    def test_the_stored_record_has_the_key_and_identity_fields(self):
        with patch.object(h, 'BRAND_NAME', 'Acme'):
            before = datetime.now(UTC)
            item = h.build_form_item({})
            after = datetime.now(UTC)
        assert item['pk'] == 'FEEDBACK_FORM'
        assert item['sk'] == f"FORM#{item['form_id']}"
        # A deployment form: `fd_` + 32 hex (128 random bits, unguessable; never looked up in voc-workspaces).
        assert item['form_id'].startswith('fd_')
        assert len(item['form_id']) == 35
        assert int(item['form_id'].removeprefix('fd_'), 16) >= 0
        assert item['brand_name'] == 'Acme'
        assert item['created_at'] == item['updated_at']
        assert before <= datetime.fromisoformat(item['created_at']) <= after

    def test_a_given_id_is_used_verbatim(self):
        item = h.build_form_item({}, form_id='website-form')
        assert item['form_id'] == 'website-form'
        assert item['sk'] == 'FORM#website-form'


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('body', 'message'), [
        ({}, 'Feedback text is required'),
        ({'text': '   '}, 'Feedback text is required'),
        ({'text': 7}, 'Feedback text must be a string'),
        ({'text': 'x' * 10_001}, 'Feedback text must be at most 10000 characters'),
        ({'text': 'ok', 'name': 7}, 'name must be a string'),
        ({'text': 'ok', 'name': 'n' * 201}, 'name must be at most 200 characters'),
        ({'text': 'ok', 'email': 'e' * 255}, 'email must be at most 254 characters'),
        ({'text': 'ok', 'page_url': 'u' * 4097}, 'page_url must be at most 4096 characters'),
        ({'text': 'ok', 'rating': 0}, 'rating must be null or a number from 1 to 10'),
        ({'text': 'ok', 'custom_fields': 'x'}, 'custom_fields must be an object'),
        ({'text': 'ok', 'custom_fields': {f'k{i}': 1 for i in range(21)}},
         'custom_fields may hold at most 20 entries'),
        ({'text': 'ok', 'custom_fields': {'': 1}}, 'custom_fields keys must be 1-64 characters'),
        ({'text': 'ok', 'custom_fields': {'k' * 65: 1}}, 'custom_fields keys must be 1-64 characters'),
        ({'text': 'ok', 'custom_fields': {'score': float('nan')}}, 'custom_fields.score must be a finite number'),
        ({'text': 'ok', 'custom_fields': {'plan': {'a': 1}}},
         'custom_fields.plan must be a string, number, boolean or null'),
        ({'text': 'ok', 'custom_fields': {'plan': 'v' * 1001}}, 'custom_fields.plan must be at most 1000 characters'),
    ])
    @pytest.mark.usefixtures('sqs')
    def test_a_refused_submission_says_exactly_why(self, table, api_gateway_event, lambda_context, body, message):
        response, payload = _submit(api_gateway_event, lambda_context, body)
        assert response['statusCode'] == 400
        assert payload == {'success': False, 'error': message}
        table.get_item.assert_not_called()

    @pytest.mark.usefixtures('sqs')
    def test_a_submission_at_the_url_limit_is_accepted(self, table, api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': {'form_id': FORM_ID, 'enabled': True}}
        response, _ = _submit(api_gateway_event, lambda_context, {'text': 'ok', 'page_url': 'u' * 4096})
        assert response['statusCode'] == 200

    @pytest.mark.parametrize(('body', 'message'), [
        ({'project_id': 7}, 'project_id must be a string'),
        ({'document_id': ['d']}, 'document_id must be a string'),
        ({'project_id': 'p' * 129}, 'project_id must be at most 128 characters'),
        ({'document_id': 'd' * 129}, 'document_id must be at most 128 characters'),
    ])
    def test_a_refused_link_says_exactly_why_on_create_and_update(self, table, api_gateway_event, lambda_context,
                                                                  body, message):
        for method, path in (('POST', '/feedback-forms'), ('PUT', f'/feedback-forms/{FORM_ID}')):
            response, payload = _route(api_gateway_event, lambda_context, method, path,
                                       path_params={'form_id': FORM_ID}, body=body)
            assert response['statusCode'] == 400
            assert payload == {'success': False, 'error': message}
        table.put_item.assert_not_called()
        table.update_item.assert_not_called()

    @pytest.mark.usefixtures('table')
    def test_a_link_at_the_limit_is_saved(self, api_gateway_event, lambda_context):
        response, payload = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms',
                                   body={'project_id': 'p' * 128})
        assert response['statusCode'] == 200
        assert payload['form']['project_id'] == 'p' * 128

    @pytest.mark.parametrize('path', ['/feedback-forms/{id}/config', '/feedback-forms/{id}/iframe'])
    def test_a_malformed_public_id_is_told_apart_from_nothing(self, table, api_gateway_event, lambda_context, path):
        response, payload = _route(api_gateway_event, lambda_context, 'GET', path.format(id='..'),
                                   path_params={'form_id': '..'})
        assert response['statusCode'] == 404
        assert payload == {'success': False, 'error': 'Form not found'}
        table.get_item.assert_not_called()


@pytest.mark.usefixtures('sqs')
class TestTheAnchorTellsItsOutcomeApart:
    # Answered already: its submit writes no has_responses mark (7.55.00), only the anchor this class is about.
    FORM: ClassVar[dict] = {'form_id': FORM_ID, 'enabled': True, 'brand_name': '', 'has_responses': True}

    def _submit_under_brand(self, table, api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': dict(self.FORM)}
        with patch.object(h, 'BRAND_NAME', 'Acme'):
            return _submit(api_gateway_event, lambda_context, {'text': 'ok'})

    def test_an_anchor_that_stuck_is_logged_with_the_brand(self, table, logger, api_gateway_event, lambda_context):
        response, _ = self._submit_under_brand(table, api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        assert logger.info.call_args_list[0].args == (f"Anchored form {FORM_ID} to brand 'Acme'",)
        logger.warning.assert_not_called()

    def test_the_anchor_sets_the_brand_only_on_an_existing_brandless_form(self, table, api_gateway_event,
                                                                          lambda_context):
        self._submit_under_brand(table, api_gateway_event, lambda_context)
        kwargs = table.update_item.call_args.kwargs
        assert kwargs == {
            'Key': {'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}'},
            'UpdateExpression': 'SET brand_name = :brand, updated_at = :now',
            'ConditionExpression': 'attribute_exists(sk) AND (attribute_not_exists(brand_name) OR brand_name = :empty)',
            'ExpressionAttributeValues': {':brand': 'Acme', ':empty': '',
                                          ':now': kwargs['ExpressionAttributeValues'][':now']},
        }
        assert datetime.fromisoformat(kwargs['ExpressionAttributeValues'][':now']).tzinfo == UTC

    def test_a_condition_that_did_not_hold_is_silent(self, table, logger, api_gateway_event, lambda_context):
        table.update_item.side_effect = _conditional_check_failed()
        response, payload = self._submit_under_brand(table, api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        logger.warning.assert_not_called()
        logger.info.assert_called_once_with(f"Submitted feedback to form {FORM_ID}: {payload['feedback_id']}")

    @pytest.mark.parametrize('error', [
        RuntimeError('throttled'),
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}}, 'UpdateItem'),
        ClientError({'Error': {}}, 'UpdateItem'),
        ClientError({}, 'UpdateItem'),
    ])
    def test_any_other_failure_is_a_warning_that_names_the_form_and_the_error(
        self, table, logger, api_gateway_event, lambda_context, error,
    ):
        table.update_item.side_effect = error
        response, _ = self._submit_under_brand(table, api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        logger.warning.assert_called_once_with(f'Could not anchor brand_name for form {FORM_ID}: {error}')
        assert [c.args[0].split(':')[0] for c in logger.info.call_args_list] == [f'Submitted feedback to form {FORM_ID}']

    @pytest.mark.parametrize(('error', 'is_failure'), [
        (_conditional_check_failed(), True),
        (ClientError({'Error': {'Code': 'ValidationException', 'Message': 'x'}}, 'UpdateItem'), False),
        (ClientError({'Error': {'Code': 'conditionalcheckfailedexception', 'Message': 'x'}}, 'UpdateItem'), False),
        (ClientError({'Error': {'Message': 'x'}}, 'UpdateItem'), False),
        (ClientError({}, 'UpdateItem'), False),
        (RuntimeError('ConditionalCheckFailedException'), False),
    ])
    def test_a_conditional_check_failure_is_recognised_by_its_code(self, error, is_failure):
        assert h._is_conditional_check_failure(error) is is_failure


# ---------------------------------------------------------------------------
# Lines 451-1229: the routes. A second mutation run (the module's last slice)
# found that the route tests above and in test_feedback_form_handler.py pin the
# status of each outcome but not its CONTENT: the projection defaults, the exact
# DynamoDB calls, the refusal and failure wording, the queued record's metadata,
# the pin route's log/metric/response literals, the list's stats payload and its
# paging, the CORS default and the widget's fallback script.
# ---------------------------------------------------------------------------

TRACED_ROUTES = ('list_forms', 'create_form', 'update_form', 'delete_form',
                 'get_form_config_by_id', 'submit_form_feedback', 'get_form_iframe',
                 'get_form_submissions', 'get_form_stats')
FORM_KEY = {'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}'}
#: A sparse version 1 record ({}) as version 2: its rating and text steps, the default ending.
EMPTY_DEFINITION = {
    'language': 'en', 'languages': ['en'], 'welcome': {'enabled': False},
    'questions': [V1_RATING, V1_TEXT],
    'hidden_fields': [], 'endings': [{'id': 'end_thanks', 'title': {'en': 'Thank you!'}}],
}
EMPTY_WIDGET = {'enabled': False, 'schema_version': 2, 'revision': 1, **EMPTY_DEFINITION, 'language_assumed': True,
                'theme': DEFAULT_THEME_READ}
EMPTY_FORM = {
    'form_id': '', 'name': '', **EMPTY_WIDGET,
    'settings': {'test': {'link_enabled': False, 'record': 'tag', 'token_issued': False}},
    'custom_fields': [], 'category': '', 'subcategory': '', 'project_id': '', 'document_id': '',
    'dimension_defaults': {}, 'tags': [], 'form_type': 'standard', 'brand_name': '', 'created_at': '',
    'updated_at': '', 'updated_by': '',
    # Never answered, no question removed, never saved; and a record without schema_version 2 is a version 1 one,
    # served migrated.
    'has_responses': False, 'retired_ids': [], 'write_count': 0, 'migrated_from': 1,
}
#: A stored version 2 record with a value no default could produce in every field.
V2_ITEM = {
    'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}', 'form_id': FORM_ID, 'name': 'Internal name', 'enabled': True,
    'schema_version': 2, 'revision': 4, 'language': 'pl', 'languages': ['pl', 'en'],
    'welcome': {'enabled': True, 'title': {'pl': 'Witaj', 'en': 'Hello'}},
    'questions': [{'id': 'q_reason', 'type': 'single_select', 'headline': {'pl': 'Dlaczego?'}, 'required': True,
                   'options': [{'code': 'price', 'label': {'pl': 'Cena'},
                                'category': {'category': 'pricing', 'subcategory': 'too_high'}}],
                   'other': {'enabled': False}, 'shuffle': 'none', 'display': 'auto'}],
    'hidden_fields': [{'id': 'user_id', 'label': 'User'}],
    'endings': [{'id': 'end_bye', 'title': {'pl': 'Dzięki'}}],
    'theme': {'primary_color': '#123456'},
    'settings': {'test': {'link_enabled': True, 'record': 'drop', 'token': 'secret-token',
                          'token_issued_at': '2026-11-17T10:00:00+00:00'}},
    'custom_fields': [{'id': 'c'}], 'category': 'cat', 'subcategory': 'sub', 'project_id': 'proj-1',
    'document_id': 'doc-1', 'dimension_defaults': {'product': 'app'}, 'tags': ['vip'], 'form_type': 'standard',
    'brand_name': 'Acme', 'created_at': 'c-at', 'updated_at': 'u-at', 'updated_by': 'sub-1', 'has_responses': True,
    'retired_ids': ['q_old'], 'write_count': 7,
}


@pytest.fixture
def feedback() -> Iterator[MagicMock]:
    with patch.object(h, 'feedback_table') as mock:
        yield mock


@pytest.fixture
def metrics() -> Iterator[MagicMock]:
    with patch.object(h, 'metrics') as mock:
        yield mock


class TestEveryRouteIsTraced:
    @pytest.mark.parametrize('name', TRACED_ROUTES)
    def test_the_route_is_the_tracer_wrapper(self, name):
        assert_tracer_wrapped(h, name)

    def test_the_handler_keeps_its_decorator(self):
        assert_handler_wrapped(h)


class TestTheProjectionsDefaultEveryAbsentField:
    def test_an_empty_record_reads_as_the_documented_blanks(self):
        assert h.item_to_form({}) == EMPTY_FORM
        assert h.item_to_widget_config({}) == EMPTY_WIDGET

    def test_every_stored_field_is_read_from_its_own_key(self):
        public_question = {**V2_ITEM['questions'][0], 'options': [{'code': 'price', 'label': {'pl': 'Cena'}}]}
        assert h.item_to_widget_config(V2_ITEM) == {
            'enabled': True, 'schema_version': 2, 'revision': 4, 'language': 'pl', 'languages': ['pl', 'en'],
            'welcome': V2_ITEM['welcome'], 'questions': [public_question], 'hidden_fields': [{'id': 'user_id'}],
            'endings': V2_ITEM['endings'], 'language_assumed': False,
            'theme': {**DEFAULT_THEME_READ, 'primary_color': '#123456'},
        }
        form = h.item_to_form(V2_ITEM)
        assert form == {
            **h.item_to_widget_config(V2_ITEM), 'form_id': FORM_ID, 'name': 'Internal name',
            'questions': V2_ITEM['questions'], 'hidden_fields': V2_ITEM['hidden_fields'],
            'settings': {'test': {'link_enabled': True, 'record': 'drop', 'token_issued': True,
                                  'token_issued_at': '2026-11-17T10:00:00+00:00'}},
            **{key: V2_ITEM[key] for key in ('custom_fields', 'category', 'subcategory', 'project_id', 'document_id',
                                             'dimension_defaults', 'tags', 'form_type', 'brand_name', 'created_at',
                                             'updated_at', 'updated_by', 'has_responses', 'retired_ids',
                                             'write_count')},
        }
        assert 'secret-token' not in json.dumps(form)
        # Neither is published: the public config is its own projection.
        assert not {'retired_ids', 'write_count'} & set(h.item_to_widget_config(V2_ITEM))

    def test_a_stored_boolean_wins_over_its_default(self):
        for value in (True, False):
            assert h.item_to_form({'enabled': value})['enabled'] is value
            assert h.item_to_widget_config({'enabled': value})['enabled'] is value

    def test_a_blank_form_type_reads_as_standard(self):
        assert h.item_to_form({'form_type': ''})['form_type'] == 'standard'


class TestTheRatingTally:
    def test_the_average_is_rounded_to_two_places_and_zero_is_no_rating(self):
        tally = h._RatingTally()
        for rating in (1, 1, 2, 0, None):
            tally.add({'rating': rating})
        tally.add({})
        assert tally.stats(6) == {'total_submissions': 6, 'avg_rating': 1.33, 'rating_count': 3}

    def test_no_ratings_is_no_average(self):
        assert h._RatingTally().stats(2) == {'total_submissions': 2, 'avg_rating': None, 'rating_count': 0}


class TestTheWidgetScript:
    def test_the_static_file_is_served_and_cached(self):
        expected = (Path(h.__file__).parent / 'static' / 'feedback-widget.js').read_text()
        with patch.object(h, '_widget_js_cache', None):
            assert h.get_widget_js() == expected
            assert h._widget_js_cache == expected

    def test_a_cached_script_is_returned_without_a_read(self):
        with patch.object(h, '_widget_js_cache', 'cached'), patch.object(h, 'Path') as path:
            assert h.get_widget_js() == 'cached'
        path.assert_not_called()

    def test_a_missing_file_falls_back_loudly_and_caches_the_fallback(self, logger):
        with patch.object(h, '_widget_js_cache', None), patch.object(h, '__file__', '/nowhere/handler.py'):
            script = h.get_widget_js()
            assert h._widget_js_cache == script
        assert script == h._get_fallback_widget_js()
        logger.warning.assert_called_once_with(
            'Widget JS not found at /nowhere/static/feedback-widget.js, using fallback')

    def test_the_fallback_is_a_bare_script_that_says_it_failed(self):
        script = h._get_fallback_widget_js()
        assert script.startswith('\n(function() {\n  window.VoCFeedbackForm = {')
        assert script.endswith('Widget loading error.</p>\';\n    }\n  };\n})();\n')


class TestListingForms:
    FORMS: ClassVar[list[dict]] = [
        {'form_id': 'older', 'created_at': '2026-01-01'},
        {'form_id': 'undated'},
        {'form_id': 'newer', 'created_at': '2026-02-01'},
    ]

    def _list(self, api_gateway_event, lambda_context, query_params=None):
        return _route(api_gateway_event, lambda_context, 'GET', '/feedback-forms', query_params=query_params)

    def test_the_forms_partition_is_read_newest_first(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [dict(f) for f in self.FORMS]}
        response, payload = self._list(api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        assert payload == {'success': True,
                           'forms': [h.item_to_form(self.FORMS[i]) for i in (2, 0, 1)]}
        # Strongly consistent: a form deleted a moment ago must not come back in the list.
        # One partition query through shared/scoped_query.py: boto3's `Key('pk').eq('FEEDBACK_FORM')`.
        # Only the FORM# rows: revision snapshots and test responses (FORMREV#, FORMTEST#) sort after them.
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('FEEDBACK_FORM') & Key('sk').begins_with('FORM#'),
            ConsistentRead=True)

    def test_no_items_key_is_no_forms(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {}
        _, payload = self._list(api_gateway_event, lambda_context)
        assert payload == {'success': True, 'forms': []}

    def test_a_failed_read_is_a_named_500(self, table, logger, api_gateway_event, lambda_context):
        table.query.side_effect = RuntimeError('boom')
        response, payload = self._list(api_gateway_event, lambda_context)
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': 'Failed to list forms'}
        logger.exception.assert_called_once_with('Error listing forms: boom')

    def test_stats_ride_along_when_asked(self, table, feedback, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [{'form_id': 'a', 'brand_name': 'Acme'}]}
        feedback.query.side_effect = [{'Items': [{'source_channel': 'form_a', 'rating': 4}]}]
        _, payload = self._list(api_gateway_event, lambda_context, {'include': 'stats'})
        assert payload == {'success': True, 'forms': [h.item_to_form({'form_id': 'a', 'brand_name': 'Acme'})],
                           'stats': {'a': {'total_submissions': 1, 'avg_rating': 4.0, 'rating_count': 1,
                                           'headline': {'question_id': 'q_rating', 'type': 'rating', 'value': 4.0,
                                                        'count': 1, 'scale_max': 5}}}}

    def test_a_failed_stats_read_still_lists_the_forms(self, table, feedback, logger, metrics,
                                                       api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [{'form_id': 'a'}]}
        feedback.query.side_effect = RuntimeError('slow')
        response, payload = self._list(api_gateway_event, lambda_context, {'include': 'stats'})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'forms': [h.item_to_form({'form_id': 'a'})],
                           'stats_error': 'Failed to fetch form stats'}
        metrics.add_metric.assert_called_once_with(name='FeedbackFormStatsReadFailed', unit='Count', value=1)
        logger.exception.assert_called_once_with('Error fetching stats for the form list: slow')


LIST_PROJECTION = ('feedback_id, rating, category, source_platform, source_channel, metadata, '
                   'source_created_at')


def _rating_headline(average: float, count: int = 1) -> dict:
    """The card figure of a migrated version 1 form: its rating question's average."""
    return {'question_id': 'q_rating', 'type': 'rating', 'value': average, 'count': count, 'scale_max': 5}


class TestTheListStatsReadEachPartitionOnce:
    @staticmethod
    def _stats(items: list[dict]) -> dict:
        with patch.object(h, 'app'), patch.object(h, 'scope_for_event', return_value=UNRESTRICTED):
            return h._stats_for_forms(items)

    def test_an_unconfigured_feedback_table_is_named(self):
        with patch.object(h, 'feedback_table', None), pytest.raises(ConfigurationError) as exc:
            h._stats_for_forms([])
        assert str(exc.value) == 'Feedback table not configured'

    def test_one_in_query_per_partition_paged_to_the_end(self, feedback):
        feedback.query.side_effect = [
            {'Items': [{'source_channel': 'form_a', 'rating': 5}, {'source_channel': 'form_x'}],
             'LastEvaluatedKey': {'k': 1}},
            {'Items': [{'source_channel': 'form_b'}, {'rating': 2}]},
            {'Items': [{'source_channel': 'form_c', 'rating': 3}]},
        ]
        forms = [{'form_id': 'a', 'brand_name': 'Acme'}, {'form_id': 'b', 'brand_name': 'Acme'},
                 {'form_id': 'c', 'brand_name': 'Beta'}, {'form_id': ''}, {'form_id': 7}, {}]
        stats = self._stats(forms)
        assert stats == {
            'a': {'total_submissions': 1, 'avg_rating': 5.0, 'rating_count': 1, 'headline': _rating_headline(5.0)},
            'b': {'total_submissions': 1, 'avg_rating': None, 'rating_count': 0, 'headline': None},
            'c': {'total_submissions': 1, 'avg_rating': 3.0, 'rating_count': 1, 'headline': _rating_headline(3.0)},
        }
        acme = {'KeyConditionExpression': Key('pk').eq('SOURCE#Acme'),
                'FilterExpression': 'source_channel IN (:sc0, :sc1)',
                'ExpressionAttributeValues': {':sc0': 'form_a', ':sc1': 'form_b'},
                'ProjectionExpression': LIST_PROJECTION}
        assert [c.kwargs for c in feedback.query.call_args_list] == [
            acme,
            {**acme, 'ExclusiveStartKey': {'k': 1}},
            {'KeyConditionExpression': Key('pk').eq('SOURCE#Beta'),
             'FilterExpression': 'source_channel IN (:sc0)',
             'ExpressionAttributeValues': {':sc0': 'form_c'},
             'ProjectionExpression': LIST_PROJECTION},
        ]

    def test_a_source_restricted_caller_counts_only_visible_submissions(self, feedback):
        """`source_platform` is projected, so the source rule can hide a restricted source's rows."""
        feedback.query.side_effect = [{'Items': [
            {'source_channel': 'form_a', 'rating': 5, 'source_platform': 'feedback_form'},
            {'source_channel': 'form_a', 'rating': 1, 'source_platform': 'support_tickets'},
        ]}]
        with patch.object(h, 'app'), patch.object(h, 'scope_for_event', return_value=NO_TICKETS):
            stats = h._stats_for_forms([{'form_id': 'a', 'brand_name': 'Acme'}])
        assert stats == {'a': {'total_submissions': 1, 'avg_rating': 5.0, 'rating_count': 1,
                               'headline': _rating_headline(5.0)}}

    def test_the_latest_response_time_rides_along_when_the_rows_carry_one(self, feedback):
        """The card's "last response 2 h ago": the latest ``source_created_at`` of the counted rows, absent without one."""
        feedback.query.side_effect = [{'Items': [
            {'source_channel': 'form_a', 'rating': 4, 'source_created_at': '2026-11-18T09:00:00+00:00'},
            {'source_channel': 'form_a', 'rating': 5, 'source_created_at': '2026-11-19T08:30:00+00:00'},
            {'source_channel': 'form_a', 'rating': 3, 'source_created_at': '2026-11-17T23:59:00+00:00'},
            {'source_channel': 'form_b'},
        ]}]
        stats = self._stats([{'form_id': 'a', 'brand_name': 'Acme'}, {'form_id': 'b', 'brand_name': 'Acme'}])
        assert stats['a']['last_response_at'] == '2026-11-19T08:30:00+00:00'
        assert 'last_response_at' not in stats['b']

    def test_each_channel_rides_along_with_the_last_time_it_answered(self, feedback):
        """The card's "Link · Website script · Embedded": per channel the response stored, its latest time; none for a
        widget from before 7.55.01 (no ``form_channel``), and nothing unknown."""
        row = lambda channel, at: {'source_channel': 'form_a', 'source_created_at': at,  # noqa: E731 - a table row
                                   'metadata': {} if channel is None else {'form_channel': channel}}
        feedback.query.side_effect = [{'Items': [
            row('script', '2026-11-10T09:00:00+00:00'), row('script', '2026-11-18T09:00:00+00:00'),
            row('link', '2026-11-12T10:00:00+00:00'), row(None, '2026-11-19T08:00:00+00:00'),
            row('app', '2026-11-19T08:30:00+00:00'),
            {'source_channel': 'form_b', 'source_created_at': '2026-11-19T07:00:00+00:00'},
        ]}]
        stats = self._stats([{'form_id': 'a', 'brand_name': 'Acme'}, {'form_id': 'b', 'brand_name': 'Acme'}])
        assert stats['a']['channels'] == {'link': '2026-11-12T10:00:00+00:00', 'script': '2026-11-18T09:00:00+00:00'}
        assert 'channels' not in stats['b']

    def test_a_row_without_a_channel_counts_for_no_form_whatever_its_id(self, feedback):
        feedback.query.side_effect = [{'Items': [{'rating': 1}]}]
        stats = self._stats([{'form_id': 'XXXX', 'brand_name': 'Acme'}])
        assert stats == {'XXXX': {'total_submissions': 0, 'avg_rating': None, 'rating_count': 0, 'headline': None}}

    def test_an_in_list_holds_at_most_a_hundred_operands(self, feedback):
        feedback.query.side_effect = [{'Items': []}, {'Items': []}]
        self._stats([{'form_id': f'f{i}', 'brand_name': 'Acme'} for i in range(101)])
        sizes = [len(c.kwargs['ExpressionAttributeValues']) for c in feedback.query.call_args_list]
        assert sizes == [100, 1]

    def test_chunks_split_in_order(self):
        assert h._chunks(['a', 'b', 'c', 'd', 'e'], 2) == [['a', 'b'], ['c', 'd'], ['e']]


class TestTheCrudRoutesNameEveryOutcome:
    def test_a_created_form_is_logged_by_id(self, table, logger, api_gateway_event, lambda_context):
        _, payload = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms', body={'name': 'N'})
        logger.info.assert_called_once_with(f"Created feedback form: {payload['form']['form_id']}")
        assert table.put_item.call_count == 1
        assert payload == {'success': True, 'form': h.item_to_form(table.put_item.call_args.kwargs['Item'])}

    def test_a_stored_form_is_listed_whole(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [dict(V2_ITEM)]}
        response, payload = _route(api_gateway_event, lambda_context, 'GET', '/feedback-forms')
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'forms': [h.item_to_form(V2_ITEM)]}

    @pytest.mark.parametrize(('method', 'path', 'body', 'call', 'message', 'log'), [
        ('POST', '/feedback-forms', {'name': 'N'}, 'put_item', 'Failed to create form', 'Error creating form: boom'),
        ('PUT', f'/feedback-forms/{FORM_ID}', {'name': 'N'}, 'update_item', 'Failed to update form',
         'Error updating form: boom'),
        ('DELETE', f'/feedback-forms/{FORM_ID}', None, 'delete_item', 'Failed to delete form',
         'Error deleting form: boom'),
        ('GET', f'/feedback-forms/{FORM_ID}/config', None, 'get_item', 'Failed to get form configuration',
         f'Error reading form {FORM_ID}: boom'),
    ])
    def test_a_failed_write_or_read_is_a_named_500(self, table, logger, api_gateway_event, lambda_context,
                                                   method, path, body, call, message, log):
        table.get_item.return_value = {'Item': {'form_id': FORM_ID}}
        table.query.return_value = {'Items': []}
        getattr(table, call).side_effect = RuntimeError('boom')
        response, payload = _route(api_gateway_event, lambda_context, method, path,
                                   path_params={'form_id': FORM_ID}, body=body)
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': message}
        logger.exception.assert_called_once_with(log)

    def test_a_missing_form_is_a_404_read_by_its_key(self, table, api_gateway_event, lambda_context):
        table.get_item.return_value = {}
        response, payload = _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{FORM_ID}/config',
                                   path_params={'form_id': FORM_ID})
        assert response['statusCode'] == 404
        assert payload == {'success': False, 'error': 'Form not found'}
        table.get_item.assert_called_once_with(Key=FORM_KEY)

    def test_the_public_config_is_the_widget_projection(self, table, api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': dict(V2_ITEM)}
        response, payload = _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{FORM_ID}/config',
                                   path_params={'form_id': FORM_ID})
        assert payload == {'success': True, 'config': h.item_to_widget_config(V2_ITEM)}
        for private in ('Internal name', 'secret-token', 'pricing', 'proj-1', 'doc-1', 'sub-1', 'User'):
            assert private not in response['body']

    def test_a_delete_removes_the_forms_key_and_says_so(self, table, logger, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': []}
        response, payload = _route(api_gateway_event, lambda_context, 'DELETE', f'/feedback-forms/{FORM_ID}',
                                   path_params={'form_id': FORM_ID})
        assert (response['statusCode'], payload) == (200, {'success': True})
        table.delete_item.assert_called_once_with(Key=FORM_KEY)
        logger.info.assert_called_once_with(f'Deleted feedback form: {FORM_ID}')


class TestAnUpdateSetsOnlyWhatWasSent:
    def _put(self, api_gateway_event, lambda_context, body):
        return _route(api_gateway_event, lambda_context, 'PUT', f'/feedback-forms/{FORM_ID}',
                      path_params={'form_id': FORM_ID}, body=body)

    def test_the_expression_sets_each_sent_field_conditional_on_the_revision_read(
            self, table, api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': dict(V2_ITEM)}
        table.update_item.return_value = {'Attributes': {'form_id': FORM_ID, 'name': 'N'}}
        before = datetime.now(UTC)
        response, payload = self._put(api_gateway_event, lambda_context,
                                      {'enabled': False, 'name': 'N', 'brand_name': 'ignored', 'revision': 99})
        after = datetime.now(UTC)
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'form': h.item_to_form({'form_id': FORM_ID, 'name': 'N'})}
        kwargs = table.update_item.call_args.kwargs
        names, values = kwargs['ExpressionAttributeNames'], kwargs['ExpressionAttributeValues']
        sets = {names[f'#f{i}']: values[f':f{i}'] for i in range(len(values) - 2)}
        updated_at = datetime.fromisoformat(sets.pop('updated_at'))
        assert before <= updated_at <= after
        # The definition is written back as read (no change, so no new revision and no snapshot); one more save.
        assert sets == {'name': 'N', 'enabled': False, 'schema_version': 2, 'revision': 4, 'write_count': 8,
                        'updated_by': 'test-user-id', **{key: V2_ITEM[key] for key in h.fv2.DEFINITION_FIELDS}}
        assert kwargs['ConditionExpression'] == 'attribute_exists(sk) AND #revision = :expected AND #writes = :writes'
        assert (names['#revision'], values[':expected'], names['#writes'], values[':writes']) == (
            'revision', 4, 'write_count', 7)
        assert ' REMOVE ' not in kwargs['UpdateExpression']
        assert kwargs['Key'] == FORM_KEY
        assert kwargs['ReturnValues'] == 'ALL_NEW'
        table.put_item.assert_not_called()

    def test_an_update_of_a_form_that_is_not_there_is_a_404(self, table, api_gateway_event, lambda_context):
        table.get_item.return_value = {}
        response, payload = self._put(api_gateway_event, lambda_context, {'title': 'T'})
        assert (response['statusCode'], payload['error']) == (404, 'Form not found')
        table.update_item.assert_not_called()

    def test_a_form_deleted_meanwhile_is_a_404_and_one_saved_meanwhile_a_409(self, table, api_gateway_event,
                                                                            lambda_context):
        table.update_item.side_effect = _conditional_check_failed()
        table.get_item.side_effect = [{'Item': dict(V2_ITEM)}, {}]
        response, _ = self._put(api_gateway_event, lambda_context, {'name': 'N'})
        assert response['statusCode'] == 404
        table.get_item.side_effect = [{'Item': dict(V2_ITEM)}, {'Item': dict(V2_ITEM)}]
        response, payload = self._put(api_gateway_event, lambda_context, {'name': 'N'})
        assert (response['statusCode'], payload['code']) == (409, 'revision_conflict')

    def test_an_update_answer_without_attributes_is_a_blank_form(self, table, feedback, api_gateway_event,
                                                                 lambda_context):
        table.get_item.return_value = {'Item': {'form_id': FORM_ID}}
        table.update_item.return_value = {}
        feedback.query.return_value = {'Items': []}
        _, payload = self._put(api_gateway_event, lambda_context, {'title': 'T'})
        assert payload == {'success': True, 'form': EMPTY_FORM}
        # A definition change of a form never marked answered reads whether it has a response (none here).
        assert feedback.query.call_args.kwargs['ExpressionAttributeValues'] == {':sc': f'form_{FORM_ID}'}

    @pytest.mark.parametrize('body', [None, {'brand_name': 'x'}, {'revision': 3}])
    def test_nothing_updatable_is_refused_by_name(self, table, api_gateway_event, lambda_context, body):
        response, payload = self._put(api_gateway_event, lambda_context, body)
        assert response['statusCode'] == 400
        assert payload == {'success': False, 'error': 'No fields to update'}
        table.get_item.assert_not_called()
        table.update_item.assert_not_called()


class TestALiveFormKeepsReadableText:
    """Text under 3:1 on its background (shared/forms_v2.py ``validate_publishable``): Publish, and a colour change on a
    live form, are refused; any other save of a live form whose stored theme is already unreadable goes through with
    the warning ``theme_unreadable``; a form that stays, or goes, Off is always saved."""

    GREY: ClassVar[dict[str, str]] = {'text_color': '#9ca3af'}  # 2.54:1 on white
    PALE: ClassVar[dict[str, str]] = {'text_color': '#b0b0b0'}  # 2.1:1 on white: unreadable as well

    def _put(self, api_gateway_event, lambda_context, body, stored):
        self.table.get_item.return_value = {'Item': {**V2_ITEM, **stored}}
        self.table.update_item.return_value = {'Attributes': {'form_id': FORM_ID}}
        return _route(api_gateway_event, lambda_context, 'PUT', f'/feedback-forms/{FORM_ID}',
                      path_params={'form_id': FORM_ID}, body=body)

    @pytest.fixture(autouse=True)
    def _table(self, table):
        self.table = table

    def _refused(self, response, payload):
        assert response['statusCode'] == 400
        assert payload['code'] == 'theme_unreadable'
        assert payload['palettes'] == [{'palette': 'light', 'ratio': 2.54}]
        assert payload['error'].startswith('The text on the light background is 2.5:1, under 3:1')

    def test_creating_a_live_form_with_unreadable_text_is_refused(self, api_gateway_event, lambda_context):
        response, payload = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms',
                                   body={'enabled': True, 'theme': self.GREY})
        self._refused(response, payload)
        self.table.put_item.assert_not_called()

    def test_creating_it_off_stores_it(self, api_gateway_event, lambda_context):
        response, _ = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms', body={'theme': self.GREY})
        assert response['statusCode'] == 200

    @pytest.mark.parametrize(('body', 'stored'), [
        ({'enabled': True, 'theme': GREY}, {'enabled': False}),
        ({'enabled': True}, {'enabled': False, 'theme': GREY}),
        ({'enabled': True, 'name': 'Renamed'}, {'enabled': False, 'theme': GREY}),
    ], ids=['publish-with-it', 'publish-a-stored-one', 'publish-with-another-edit'])
    def test_publishing_with_unreadable_text_is_refused(self, api_gateway_event, lambda_context, body, stored):
        self._refused(*self._put(api_gateway_event, lambda_context, body, stored))
        self.table.update_item.assert_not_called()

    @pytest.mark.parametrize(('body', 'stored'), [
        ({'theme': GREY}, {'enabled': True}),
        ({'enabled': True, 'theme': GREY}, {'enabled': True}),
        ({'theme': {**GREY, 'border_radius': '4px'}}, {'enabled': True, 'theme': GREY}),
    ], ids=['readable-to-unreadable', 'with-enabled-sent', 'unreadable-and-changed'])
    def test_a_live_forms_theme_changed_to_unreadable_text_is_refused(self, api_gateway_event, lambda_context,
                                                                      body, stored):
        self._refused(*self._put(api_gateway_event, lambda_context, body, stored))
        self.table.update_item.assert_not_called()

    def test_a_live_forms_colours_changed_to_other_unreadable_ones_are_refused(self, api_gateway_event, lambda_context):
        response, payload = self._put(api_gateway_event, lambda_context, {'theme': self.PALE},
                                      {'enabled': True, 'theme': self.GREY})
        assert response['statusCode'] == 400
        assert payload['code'] == 'theme_unreadable'
        self.table.update_item.assert_not_called()

    @pytest.mark.parametrize(('body', 'stored'), [
        ({'name': 'Renamed'}, {'enabled': True, 'theme': GREY}),
        ({'theme': GREY, 'name': 'Renamed'}, {'enabled': True, 'theme': GREY}),
        ({'enabled': True, 'theme': {**GREY, 'mode': 'light'}}, {'enabled': True, 'theme': GREY}),
    ], ids=['theme-not-sent', 'same-theme-sent', 'same-theme-with-its-defaults'])
    def test_a_live_form_kept_on_its_stored_unreadable_theme_is_saved_with_a_warning(self, api_gateway_event,
                                                                                     lambda_context, body, stored):
        response, payload = self._put(api_gateway_event, lambda_context, body, stored)
        assert response['statusCode'] == 200
        assert payload['success'] is True
        assert payload['warnings'] == ['theme_unreadable']
        self.table.update_item.assert_called_once()

    @pytest.mark.parametrize(('body', 'stored'), [
        ({'theme': GREY}, {'enabled': False}),
        ({'enabled': False}, {'enabled': True, 'theme': GREY}),
        ({'enabled': False, 'theme': GREY}, {'enabled': True}),
        ({'theme': {**GREY, 'mode': 'dark'}}, {'enabled': True}),
    ], ids=['save-off', 'turn-off', 'turn-off-with-it', 'light-palette-not-shown'])
    def test_a_form_that_stays_off_or_shows_readable_text_is_saved(self, api_gateway_event, lambda_context,
                                                                    body, stored):
        response, payload = self._put(api_gateway_event, lambda_context, body, stored)
        assert response['statusCode'] == 200
        assert 'warnings' not in payload
        self.table.update_item.assert_called_once()


@pytest.mark.usefixtures('metrics')
class TestAPrototypePinIsStoredNotQueued:
    FORM: ClassVar[dict] = {'form_id': FORM_ID, 'enabled': True, 'form_type': 'prototype_pin', 'brand_name': 'A'}
    BODY: ClassVar[dict] = {'text': 'the button is off', 'pin': {}}

    def test_a_pin_is_saved_counted_and_logged_by_id(self, table, sqs, logger, metrics,
                                                      api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': {**self.FORM, 'success_message': 'Pinned!'}}
        response, payload = _submit(api_gateway_event, lambda_context, self.BODY)
        assert response['statusCode'] == 200
        pin_id = table.put_item.call_args.kwargs['Item']['pin_id']
        assert payload == {'success': True, 'pin_id': pin_id, 'message': 'Pinned!'}
        metrics.add_metric.assert_called_once_with(name='PrototypePinSubmitted', unit='Count', value=1)
        logger.info.assert_called_once_with('Stored prototype pin',
                                            extra={'form_id': FORM_ID, 'pin_id': pin_id, 'flagged': False})
        sqs.send_message.assert_not_called()

    @pytest.mark.usefixtures('sqs')
    def test_a_pin_form_without_a_message_thanks_the_tester(self, table, api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': dict(self.FORM)}
        _, payload = _submit(api_gateway_event, lambda_context, self.BODY)
        assert payload['message'] == 'Thanks — your pin was saved.'

    @pytest.mark.usefixtures('sqs')
    def test_a_failed_pin_write_is_a_named_500_that_logs_no_content(self, table, logger, metrics,
                                                                   api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': dict(self.FORM)}
        table.put_item.side_effect = RuntimeError('the button is off')
        response, payload = _submit(api_gateway_event, lambda_context, self.BODY)
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': 'Failed to save the pin. Please try again.'}
        logger.exception.assert_called_once_with(f'Error storing pin for form {FORM_ID}: RuntimeError')
        metrics.add_metric.assert_not_called()


class TestASubmissionIsQueuedWithItsForm:
    FORM: ClassVar[dict] = {'form_id': FORM_ID, 'enabled': True, 'brand_name': 'Acme', 'name': 'Survey',
                            'category': 'delivery', 'subcategory': 'late'}
    BODY: ClassVar[dict] = {'text': ' late again ', 'rating': 2, 'page_url': 'https://shop.example/p',
                            'email': 'a@b.example', 'name': 'Ann', 'custom_fields': {'plan': 'pro'}}

    def _queued(self, table, sqs, api_gateway_event, lambda_context, form: dict, body: dict):
        table.get_item.return_value = {'Item': form}
        before = datetime.now(UTC)
        response, payload = _submit(api_gateway_event, lambda_context, body)
        after = datetime.now(UTC)
        assert response['statusCode'] == 200
        sqs.send_message.assert_called_once()
        kwargs = sqs.send_message.call_args.kwargs
        assert kwargs['QueueUrl'] == QUEUE
        record = json.loads(kwargs['MessageBody'])
        assert before <= datetime.fromisoformat(record['created_at']) <= after
        assert record['ingested_at'] == record['created_at']
        return payload, record

    def test_a_form_that_collects_the_submitter_records_them(self, table, sqs, logger,
                                                             api_gateway_event, lambda_context):
        form = {**self.FORM, 'collect_email': True, 'collect_name': True, 'success_message': 'Ta'}
        payload, record = self._queued(table, sqs, api_gateway_event, lambda_context, form, self.BODY)
        assert payload == {'success': True, 'feedback_id': record['id'], 'message': 'Ta'}
        assert len(record['id']) == 36
        assert record == {
            'id': record['id'], 'source_platform': 'feedback_form', 'source_channel': f'form_{FORM_ID}',
            'text': 'late again', 'rating': 2, 'created_at': record['created_at'],
            'ingested_at': record['created_at'], 'brand_name': 'Acme', 'url': 'https://shop.example/p',
            'preset_category': 'delivery', 'preset_subcategory': 'late',
            'metadata': {'form_id': FORM_ID, 'form_name': 'Survey', 'form_version': '2.0',
                         'submitter_email': 'a@b.example', 'submitter_name': 'Ann',
                         'custom_fields': {'plan': 'pro'}},
            # No feedback_form profile stored: the allow policy, recorded.
            'pii_policy_applied': 'allow',
        }
        logger.info.assert_called_once_with(f"Submitted feedback to form {FORM_ID}: {record['id']}")

    def test_a_form_that_does_not_collect_them_drops_them(self, table, sqs, api_gateway_event, lambda_context):
        payload, record = self._queued(table, sqs, api_gateway_event, lambda_context,
                                       {'form_id': FORM_ID, 'enabled': True, 'brand_name': 'Acme'}, self.BODY)
        assert payload['message'] == 'Thank you for your feedback!'
        assert record['metadata'] == {'form_id': FORM_ID, 'form_name': '', 'form_version': '2.0',
                                      'custom_fields': {'plan': 'pro'}}
        assert (record['preset_category'], record['preset_subcategory']) == ('', '')

    def test_collecting_without_an_answer_records_nothing(self, table, sqs, api_gateway_event, lambda_context):
        form = {**self.FORM, 'collect_email': True, 'collect_name': True}
        _, record = self._queued(table, sqs, api_gateway_event, lambda_context, form, {'text': 'ok'})
        assert record['metadata'] == {'form_id': FORM_ID, 'form_name': 'Survey', 'form_version': '2.0'}
        assert (record['rating'], record['url']) == (None, None)

    @pytest.mark.parametrize('form', [{'form_id': FORM_ID}, {'form_id': FORM_ID, 'enabled': False}])
    @pytest.mark.usefixtures('sqs')
    def test_a_form_not_switched_on_refuses_by_name(self, table, api_gateway_event, lambda_context, form):
        table.get_item.return_value = {'Item': form}
        response, payload = _submit(api_gateway_event, lambda_context, {'text': 'ok'})
        assert response['statusCode'] == 400
        assert payload == {'success': False, 'error': 'This form is not enabled', 'code': 'form_off'}

    @pytest.mark.usefixtures('sqs')
    def test_a_body_that_is_not_an_object_is_refused_by_name(self, table, api_gateway_event, lambda_context):
        response, payload = _submit(api_gateway_event, lambda_context, ['text'])
        assert response['statusCode'] == 400
        assert payload == {'success': False, 'error': 'Request body must be a JSON object'}
        table.get_item.assert_not_called()

    @pytest.mark.usefixtures('sqs')
    def test_a_failed_form_read_is_a_named_500(self, table, api_gateway_event, lambda_context):
        table.get_item.side_effect = RuntimeError('boom')
        response, payload = _submit(api_gateway_event, lambda_context, {'text': 'ok'})
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': 'Failed to load form configuration'}

    def test_a_failed_enqueue_is_a_named_500(self, table, sqs, logger, api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': dict(self.FORM)}
        sqs.send_message.side_effect = RuntimeError('boom')
        response, payload = _submit(api_gateway_event, lambda_context, {'text': 'ok'})
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': 'Failed to submit feedback. Please try again.'}
        logger.exception.assert_called_once_with('Error submitting feedback: boom')


IFRAME_HEADERS = {
    'Content-Security-Policy': ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                                "connect-src 'self'; base-uri 'none'; form-action 'none'"),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
}


def _iframe_page(table, api_gateway_event, lambda_context, context: dict) -> dict:
    table.get_item.return_value = {'Item': {'form_id': FORM_ID}}
    event = api_gateway_event(method='GET', path=f'/feedback-forms/{FORM_ID}/iframe', path_params={'form_id': FORM_ID})
    event['requestContext'].pop('stage')
    event['requestContext'].update(context)
    with patch.object(h, '_widget_js_cache', 'WIDGET();'):
        return h.lambda_handler(event, lambda_context)


class TestTheIframePage:
    def test_a_script_value_is_json_with_the_html_specials_escaped(self):
        assert h._js_value('</b>&\u2028é') == '"\\u003c/b\\u003e\\u0026\\u2028\\u00e9"'

    def test_the_page_inlines_the_widget_and_inits_it_against_this_host(self, table, api_gateway_event,
                                                                       lambda_context):
        response = _iframe_page(table, api_gateway_event, lambda_context,
                                {'domainName': 'api.example', 'stage': 'prod'})
        assert response['statusCode'] == 200
        headers = {k: v[0] for k, v in response['multiValueHeaders'].items()} | (response.get('headers') or {})
        assert {k: headers[k] for k in IFRAME_HEADERS} == IFRAME_HEADERS
        assert headers['Content-Type'] == 'text/html'
        body = response['body']
        assert body.startswith('<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">')
        assert '<title>Feedback Form</title>' in body
        assert '<body>\n  <main id="voc-feedback-form"></main>\n  <script>\n  WIDGET();\n' in body
        options = ('{"container": "#voc-feedback-form", "apiEndpoint": "https://api.example/prod", '
                   f'"formId": "{FORM_ID}", "configEndpoint": "/feedback-forms/{FORM_ID}/config", '
                   f'"submitEndpoint": "/feedback-forms/{FORM_ID}/submit", '
                   f'"eventsEndpoint": "/feedback-forms/{FORM_ID}/events"}}')
        assert f'  VoCFeedbackForm.init({options});\n  </script>\n</body>\n</html>' in body
        assert body.endswith('</html>')

    def test_the_page_styles_only_itself_and_leaves_the_form_to_the_widget(self, table, api_gateway_event,
                                                                          lambda_context):
        """The widget ships its own reset inside its shadow root (7.55.01): the page keeps no copy of it, so the API's
        page, a script embed and the editor's preview draw the same form. Only the page's margins and the
        container's height are the page's."""
        body = _iframe_page(table, api_gateway_event, lambda_context, {'domainName': 'api.example'})['body']
        style = body.split('<style>', 1)[1].split('</style>', 1)[0]
        assert [line.strip() for line in style.strip().splitlines()] == [
            'html, body { margin: 0; }', '#voc-feedback-form { min-height: 100vh; }']

    def test_no_host_is_no_endpoint(self, table, api_gateway_event, lambda_context):
        body = _iframe_page(table, api_gateway_event, lambda_context, {})['body']
        assert '"apiEndpoint": ""' in body

    def test_no_stage_is_v1(self, table, api_gateway_event, lambda_context):
        body = _iframe_page(table, api_gateway_event, lambda_context, {'domainName': 'api.example'})['body']
        assert '"apiEndpoint": "https://api.example/v1"' in body

    def test_a_failed_existence_read_is_a_named_500(self, table, api_gateway_event, lambda_context):
        table.get_item.side_effect = RuntimeError('boom')
        response, payload = _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{FORM_ID}/iframe',
                                   path_params={'form_id': FORM_ID})
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': 'Failed to load form'}


class TestTheFormsPartition:
    @pytest.mark.parametrize(('form', 'deployment', 'pk'), [
        ({'brand_name': 'Acme'}, 'Dep', 'SOURCE#Acme'),
        ({'brand_name': ''}, 'Dep', 'SOURCE#Dep'),
        ({}, 'Dep', 'SOURCE#Dep'),
        ({}, '', 'SOURCE#feedback_form'),
    ])
    def test_the_forms_own_brand_then_the_deployments_then_the_channel(self, form, deployment, pk):
        with patch.object(h, 'BRAND_NAME', deployment):
            assert h._form_source_pk(form) == pk

    def test_a_failed_form_read_is_counted_logged_and_named(self, table, logger, metrics):
        table.get_item.side_effect = RuntimeError('boom')
        with pytest.raises(ServiceError) as exc:
            h._load_form_for_query(FORM_ID, 'the caller says')
        assert str(exc.value) == 'the caller says'
        metrics.add_metric.assert_called_once_with(name='FeedbackFormReadFailed', unit='Count', value=1)
        logger.exception.assert_called_once_with(f'Error fetching form {FORM_ID}: boom')

    def test_a_missing_form_is_not_found_by_its_key(self, table):
        table.get_item.return_value = {'Item': {}}
        with pytest.raises(NotFoundError) as exc:
            h._load_form_for_query(FORM_ID, 'unused')
        assert str(exc.value) == 'Form not found'
        table.get_item.assert_called_once_with(Key=FORM_KEY)


def _query(form_id: str = FORM_ID, **extra) -> dict:
    return {'KeyConditionExpression': Key('pk').eq('SOURCE#Acme'), 'FilterExpression': 'source_channel = :sc',
            'ExpressionAttributeValues': {':sc': f'form_{form_id}'}, **extra}


class TestTheSubmissionsRoute:
    def _get(self, table, api_gateway_event, lambda_context, query_params=None):
        table.get_item.return_value = {'Item': {'form_id': FORM_ID, 'brand_name': 'Acme'}}
        return _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{FORM_ID}/submissions',
                      path_params={'form_id': FORM_ID}, query_params=query_params)

    def test_each_row_is_projected_with_its_defaults(self, table, feedback, api_gateway_event, lambda_context):
        feedback.query.side_effect = [
            {'Items': [{'feedback_id': 'f1', 'original_text': 'slow', 'rating': 4, 'sentiment_label': 'negative',
                        'sentiment_score': '-0.5', 'category': 'delivery', 'source_created_at': '2026-01-01',
                        'persona_name': 'Ann'}], 'LastEvaluatedKey': {'k': 1}},
            {'Items': [{}]},
        ]
        response, payload = self._get(table, api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        assert payload == {
            'success': True, 'form_id': FORM_ID,
            'stats': {'total_submissions': 2, 'avg_rating': 4.0, 'rating_count': 1},
            'submissions': [
                {'feedback_id': 'f1', 'original_text': 'slow', 'rating': 4.0, 'sentiment_label': 'negative',
                 'sentiment_score': -0.5, 'category': 'delivery', 'created_at': '2026-01-01', 'persona_name': 'Ann'},
                {'feedback_id': '', 'original_text': '', 'rating': None, 'sentiment_label': '',
                 'sentiment_score': 0.0, 'category': '', 'created_at': '', 'persona_name': ''},
            ],
        }
        assert [c.kwargs for c in feedback.query.call_args_list] == [
            _query(ScanIndexForward=False), _query(ScanIndexForward=False, ExclusiveStartKey={'k': 1})]

    @pytest.mark.parametrize(('limit', 'returned'), [('2', 2), ('1', 1), (None, 3)])
    def test_paging_stops_at_the_limit_but_the_page_is_counted(self, table, feedback, api_gateway_event,
                                                              lambda_context, limit, returned):
        feedback.query.side_effect = [{'Items': [{}, {}, {}], 'LastEvaluatedKey': {'k': 1}}, {'Items': []}]
        _, payload = self._get(table, api_gateway_event, lambda_context, {'limit': limit} if limit else None)
        assert len(payload['submissions']) == returned
        assert payload['stats']['total_submissions'] == 3
        assert feedback.query.call_count == (2 if limit is None else 1)

    def test_a_limit_above_a_hundred_is_a_hundred(self, table, feedback, api_gateway_event, lambda_context):
        feedback.query.side_effect = [{'Items': [{}] * 101}]
        _, payload = self._get(table, api_gateway_event, lambda_context, {'limit': '500'})
        assert len(payload['submissions']) == 100

    def test_the_default_limit_is_fifty(self, table, feedback, api_gateway_event, lambda_context):
        feedback.query.side_effect = [{'Items': [{}] * 51}]
        _, payload = self._get(table, api_gateway_event, lambda_context)
        assert len(payload['submissions']) == 50

    def test_a_page_that_fills_the_limit_exactly_is_the_last_read(self, table, feedback, api_gateway_event,
                                                                  lambda_context):
        feedback.query.side_effect = [{'Items': [{}, {}, {}], 'LastEvaluatedKey': {'k': 1}}]
        response, payload = self._get(table, api_gateway_event, lambda_context, {'limit': '3'})
        assert response['statusCode'] == 200
        assert len(payload['submissions']) == 3
        feedback.query.assert_called_once()

    def test_a_failed_query_is_a_named_500(self, table, feedback, logger, api_gateway_event, lambda_context):
        feedback.query.side_effect = RuntimeError('boom')
        response, payload = self._get(table, api_gateway_event, lambda_context)
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': 'Failed to fetch submissions'}
        logger.exception.assert_called_once_with('Error fetching submissions: boom')

    def test_a_failed_form_read_names_the_route(self, table, feedback, api_gateway_event, lambda_context):
        table.get_item.side_effect = RuntimeError('boom')
        response, payload = _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{FORM_ID}/submissions',
                                   path_params={'form_id': FORM_ID})
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': 'Failed to fetch form'}
        feedback.query.assert_not_called()


@pytest.mark.usefixtures('metrics')
class TestTheStatsRoute:
    def _get(self, table, api_gateway_event, lambda_context):
        table.get_item.return_value = {'Item': {'form_id': FORM_ID, 'brand_name': 'Acme'}}
        return _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{FORM_ID}/stats',
                      path_params={'form_id': FORM_ID})

    def test_every_page_is_counted(self, table, feedback, api_gateway_event, lambda_context):
        feedback.query.side_effect = [{'Items': [{'rating': 5}], 'LastEvaluatedKey': {'k': 1}}, {'Items': [{}]}]
        _, payload = self._get(table, api_gateway_event, lambda_context)
        assert payload == {'success': True, 'form_id': FORM_ID,
                           'stats': {'total_submissions': 2, 'avg_rating': 5.0, 'rating_count': 1,
                                     'headline': _rating_headline(5.0)}}
        projection = 'feedback_id, rating, category, source_platform, metadata, source_created_at'
        assert [c.kwargs for c in feedback.query.call_args_list] == [
            _query(ProjectionExpression=projection),
            _query(ProjectionExpression=projection, ExclusiveStartKey={'k': 1})]

    def test_a_source_restricted_caller_counts_only_visible_submissions(self, table, feedback, api_gateway_event,
                                                                         lambda_context):
        feedback.query.side_effect = [{'Items': [{'rating': 4, 'source_platform': 'feedback_form'},
                                                 {'rating': 1, 'source_platform': 'support_tickets'}]}]
        with patch.object(h, 'scope_for_event', return_value=NO_TICKETS):
            _, payload = self._get(table, api_gateway_event, lambda_context)
        assert payload['stats'] == {'total_submissions': 1, 'avg_rating': 4.0, 'rating_count': 1,
                                    'headline': _rating_headline(4.0)}

    def test_a_failed_query_is_counted_logged_and_named(self, table, feedback, logger, metrics,
                                                         api_gateway_event, lambda_context):
        feedback.query.side_effect = RuntimeError('boom')
        response, payload = self._get(table, api_gateway_event, lambda_context)
        assert response['statusCode'] == 500
        assert payload == {'success': False, 'error': 'Failed to fetch form stats'}
        metrics.add_metric.assert_called_once_with(name='FeedbackFormStatsReadFailed', unit='Count', value=1)
        logger.exception.assert_called_once_with('Error fetching form stats: boom')

    def test_a_typed_failure_keeps_its_status_and_is_not_counted(self, table, feedback, metrics,
                                                                 api_gateway_event, lambda_context):
        feedback.query.side_effect = NotFoundError('gone')
        response, payload = self._get(table, api_gateway_event, lambda_context)
        assert (response['statusCode'], payload) == (404, {'success': False, 'error': 'gone'})
        metrics.add_metric.assert_not_called()

    def test_a_failed_form_read_names_the_route(self, table, feedback, api_gateway_event, lambda_context):
        table.get_item.side_effect = RuntimeError('boom')
        response, payload = _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{FORM_ID}/stats',
                                   path_params={'form_id': FORM_ID})
        assert (response['statusCode'], payload) == (500, {'success': False, 'error': 'Failed to fetch form stats'})
        feedback.query.assert_not_called()

    @pytest.mark.parametrize('route', ['stats', 'submissions'])
    def test_an_unconfigured_feedback_table_is_named(self, table, api_gateway_event, lambda_context, route):
        with patch.object(h, 'feedback_table', None):
            response, payload = _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{FORM_ID}/{route}',
                                       path_params={'form_id': FORM_ID})
        assert (response['statusCode'], payload) == (500, {'success': False,
                                                            'error': 'Feedback table not configured'})
        table.get_item.assert_not_called()


class TestEveryBoundAcceptsItsLimit:
    """The refusals above pin the far side of each bound; these pin the near side."""

    def test_every_editable_field_can_be_updated(self, table, api_gateway_event, lambda_context):
        table.update_item.return_value = {'Attributes': {}}
        body: dict[str, object] = {field: f'v-{field}' for field in h.UPDATABLE_FIELDS}
        # The two label fields are validated (against an empty dimensions config here), the theme too.
        body.update(dimension_defaults={}, tags=['t'], theme={'primary_color': '#8e48ff'})
        table.get_item.side_effect = lambda **kwargs: {'Item': dict(V2_ITEM)} if kwargs['Key'] == FORM_KEY else {}
        _route(api_gateway_event, lambda_context, 'PUT', f'/feedback-forms/{FORM_ID}',
               path_params={'form_id': FORM_ID}, body=body)
        kwargs = table.update_item.call_args.kwargs
        written = {kwargs['ExpressionAttributeNames'][name]: kwargs['ExpressionAttributeValues'][name.replace('#', ':')]
                   for name in kwargs['ExpressionAttributeNames'] if name.startswith('#f')}
        assert {field: written[field] for field in body} == body

    @pytest.mark.parametrize(('form_id', 'status'), [('a' * 64, 200), ('a' * 65, 404)])
    def test_a_form_id_is_at_most_64_characters(self, table, api_gateway_event, lambda_context, form_id, status):
        table.get_item.return_value = {'Item': {'form_id': form_id}}
        response, _ = _route(api_gateway_event, lambda_context, 'GET', f'/feedback-forms/{form_id}/config',
                             path_params={'form_id': form_id})
        assert response['statusCode'] == status

    @pytest.mark.parametrize(('stored', 'served'), [(1, 3), (0, 3), (10, 10), (11, 10), (6, 7)])
    def test_a_stored_rating_max_migrates_to_the_next_range_the_schema_has(self, stored, served):
        assert h.fv2.migrate_v1({'rating_max': stored})['questions'][0]['range'] == served

    @pytest.mark.parametrize('body', [
        {'text': 'x' * 10_000},
        {'text': 'ok', 'rating': 1},
        {'text': 'ok', 'rating': 10},
        {'text': 'ok', 'rating': 2.5},
        {'text': 'ok', 'custom_fields': {f'k{i}': None for i in range(20)}},
        {'text': 'ok', 'custom_fields': {'k' * 64: 'v' * 1000}},
        {'text': 'ok', 'custom_fields': {'on': True, 'n': 3, 'f': 2.5, 'none': None}},
    ])
    @pytest.mark.usefixtures('sqs')
    def test_a_submission_at_every_limit_is_accepted(self, table, api_gateway_event, lambda_context, body):
        table.get_item.return_value = {'Item': {'form_id': FORM_ID, 'enabled': True, 'brand_name': 'Acme'}}
        response, _ = _submit(api_gateway_event, lambda_context, body)
        assert response['statusCode'] == 200

    @pytest.mark.parametrize('rating', [True, 'five', [5]])
    @pytest.mark.usefixtures('sqs')
    def test_a_rating_that_is_not_a_number_is_refused(self, table, api_gateway_event, lambda_context, rating):
        response, payload = _submit(api_gateway_event, lambda_context, {'text': 'ok', 'rating': rating})
        assert response['statusCode'] == 400
        assert payload == {'success': False, 'error': 'rating must be null or a number from 1 to 10'}
        table.get_item.assert_not_called()
