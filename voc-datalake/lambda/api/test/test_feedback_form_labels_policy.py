"""Feedback forms: dimension defaults + tags on the config, widget `dimensions`, source PII policy."""
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route

import feedback_form_handler as h
from shared.source_profiles import SourceProfilesUnavailable
from shared.test.source_profile_fixtures import no_source_profiles, seeded_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

FORM_ID = 'f1'
DIMENSIONS_ROW = {'pk': 'SETTINGS#dimensions', 'sk': 'config', 'dimensions': [
    {'key': 'product', 'values': [{'name': 'app'}, {'name': 'web'}]},
    {'key': 'user_type', 'values': [{'name': 'customer'}, {'name': 'partner'}]},
]}
FORM = {'form_id': FORM_ID, 'enabled': True, 'brand_name': 'Acme', 'collect_name': True, 'collect_email': True,
        'dimension_defaults': {'product': 'app', 'user_type': 'customer'}, 'tags': ['survey']}


class Wired:
    """The form handler's aggregates table and queue client, both patched."""

    def __init__(self, table: MagicMock, queue: MagicMock) -> None:
        self.table = table
        self.queue = queue


@pytest.fixture
def wired() -> Iterator[Wired]:
    table, queue = MagicMock(), MagicMock()
    with patch.multiple(h, aggregates_table=table, sqs=queue, PROCESSING_QUEUE_URL='q'):
        yield Wired(table, queue)


@pytest.fixture
def table(wired: Wired) -> MagicMock:
    return wired.table


@pytest.fixture
def sqs(wired: Wired) -> MagicMock:
    return wired.queue


def _route(event, context, method, path, **kwargs):
    return call_route(h.lambda_handler, event, context, method=method, path=path, **kwargs)


def _submit(event, context, body):
    return _route(event, context, 'POST', f'/feedback-forms/{FORM_ID}/submit', path_params={'form_id': FORM_ID},
                  body=body)


def _queued(sqs: MagicMock) -> dict:
    return json.loads(sqs.send_message.call_args.kwargs['MessageBody'])


def test_form_defaults_win_over_widget_dimensions_and_form_tags_travel(
        table, sqs, api_gateway_event, lambda_context):
    table.get_item.return_value = {'Item': FORM}
    response, _ = _submit(api_gateway_event, lambda_context,
                          {'text': 'hi', 'dimensions': {'user_type': 'partner', 'bad key': 'x'}})
    record = _queued(sqs)
    assert response['statusCode'] == 200
    assert (record['dimensions'], record['tags']) == ({'product': 'app', 'user_type': 'customer'}, ['survey'])


def test_the_widget_may_set_only_keys_the_form_has_no_default_for(table, sqs, api_gateway_event, lambda_context):
    table.get_item.return_value = {'Item': {**FORM, 'dimension_defaults': {'product': 'app'}}}
    _submit(api_gateway_event, lambda_context, {'text': 'hi', 'dimensions': {'product': 'web', 'user_type': 'partner'}})
    assert _queued(sqs)['dimensions'] == {'product': 'app', 'user_type': 'partner'}


def test_an_unreadable_source_policy_is_a_503_and_nothing_is_queued(table, sqs, api_gateway_event, lambda_context):
    table.get_item.return_value = {'Item': FORM}
    with patch.object(h, 'cached_source_profile_strict', side_effect=SourceProfilesUnavailable):
        response, payload = _submit(api_gateway_event, lambda_context, {'text': 'hi'})
    assert (response['statusCode'], payload['success']) == (503, False)
    assert 'retry' in payload['error']
    sqs.send_message.assert_not_called()


def test_a_policy_that_returns_nothing_is_a_400_not_the_unpoliced_record(
        table, sqs, api_gateway_event, lambda_context):
    table.get_item.return_value = {'Item': FORM}
    with patch.object(h, 'apply_source_policy', return_value=None):
        response, _ = _submit(api_gateway_event, lambda_context, {'text': 'hi'})
    assert response['statusCode'] == 400
    sqs.send_message.assert_not_called()


def test_the_submitter_email_is_lower_cased_at_intake(table, sqs, api_gateway_event, lambda_context):
    table.get_item.return_value = {'Item': FORM}
    _submit(api_gateway_event, lambda_context, {'text': 'hi', 'email': ' Ann@X.Example '})
    assert _queued(sqs)['metadata']['submitter_email'] == 'ann@x.example'


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize('dimensions', [['product'], 'product:app', {f'k{i}': 'v' for i in range(11)}])
def test_malformed_widget_dimensions_are_400(sqs, api_gateway_event, lambda_context, dimensions):
    response, _ = _submit(api_gateway_event, lambda_context, {'text': 'hi', 'dimensions': dimensions})
    assert response['statusCode'] == 400
    sqs.send_message.assert_not_called()


def test_a_redact_profile_redacts_the_submission_before_it_is_queued(table, sqs, api_gateway_event, lambda_context):
    table.get_item.return_value = {'Item': FORM}
    with seeded_source_profiles([{'id': 'feedback_form', 'pii': 'redact'}]):
        _submit(api_gateway_event, lambda_context,
                {'text': 'mail me at ann@x.example', 'name': 'Ann', 'email': 'ann@x.example'})
    record = _queued(sqs)
    assert (record['text'], record['pii_policy_applied']) == ('mail me at [EMAIL]', 'redact')
    assert record['metadata']['submitter_email'] == '[EMAIL]'
    assert 'submitter_name' not in record['metadata']


def test_create_validates_and_normalises_labels(table, api_gateway_event, lambda_context):
    table.get_item.return_value = {'Item': DIMENSIONS_ROW}
    response, payload = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms',
                               body={'name': 'N', 'dimension_defaults': {'product': 'web'}, 'tags': ['a', 'A']})
    assert response['statusCode'] == 200
    assert (payload['form']['dimension_defaults'], payload['form']['tags']) == ({'product': 'web'}, ['a'])


@pytest.mark.parametrize(('body', 'needle'), [
    ({'dimension_defaults': {'product': 'tv'}}, '"tv" is not a value'),
    ({'dimension_defaults': {'module': 'x'}}, 'unknown dimension'),
    ({'tags': ['a#b']}, 'Tags must be'),
])
def test_update_refuses_bad_labels(table, api_gateway_event, lambda_context, body, needle):
    table.get_item.return_value = {'Item': DIMENSIONS_ROW}
    response, payload = _route(api_gateway_event, lambda_context, 'PUT', f'/feedback-forms/{FORM_ID}',
                               path_params={'form_id': FORM_ID}, body=body)
    assert response['statusCode'] == 400
    assert needle in payload['error']
    table.update_item.assert_not_called()


def test_an_unreadable_dimensions_config_is_a_500(table, api_gateway_event, lambda_context):
    table.get_item.return_value = {'Item': {'dimensions': 'corrupt'}}
    response, _ = _route(api_gateway_event, lambda_context, 'POST', '/feedback-forms', body={'tags': ['a']})
    assert response['statusCode'] == 500
    table.put_item.assert_not_called()


def test_widget_config_does_not_publish_the_labels():
    assert not {'dimension_defaults', 'tags'} & set(h.item_to_widget_config(FORM))
