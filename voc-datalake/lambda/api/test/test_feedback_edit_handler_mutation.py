"""Mutation hardening for `api/feedback_edit_handler.py` (``PUT /feedback/{id}/category``).

`test_feedback_edit_handler.py` pins the statuses of the route — 200 with the
stored override, 400 on a bad label, 404 when hidden, 409 on a lost update —
but a mutation run found behaviour it cannot see:

* the WORDING of every refusal: the 404 that answers both a missing item and a
  hidden category (`Feedback not found`, the same string so a restricted caller
  learns nothing), the 400s for a non-object body and for each missing or
  malformed label (which name the field: ``category`` vs ``subcategory``, and
  ``required``), and the 500s for an unconfigured table and a failed read;
* that ONE missing table is already a 500 (`or`, not `and`), naming the tables;
* the DynamoDB CALLS of the read: the by-id index query with ``Limit=1`` and the
  strongly consistent ``get_item`` of the hit's keys, plus the operator log line
  behind the read's 500;
* that the response is the row AS PERSISTED (``ReturnValues='ALL_NEW'``), under
  the exact four keys — not an echo of the request;
* the instrumentation: the route is the tracer's wrapper around the named
  function and the handler is wrapped by `api_handler` (a dropped decorator
  changed no HTTP answer).
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError, EndpointConnectionError
from category_access_fixtures import CATEGORIES_CONFIG, RESTRICTED_CLAIMS, RESTRICTED_SUB
from feedback_edit_fixtures import ADMIN_CLAIMS, ITEM, put_category, seeded_tables
from moto_helpers import invoke, rest_event

import feedback_edit_handler as h
from shared.category_access import access_key
from shared.indexes import FEEDBACK_BY_ID_INDEX
from shared.test.instrumentation_fixtures import assert_handler_wrapped

NOT_FOUND = 'Feedback not found'
READ_FAILED = 'Could not read feedback. Please retry.'
TABLES_UNCONFIGURED = 'Feedback tables not configured'
STORED_OVERRIDE = {'previous_category': 'delivery', 'previous_subcategory': 'late',
                   'by_sub': 'sub-admin', 'by_username': 'ada', 'at': '2026-02-02T02:02:02+00:00'}


@pytest.fixture
def tables() -> Any:
    yield from seeded_tables()


_put = put_category



def _assert_read_failed(tables, lambda_context, feedback: MagicMock) -> MagicMock:
    """``PUT`` against the ``feedback`` fake (whose read fails); assert the generic 500 and
    return the `logger.exception` spy."""
    _, aggregates = tables
    with patch.object(h.logger, 'exception') as log:
        status, body = _put((feedback, aggregates), lambda_context, {'category': 'billing'})
    assert (status, body) == (500, {'success': False, 'error': READ_FAILED})
    return log

def _put_raw(tables, lambda_context, raw_body: str):
    """``PUT`` with ``raw_body`` as the request body verbatim (not re-encoded)."""
    feedback, aggregates = tables
    event = rest_event('PUT', '/feedback/f1/category', claims=ADMIN_CLAIMS, path_params={'id': 'f1'})
    event['body'] = raw_body
    return invoke(h, event, lambda_context, feedback=feedback, aggregates=aggregates)


def _feedback_mock(*, hits: list[dict] | None = None, item: dict | None = ITEM) -> MagicMock:
    """A feedback table whose by-id query returns ``hits`` and whose ``get_item`` returns ``item``."""
    table = MagicMock()
    table.query.return_value = {'Items': [ITEM] if hits is None else hits}
    table.get_item.return_value = {'Item': item} if item is not None else {}
    return table


class TestEveryRefusalNamesItsCause:
    def test_a_missing_item_is_404_feedback_not_found(self, tables, lambda_context):
        status, body = _put(tables, lambda_context, {'category': 'billing'}, feedback_id='missing')
        assert (status, body) == (404, {'success': False, 'error': NOT_FOUND})

    @pytest.mark.parametrize('visible', [['delivery'], ['billing']])
    def test_a_hidden_current_or_new_category_is_the_same_404(self, tables, lambda_context, visible):
        _, aggregates = tables
        aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': visible})
        status, body = _put(tables, lambda_context, {'category': 'billing'}, claims=RESTRICTED_CLAIMS)
        assert (status, body) == (404, {'success': False, 'error': NOT_FOUND})

    @pytest.mark.parametrize('raw_body', ['[]', '"billing"', '7', 'null'])
    def test_a_non_object_body_is_400_and_names_the_shape(self, tables, lambda_context, raw_body):
        status, body = _put_raw(tables, lambda_context, raw_body)
        assert (status, body) == (400, {'success': False, 'error': 'Request body must be a JSON object'})

    @pytest.mark.parametrize(('request_body', 'message'), [
        ({}, 'category is required'),
        ({'category': ''}, 'category is required'),
        ({'category': None}, 'category is required'),
        ({'category': 7}, 'category must be a string of 1-64 characters'),
        ({'category': '   '}, 'category must be a string of 1-64 characters'),
        ({'category': 'x' * 65}, 'category must be a string of 1-64 characters'),
        ({'category': 'billing', 'subcategory': 7}, 'subcategory must be a string of 1-64 characters'),
        ({'category': 'billing', 'subcategory': 'y' * 65}, 'subcategory must be a string of 1-64 characters'),
        ({'category': 'unknown'}, 'category is not a configured category'),
    ])
    def test_each_bad_label_is_400_naming_the_field(self, tables, lambda_context, request_body, message):
        status, body = _put(tables, lambda_context, request_body)
        assert (status, body) == (400, {'success': False, 'error': message})
        stored = tables[0].get_item(Key={'pk': ITEM['pk'], 'sk': ITEM['sk']})['Item']
        assert stored['category'] == 'delivery'

    def test_an_empty_subcategory_is_optional_and_a_64_char_label_is_accepted(self, tables, lambda_context):
        _, aggregates = tables
        wide = 'w' * 64
        aggregates.put_item(Item={**CATEGORIES_CONFIG, 'categories': [{'name': 'delivery'}, {'name': wide}]})
        status, body = _put(tables, lambda_context, {'category': f'  {wide}  ', 'subcategory': ''})
        assert status == 200
        assert body['feedback']['category'] == wide
        assert body['feedback']['subcategory'] is None


class TestOneMissingTableIsAlreadyAFailure:
    @pytest.mark.parametrize('missing', ['feedback', 'aggregates'])
    def test_either_table_unconfigured_is_500_naming_the_tables(self, tables, lambda_context, missing):
        feedback, aggregates = tables
        present = {'feedback': feedback, 'aggregates': aggregates}
        present[missing] = None
        event = rest_event('PUT', '/feedback/f1/category', claims=ADMIN_CLAIMS,
                           body={'category': 'billing'}, path_params={'id': 'f1'})
        status, body = invoke(h, event, lambda_context, **present)
        assert (status, body) == (500, {'success': False, 'error': TABLES_UNCONFIGURED})
        # Refused before any read: the seeded item is untouched.
        assert feedback.get_item(Key={'pk': ITEM['pk'], 'sk': ITEM['sk']})['Item']['category'] == 'delivery'

    def test_both_tables_present_is_not_a_configuration_error(self, tables, lambda_context):
        status, body = _put(tables, lambda_context, {'category': 'billing'})
        assert status == 200
        assert body['success'] is True


class TestTheReadIsAnIndexedLookupThenAStrongRead:
    def test_the_by_id_query_asks_for_one_hit_and_the_get_item_is_strongly_consistent(self, tables, lambda_context):
        _, aggregates = tables
        feedback = _feedback_mock()
        feedback.update_item.return_value = {'Attributes': {**ITEM, 'category': 'billing'}}
        status, _ = _put((feedback, aggregates), lambda_context, {'category': 'billing'})
        assert status == 200
        feedback.query.assert_called_once_with(
            IndexName=FEEDBACK_BY_ID_INDEX, KeyConditionExpression=Key('feedback_id').eq('f1'), Limit=1)
        feedback.get_item.assert_called_once_with(Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}, ConsistentRead=True)
        assert feedback.update_item.call_args.kwargs['Key'] == {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}
        assert feedback.update_item.call_args.kwargs['ReturnValues'] == 'ALL_NEW'

    def test_no_hit_is_404_without_a_get_item(self, tables, lambda_context):
        _, aggregates = tables
        feedback = _feedback_mock(hits=[])
        status, body = _put((feedback, aggregates), lambda_context, {'category': 'billing'})
        assert (status, body) == (404, {'success': False, 'error': NOT_FOUND})
        feedback.get_item.assert_not_called()
        feedback.update_item.assert_not_called()

    def test_a_hit_whose_item_vanished_is_404_without_a_write(self, tables, lambda_context):
        _, aggregates = tables
        feedback = _feedback_mock(item=None)
        status, body = _put((feedback, aggregates), lambda_context, {'category': 'billing'})
        assert (status, body) == (404, {'success': False, 'error': NOT_FOUND})
        feedback.update_item.assert_not_called()

    @pytest.mark.parametrize('error', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}}, 'Query'),
        EndpointConnectionError(endpoint_url='https://dynamodb.test'),
    ])
    def test_a_failed_query_is_500_logged_and_never_echoes_aws(self, tables, lambda_context, error):
        feedback = _feedback_mock()
        feedback.query.side_effect = error
        log = _assert_read_failed(tables, lambda_context, feedback)
        # The read's own line first; the resolver's ServiceError handler logs the 500 after it.
        assert log.call_args_list == [call('Feedback read failed'), call(f'Service error: {READ_FAILED}')]
        feedback.update_item.assert_not_called()

    def test_a_failed_get_item_is_the_same_500(self, tables, lambda_context):
        feedback = _feedback_mock()
        feedback.get_item.side_effect = ClientError({'Error': {'Code': 'InternalServerError'}}, 'GetItem')
        log = _assert_read_failed(tables, lambda_context, feedback)
        assert log.call_args_list == [call('Feedback read failed'), call(f'Service error: {READ_FAILED}')]


class TestTheResponseIsTheRowAsPersisted:
    """``ReturnValues='ALL_NEW'``: the client sees what DynamoDB holds after the
    write, under exactly four keys — never a re-echo of the request."""

    def test_every_field_comes_from_the_returned_attributes(self, tables, lambda_context):
        _, aggregates = tables
        feedback = _feedback_mock()
        feedback.update_item.return_value = {'Attributes': {
            **ITEM, 'category': 'billing-as-stored', 'subcategory': 'refund-as-stored',
            'category_source': 'manual-as-stored', 'category_override': STORED_OVERRIDE,
        }}
        status, body = _put((feedback, aggregates), lambda_context, {'category': 'billing'})
        assert status == 200
        assert body == {'success': True, 'feedback': {
            'feedback_id': 'f1',
            'category': 'billing-as-stored',
            'subcategory': 'refund-as-stored',
            'category_source': 'manual-as-stored',
            'category_override': {'previous_category': 'delivery', 'previous_subcategory': 'late',
                                  'by_username': 'ada', 'at': '2026-02-02T02:02:02+00:00'},
        }}

    def test_without_returned_attributes_the_request_and_the_fresh_override_stand_in(self, tables, lambda_context):
        _, aggregates = tables
        feedback = _feedback_mock()
        feedback.update_item.return_value = {}
        status, body = _put((feedback, aggregates), lambda_context, {'category': 'billing'})
        assert status == 200
        feedback_body = body['feedback']
        assert set(feedback_body) == {'feedback_id', 'category', 'subcategory', 'category_source', 'category_override'}
        assert feedback_body['feedback_id'] == 'f1'
        assert feedback_body['category'] == 'billing'
        assert feedback_body['subcategory'] is None
        assert feedback_body['category_source'] == 'manual'
        override = feedback_body['category_override']
        assert override['previous_category'] == 'delivery'
        assert override['previous_subcategory'] == 'late'
        assert override['by_username'] == 'ada'
        assert 'by_sub' not in override
        # The override handed to DynamoDB is the one echoed back (same timestamp).
        written = feedback.update_item.call_args.kwargs['ExpressionAttributeValues'][':cat_o']
        assert written['at'] == override['at']
        assert written['by_sub'] == 'sub-admin'


class TestEveryEntryPointIsInstrumented:
    """The route is the tracer's wrapper around the named function; the handler
    carries `api_handler` (logger context, tracer, metrics). Each decorator leaves
    `__wrapped__` behind, so a dropped decorator is a missing attribute."""

    def test_the_route_is_the_tracer_wrapper_around_the_named_function(self):
        func = h.set_feedback_category
        assert func.__code__.co_filename.endswith(os.path.join('tracing', 'tracer.py'))
        assert vars(func)['__wrapped__'].__qualname__ == 'set_feedback_category'

    def test_the_handler_is_wrapped_and_injects_the_invocation_context_into_the_logger(self, tables):
        assert_handler_wrapped(h)
        # A plain object, not a MagicMock: Powertools reads `context.lambda_context`
        # whenever that attribute exists, and a MagicMock has every attribute.
        context = SimpleNamespace(
            function_name='voc-feedback-edit-under-test',
            memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-feedback-edit-under-test',
            aws_request_id='req-feedback-edit-mutation-0001',
            get_remaining_time_in_millis=lambda: 30_000,
        )
        status, body = _put(tables, context, {'category': 'billing'})
        assert status == 200
        assert body['feedback']['category'] == 'billing'
        keys = h.logger.get_current_keys()
        assert keys['function_name'] == 'voc-feedback-edit-under-test'
        assert keys['function_request_id'] == 'req-feedback-edit-mutation-0001'
