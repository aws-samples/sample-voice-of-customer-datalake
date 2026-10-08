"""Mutation hardening for `api/projects_handler.py` lines 3718-4803 (ballot saves,
product context, source selection, prototype pins, generator jobs, the handler).

The suites that drive these routes — `test_projects_prioritization_ballots.py`,
`test_prototype_pins.py`,
`test_build_prototype_sources.py`, `test_visual_selection_boundary.py` — pin which write
happens and which status answers, but a mutation run over these lines found what they
could not see:

* the WORDING of every refusal. A `ValidationError` / `NotFoundError` / `ConflictError`
  reaches the client verbatim as `error`, and the earlier tests matched a fragment
  (`'no longer supported' in error`) or only the status, so every
  message is pinned here as a literal.
* the 404 a ballot save answers when the row vanished between the up-front read and the
  transaction (the row's own condition cancelled it), which no test had reached.
* the empty-save answer's `message`, the 405's whole body, and every route still wrapped
  by the tracer.
"""
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from ballots_fixtures import cancelled_transaction
from botocore.exceptions import ClientError
from build_prototype_fixtures import build_prototype_against
from handler_events_fixtures import call_route, keyed_get_item, project_meta_table
from test_projects_prioritization_ballots import (
    AXES,
    FakeAggregatesTable,
    _call,
    _event,
    _patch_scores,
)

import projects_handler
from projects_handler import (
    BALLOT_TRANSACT_ROW_INDEX,
    MAX_BALLOTS_PER_SAVE,
    MAX_CHAT_CONTEXT_LAMBDA_RESPONSE_BYTES,
    MAX_SELECTED_PRODUCT_DOC_IDS,
    MAX_SELECTED_RESEARCH_IDS,
    _bounded_chat_context_response,
    lambda_handler,
)
from shared import project_access, prototype_pins
from shared.row_ids import MAX_KEY_SEGMENT_ID_LEN
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped

ROW_GONE = (
    'scores name a row that does not exist; reload the page to get the current rows'
)


class TestEveryRouteIsTraced:
    @pytest.mark.parametrize('route', [
        'api_put_prioritization_scores',
        'api_patch_prioritization_scores',
    ])
    def test_the_route_is_the_tracer_wrapper(self, route):
        assert_tracer_wrapped(projects_handler, route)


class TestTheRetiredWholeMapOverwrite:
    def test_the_405_body_says_what_to_do_instead(self, api_gateway_event, lambda_context):
        retired_put = _event(api_gateway_event, method='PUT', body={'scores': {'row-9': {}}})
        status, body = _call(FakeAggregatesTable(), retired_put, lambda_context)

        assert status == 405
        assert body == {
            'success': False,
            'error': 'PUT /projects/prioritization is no longer supported; '
                     "PATCH the caller's own scores instead",
        }


class TestEveryBallotRefusalNamesItsCause:
    @pytest.mark.parametrize(('scores', 'error'), [
        ({'': AXES}, 'scores keys must be non-empty row id strings'),
        ({'row#1': AXES}, "scores keys must not contain '#', the sort-key delimiter"),
        ({'r' * (MAX_KEY_SEGMENT_ID_LEN + 1): AXES},
         f'scores keys must be at most {MAX_KEY_SEGMENT_ID_LEN} characters'),
        ({'row-1': AXES, ' row-1 ': AXES},
         'scores keys must be distinct row ids; two keys differing '
         'only in surrounding whitespace address the same ballot'),
        ({f'row-{n}': AXES for n in range(MAX_BALLOTS_PER_SAVE + 1)},
         f'scores may carry at most {MAX_BALLOTS_PER_SAVE} rows per save'),
    ])
    def test_a_malformed_body_is_a_400_with_its_reason(
        self, api_gateway_event, lambda_context, scores, error
    ):
        status, body = _patch_scores(FakeAggregatesTable(), api_gateway_event, lambda_context,
                                     scores, seed_rows=False)

        assert (status, body['error']) == (400, error)

    @pytest.mark.parametrize('scores', [['row-1'], 'row-1', 7])
    def test_a_non_object_scores_is_a_400(self, api_gateway_event, lambda_context, scores):
        status, body = _call(
            FakeAggregatesTable(),
            _event(api_gateway_event, method='PATCH', body={'scores': scores}),
            lambda_context,
        )

        assert (status, body['error']) == (400, 'scores must be an object keyed by row id')

    def test_an_empty_save_says_there_was_nothing_to_do(self, api_gateway_event, lambda_context):
        status, body = _call(
            FakeAggregatesTable(),
            _event(api_gateway_event, method='PATCH', body={'scores': {}}),
            lambda_context,
        )

        assert (status, body) == (200, {'success': True, 'message': 'No changes to save'})


class TestARowDeletedUnderTheSaveIsA404:
    """The row was there for the up-front read and gone by the transaction: the row's
    own condition (at BALLOT_TRANSACT_ROW_INDEX) cancelled the write. Same fact, same
    404, as the up-front pass gives."""

    def test_the_rows_condition_failing_is_the_row_gone_404(
        self, api_gateway_event, lambda_context
    ):
        aggregates = FakeAggregatesTable().seed_rows('row-1', project_id='p1')
        reasons = [{'Code': 'None'}] * (BALLOT_TRANSACT_ROW_INDEX + 1)
        reasons[BALLOT_TRANSACT_ROW_INDEX] = {'Code': 'ConditionalCheckFailed'}

        def cancel(**_kwargs):
            raise cancelled_transaction(reasons)

        aggregates.meta.client.transact_write_items = cancel
        with patch('projects_handler.logger'):
            status, body = _patch_scores(aggregates, api_gateway_event, lambda_context,
                                         {'row-1': AXES}, subject='alice', seed_rows=False)

        assert (status, body['error']) == (404, ROW_GONE)


class TestTheSaveBeforeAndAfterItsWrites:
    def test_a_row_missing_up_front_is_the_row_gone_404(self, api_gateway_event, lambda_context):
        status, body = _patch_scores(FakeAggregatesTable(), api_gateway_event, lambda_context,
                                     {'row-1': AXES}, seed_rows=False)

        assert (status, body['error']) == (404, ROW_GONE)

    def test_no_aggregates_table_is_a_500_naming_it(self, api_gateway_event, lambda_context):
        status, body = _call(
            None, _event(api_gateway_event, method='PATCH', body={'scores': {'row-1': AXES}}),
            lambda_context,
        )

        assert (status, body['error']) == (500, 'Aggregates table not configured')

    def test_a_failure_part_way_logs_how_far_the_save_got(self, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable().seed_rows('row-1', 'row-2', 'row-3')
        commit = aggregates.meta.client.transact_write_items
        writes = MagicMock(side_effect=[commit, commit, RuntimeError('throttled')])

        def third_write_fails(**kwargs):
            return writes()(**kwargs)

        aggregates.meta.client.transact_write_items = third_write_fails
        with patch('projects_handler.logger') as logger:
            status, body = _patch_scores(
                aggregates, api_gateway_event, lambda_context,
                {'row-1': AXES, 'row-2': AXES, 'row-3': AXES}, seed_rows=False,
            )

        assert (status, body['error']) == (500, 'Failed to save prioritization scores')
        logger.exception.assert_called_once_with(
            'Failed to save prioritization ballot after 2 of 3 rows: throttled'
        )


# ---- Product context and the synchronous AI assists ------------------------

P123 = '/projects/proj-123'
BODY = {'k': 'v'}


@pytest.mark.usefixtures('existing_project')
class TestTheProductContextRoutesDelegate:
    """Each route is wired at its path and hands the delegate exactly its arguments."""

    @pytest.mark.parametrize(('method', 'path', 'delegate', 'args'), [
        ('GET', f'{P123}/product-context', 'pc_get_context', ('proj-123',)),
        ('PUT', f'{P123}/product-context', 'pc_update_context', ('proj-123', BODY)),
        ('POST', f'{P123}/product-context/interview', 'pc_interview_turn', ('proj-123', BODY)),
        ('GET', f'{P123}/product-docs', 'pc_list_docs', ('proj-123',)),
        ('POST', f'{P123}/product-docs/upload-url', 'pc_create_upload_url', ('proj-123', BODY)),
        ('DELETE', f'{P123}/product-docs/doc-9', 'pc_delete_doc', ('proj-123', 'doc-9')),
    ])
    def test_the_route_reaches_its_delegate(
        self, api_gateway_event, lambda_context, method, path, delegate, args
    ):
        with patch(f'projects_handler.{delegate}', return_value={'ok': delegate}) as handler:
            response, answer = call_route(lambda_handler, api_gateway_event, lambda_context,
                                          method=method, path=path, body=BODY)

        assert (response['statusCode'], answer) == (200, {'ok': delegate})
        handler.assert_called_once_with(*args)

    @pytest.mark.parametrize(('path', 'delegate', 'sent', 'received'), [
        ('prfaq-autofill', 'autofill_prfaq_questions', None, {}),
        ('research/suggest-questions', 'suggest_research_questions', None, {}),
        ('documents/suggest-brief', 'suggest_document_brief', None, {}),
        ('research/suggest-questions', 'suggest_research_questions', BODY, BODY),
        ('documents/suggest-brief', 'suggest_document_brief', BODY, BODY),
    ])
    def test_an_ai_assist_gets_the_body_and_the_callers_scope(
        self, api_gateway_event, lambda_context, path, delegate, sent, received
    ):
        with patch(f'projects_handler.{delegate}', return_value={'ok': True}) as handler, \
                patch('projects_handler._caller_category_scope', return_value={'all': True}):
            response, _ = call_route(lambda_handler, api_gateway_event, lambda_context,
                                     method='POST', path=f'{P123}/{path}', body=sent)

        assert response['statusCode'] == 200
        handler.assert_called_once_with('proj-123', received, category_scope={'all': True})

    @pytest.mark.parametrize('route', [
        'api_get_product_context', 'api_update_product_context', 'api_product_context_interview',
        'api_list_product_docs', 'api_create_product_doc_upload_url', 'api_delete_product_doc',
        'api_autofill_prfaq_questions', 'api_suggest_research_questions',
        'api_suggest_document_brief', 'list_prototype_pins', 'reply_to_prototype_pin',
        'resolve_prototype_pin', 'reopen_prototype_pin', 'mark_prototype_pins_addressed',
        'resolve_addressed_prototype_pins', 'api_build_prototype', 'api_generate_product_report',
    ])
    def test_the_route_is_the_tracer_wrapper(self, route):
        assert_tracer_wrapped(projects_handler, route)


# ---- Build-prototype source selection ---------------------------------------

BUILD = '/projects/proj-1/build-prototype'
LONGEST_ID = 'p' * MAX_KEY_SEGMENT_ID_LEN


def _build(api_gateway_event, lambda_context, body, documents=None):
    """`(status, answer, job_config)` for one build of proj-1 holding `documents` (by sk)."""
    held = {('PROJECT#proj-1', sk): {'document_id': sk} for sk in documents or ()}
    response, config, _, _, _ = build_prototype_against(
        held, body, api_gateway_event, lambda_context, project_id='proj-1', path=BUILD,
    )
    return response['statusCode'], json.loads(response['body']), config


class TestEverySourceRefusalNamesItsField:
    @pytest.mark.parametrize(('body', 'status', 'error'), [
        ({'source_prd_id': 7}, 400, 'source_prd_id must be a document id string'),
        ({'source_prd_id': LONGEST_ID + 'p'}, 400, 'source_prd_id is not a valid document id'),
        ({'source_prfaq_id': 'gone'}, 404, 'source_prfaq_id: no such document in this project'),
        ({'use_research': True, 'selected_research_ids': 'r'}, 400,
         'selected_research_ids must be a list of document ids'),
        ({'use_research': True, 'selected_research_ids': ['r'] * (MAX_SELECTED_RESEARCH_IDS + 1)},
         400, f'selected_research_ids names more than {MAX_SELECTED_RESEARCH_IDS} documents'),
        ({'selected_product_doc_ids': 'd'}, 400,
         'selected_product_doc_ids must be a list of document ids'),
        ({'selected_product_doc_ids': ['d'] * (MAX_SELECTED_PRODUCT_DOC_IDS + 1)}, 400,
         f'selected_product_doc_ids names more than {MAX_SELECTED_PRODUCT_DOC_IDS} documents'),
    ])
    def test_the_refusal_names_the_field(self, api_gateway_event, lambda_context, body, status,
                                         error):
        answered, answer, config = _build(api_gateway_event, lambda_context, body)

        assert (answered, answer['error'], config) == (status, error, None)

    def test_an_id_at_the_length_bound_is_still_a_document_id(
        self, api_gateway_event, lambda_context
    ):
        status, _, config = _build(api_gateway_event, lambda_context,
                                   {'source_prd_id': LONGEST_ID}, documents=[f'PRD#{LONGEST_ID}'])

        assert status == 200
        assert config is not None
        assert config['source_prd_id'] == LONGEST_ID


# ---- Prototype pins ----------------------------------------------------------

DOC = 'proto_1'
PINS = f'/projects/proj-1/prototypes/{DOC}/pins'
PIN = prototype_pins.new_pin_id(datetime(2026, 1, 1, tzinfo=UTC))
AGENT_CLAIMS = {'sub': 'agent:ag_1', 'cognito:groups': '', 'email': 'agent:ag_1',
                project_access.ACTING_SUBJECT_CLAIM: 'owner-sub'}


def _pins_projects_table(*, prototype=True):
    """proj-1 owned by `owner-sub`, holding prototype `DOC` unless `prototype=False`."""
    items = {('PROJECT#proj-1', 'META'): {'pk': 'PROJECT#proj-1', 'sk': 'META',
                                          'owner_sub': 'owner-sub', 'visibility': 'private'}}
    if prototype:
        items['PROJECT#proj-1', f'PROTOTYPE#{DOC}'] = {'pk': 'PROJECT#proj-1'}
    table = MagicMock()
    table.get_item.side_effect = keyed_get_item(items)
    return table


def _pin_route(api_gateway_event, lambda_context, method, path, *, body=None, query=None,
               claims=None, projects=None):
    """`(status, answer)` for one pin route, the aggregates table a fresh MagicMock."""
    with patch('projects_handler.get_projects_table',
               return_value=projects if projects is not None else _pins_projects_table()), \
            patch('projects_handler.get_aggregates_table', return_value=MagicMock()):
        response, answer = call_route(lambda_handler, api_gateway_event, lambda_context,
                                      method=method, path=path, body=body, query_params=query,
                                      claims=claims)
    return response['statusCode'], answer


class TestEveryPinRefusalNamesItsCause:
    def test_a_malformed_document_id(self, api_gateway_event, lambda_context):
        status, answer = _pin_route(api_gateway_event, lambda_context, 'GET',
                                    '/projects/proj-1/prototypes/bad.id/pins')

        assert (status, answer['error']) == (400, 'Invalid document id')

    def test_a_missing_prototype(self, api_gateway_event, lambda_context):
        status, answer = _pin_route(api_gateway_event, lambda_context, 'GET', PINS,
                                    projects=_pins_projects_table(prototype=False))

        assert (status, answer['error']) == (404, 'Prototype not found')

    def test_no_projects_table(self, api_gateway_event, lambda_context):
        with patch('projects_handler._project_access_for'), \
                patch('projects_handler.get_projects_table', return_value=None):
            response, answer = call_route(lambda_handler, api_gateway_event, lambda_context,
                                          method='GET', path=PINS)

        assert (response['statusCode'], answer['error']) == (500, 'Projects table not configured')

    def test_no_aggregates_table(self, api_gateway_event, lambda_context):
        with patch('projects_handler.get_projects_table', return_value=_pins_projects_table()), \
                patch('projects_handler.get_aggregates_table', return_value=None):
            response, answer = call_route(lambda_handler, api_gateway_event, lambda_context,
                                          method='GET', path=PINS)

        assert (response['statusCode'], answer['error']) == (
            500, 'Aggregates table not configured')

    def test_an_unknown_status_filter(self, api_gateway_event, lambda_context):
        status, answer = _pin_route(api_gateway_event, lambda_context, 'GET', PINS,
                                    query={'status': 'closed'})

        assert (status, answer['error']) == (400, 'status must be open, addressed or resolved')

    def test_a_malformed_pin_id(self, api_gateway_event, lambda_context):
        status, answer = _pin_route(api_gateway_event, lambda_context, 'POST',
                                    f'{PINS}/not-a-pin/resolve')

        assert (status, answer['error']) == (400, 'Invalid pin id')

    @pytest.mark.parametrize(('action', 'shared', 'error'), [
        ('resolve', 'set_status', 'The pin does not exist or cannot move to that state'),
        ('replies', 'append_reply', 'The pin does not exist or its thread is full'),
    ])
    def test_a_failed_condition_is_a_409(self, api_gateway_event, lambda_context, action, shared,
                                         error):
        failure = ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')
        with patch(f'projects_handler.prototype_pins.{shared}', side_effect=failure):
            status, answer = _pin_route(api_gateway_event, lambda_context, 'POST',
                                        f'{PINS}/{PIN}/{action}', body={'text': 'Fixed it'})

        assert (status, answer['error']) == (409, error)


class TestThePinAnswers:
    def test_the_list(self, api_gateway_event, lambda_context):
        with patch('projects_handler.prototype_pins.list_pins',
                   return_value=[{'pin_id': PIN}]) as list_pins:
            status, answer = _pin_route(api_gateway_event, lambda_context, 'GET', PINS,
                                        query={'status': 'open'})

        form_id = prototype_pins.pin_form_id(DOC)
        assert (status, answer) == (200, {'form_id': form_id, 'document_id': DOC, 'count': 1,
                                          'pins': [{'pin_id': PIN}]})
        assert list_pins.call_args.args[1:] == (form_id, 'open')

    @pytest.mark.parametrize('action', ['resolve', 'reopen'])
    def test_a_status_change(self, api_gateway_event, lambda_context, action):
        with patch('projects_handler.prototype_pins.set_status', return_value={'pin_id': PIN}):
            status, answer = _pin_route(api_gateway_event, lambda_context, 'POST',
                                        f'{PINS}/{PIN}/{action}')

        assert (status, answer) == (200, {'success': True, 'pin': {'pin_id': PIN}})

    @pytest.mark.parametrize(('claims', 'by', 'name'), [
        ({'sub': 'u-1', 'cognito:groups': 'admins', 'cognito:username': 'n' * 130},
         'u-1', 'n' * 120),
        ({'sub': 'u-1', 'cognito:groups': 'admins'}, 'u-1', 'Reviewer'),
        (AGENT_CLAIMS, 'agent:ag_1', 'Autonomous agent'),
    ])
    def test_a_reply_names_who_wrote_it(self, api_gateway_event, lambda_context, claims, by,
                                        name):
        with patch('projects_handler.prototype_pins.append_reply',
                   return_value={'pin_id': PIN}) as append_reply:
            status, answer = _pin_route(api_gateway_event, lambda_context, 'POST',
                                        f'{PINS}/{PIN}/replies', body={'text': 'Fixed it'},
                                        claims=claims)

        assert (status, answer) == (200, {'success': True, 'pin': {'pin_id': PIN}})
        reply = append_reply.call_args.args[3]
        written_at = reply.pop('at')
        assert reply == {'by': by, 'name': name, 'text': 'Fixed it'}
        assert datetime.now(UTC) - datetime.fromisoformat(written_at) < timedelta(minutes=1)


class TestThePinStatusMoves:
    def test_reopening_clears_what_addressed_it(self, api_gateway_event, lambda_context):
        with patch('projects_handler.prototype_pins.set_status',
                   return_value={'pin_id': PIN}) as set_status:
            _pin_route(api_gateway_event, lambda_context, 'POST', f'{PINS}/{PIN}/reopen')

        assert set_status.call_args.kwargs['extra'] == {'addressed_by': None}

    @pytest.mark.parametrize('revision', [None, 7, 'bad.id', ''])
    def test_marking_addressed_needs_a_revision_id(self, api_gateway_event, lambda_context,
                                                   revision):
        status, answer = _pin_route(api_gateway_event, lambda_context, 'POST',
                                    f'{PINS}/addressed',
                                    body={'pin_ids': [PIN], 'revision_document_id': revision})

        assert (status, answer['error']) == (400, 'revision_document_id is required')


# ---- Generator jobs ------------------------------------------------------------

FULL_BUILD = {
    'title': 'Checkout', 'response_language': 'ko', 'brand': 'UNNI', 'feedback': 'Too slow',
    'source_prd_id': 'prd_1', 'base_prototype_id': 'proto_1', 'use_product_context': True,
}


class TestTheGeneratorJobs:
    def test_a_build_records_and_hands_off_the_whole_config(
        self, api_gateway_event, lambda_context
    ):
        held = {('PROJECT#proj-1', sk): {'document_id': sk} for sk in ('PRD#prd_1',
                                                                       'PROTOTYPE#proto_1')}
        with patch('projects_handler.DOCUMENT_GENERATOR_FUNCTION', 'doc-gen'):
            response, config, _, invoke, create_job = build_prototype_against(
                held, FULL_BUILD, api_gateway_event, lambda_context, project_id='proj-1',
                path=BUILD,
            )

        expected = {
            'doc_type': 'build_prototype', 'title': 'Checkout', 'response_language': 'ko',
            'brand': 'UNNI', 'feedback': 'Too slow', 'base_prototype_id': 'proto_1',
            'source_prd_id': 'prd_1', 'source_prfaq_id': None, 'use_product_context': True,
            'use_research': False, 'selected_research_ids': [], 'selected_product_doc_ids': [],
        }
        assert config == expected
        create_job.assert_called_once_with('proj-1', 'build_prototype', 'doc_config', expected,
                                           initiated_by='test-user-id', status='pending')
        invoke.assert_called_once_with(
            'doc-gen', {'project_id': 'proj-1', 'job_id': 'job_1', 'doc_config': expected})
        assert json.loads(response['body']) == {
            'success': True, 'job_id': 'job_1', 'status': 'pending',
            'message': 'Prototype build started.',
        }

    def test_a_bad_base_prototype_id_names_its_field(self, api_gateway_event, lambda_context):
        status, answer, _ = _build(api_gateway_event, lambda_context, {'base_prototype_id': 7})

        assert (status, answer['error']) == (400, 'base_prototype_id must be a document id string')

    @pytest.mark.parametrize(('body', 'title', 'language'), [
        (None, 'Product description report', None),
        ({'title': '', 'response_language': 'ko'}, 'Product description report', 'ko'),
        ({'title': 'Q3 report'}, 'Q3 report', None),
    ])
    def test_a_product_report(self, api_gateway_event, lambda_context, body, title, language):
        with patch('projects_handler.get_projects_table',
                   return_value=project_meta_table('proj-1')), \
                patch('projects_handler.create_job', return_value=('job_2', {})) as create_job, \
                patch('projects_handler.invoke_lambda_async'):
            response, answer = call_route(lambda_handler, api_gateway_event, lambda_context,
                                          method='POST', path='/projects/proj-1/product-report',
                                          body=body)

        assert response['statusCode'] == 200
        assert create_job.call_args.args == (
            'proj-1', 'generate_product_report', 'doc_config',
            {'doc_type': 'product_report', 'title': title, 'response_language': language},
        )
        assert answer == {'success': True, 'job_id': 'job_2', 'status': 'pending',
                          'message': 'Product report generation started.'}


# ---- The chat-context response bound and the handler ---------------------------

# `{"statusCode":200,"body":""}` is 28 bytes in compact JSON, so this body makes the
# whole result exactly MAX_CHAT_CONTEXT_LAMBDA_RESPONSE_BYTES.
AT_THE_BOUND = 'x' * (MAX_CHAT_CONTEXT_LAMBDA_RESPONSE_BYTES - 28)
CHAT_CONTEXT = {'path': '/projects/p1/chat-context'}
TOO_LARGE = {
    'statusCode': 413,
    'headers': {'X-Trace': 't', 'Content-Type': 'application/json'},
    'isBase64Encoded': False,
    'body': json.dumps({'message': 'Selected project context is too large. '
                                   'Select fewer or smaller documents.'}),
}


class TestTheChatContextBound:
    def test_exactly_at_the_bound_passes(self):
        result = {'statusCode': 200, 'body': AT_THE_BOUND}

        assert _bounded_chat_context_response(CHAT_CONTEXT, result) is result

    def test_one_byte_over_is_the_413_keeping_the_headers(self):
        result = {'statusCode': 200, 'body': AT_THE_BOUND + 'x', 'headers': {'X-Trace': 't'}}

        assert _bounded_chat_context_response(CHAT_CONTEXT, result) == TOO_LARGE

    @pytest.mark.parametrize(('event', 'status'), [
        ({'path': '/projects/p1/documents'}, 200),
        (CHAT_CONTEXT, 300),
        (CHAT_CONTEXT, 199),
    ])
    def test_only_a_successful_chat_context_answer_is_bounded(self, event, status):
        result = {'statusCode': status, 'body': AT_THE_BOUND + 'x'}

        assert _bounded_chat_context_response(event, result) is result

    def test_the_last_success_status_is_still_bounded(self):
        result = {'statusCode': 299, 'body': AT_THE_BOUND + 'x'}

        assert _bounded_chat_context_response(CHAT_CONTEXT, result)['statusCode'] == 413


class TestTheHandler:
    def test_it_keeps_its_decorator(self):
        assert_handler_wrapped(projects_handler)

    def test_it_logs_the_status_code_only(self, api_gateway_event, lambda_context):
        with patch('projects_handler.logger') as logger:
            response = lambda_handler(api_gateway_event(method='GET', path='/nowhere'),
                                      lambda_context)

        logger.info.assert_called_once_with(
            'Returning response', extra={'status_code': response['statusCode']})

    def test_an_unexpected_failure_is_a_generic_500(self, api_gateway_event, lambda_context):
        with patch.object(projects_handler.app, 'resolve', side_effect=RuntimeError('boom')), \
                patch('projects_handler.logger') as logger:
            response = lambda_handler(api_gateway_event(), lambda_context)

        assert response == {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With,'
                                                'X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            },
            'body': json.dumps({'error': 'Internal server error',
                                'message': 'An unexpected error occurred.'}),
        }
        logger.exception.assert_called_once_with('Lambda handler error: boom')
