"""PUT /data-explorer/s3 under source profiles: no raw copy for a non-allow source, policy on the queued copy."""
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route

import data_explorer_handler as h
from shared.exceptions import ValidationError
from shared.test.source_profile_fixtures import no_source_profiles, seeded_source_profiles, unreadable_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

_PROFILES = [{'id': 'support_tickets', 'pii': 'redact'}]


@pytest.fixture
def redacting() -> Iterator[None]:
    with seeded_source_profiles(_PROFILES):
        yield


@pytest.mark.usefixtures('redacting')
def test_a_raw_object_for_a_redact_source_is_refused():
    with pytest.raises(ValidationError, match='keeps no raw copies'):
        h._refuse_policy_blocked_archive('raw/support_tickets/2026/01/01/x.json')


@pytest.mark.usefixtures('redacting')
@pytest.mark.parametrize('key', ['raw/webscraper/2026/x.json', 'exports/support_tickets/x.json', 'raw/x.json'])
def test_other_keys_are_allowed(key):
    assert h._refuse_policy_blocked_archive(key) is None


@pytest.mark.usefixtures('redacting')
def test_the_queued_copy_is_redacted_and_points_at_no_raw_object():
    message = h._policy_queue_message(
        {'id': 'x', 'source_platform': 'support_tickets', 'text': 'a@b.io', 'author': 'Ann'}, 'bkt', 'k.json')
    assert message == {'id': 'x', 'source_platform': 'support_tickets', 'text': '[EMAIL]',
                       'pii_policy_applied': 'redact'}


def test_an_allow_source_keeps_its_raw_uri():
    message = h._policy_queue_message({'text': 't'}, 'bkt', 'raw/webscraper/a.json')
    assert message == {'text': 't', 'pii_policy_applied': 'allow', 's3_raw_uri': 's3://bkt/raw/webscraper/a.json'}


@pytest.mark.usefixtures('redacting')
def test_the_route_refuses_before_writing(api_gateway_event, lambda_context):
    s3 = MagicMock()
    with patch.object(h, 's3_client', s3):
        response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                    path='/data-explorer/s3', body={
                                        'key': 'raw/support_tickets/2026/01/01/x.json', 'content': {'text': 't'}})
    assert response['statusCode'] == 400
    assert 'keeps no raw copies' in body['error']
    s3.put_object.assert_not_called()


def test_an_unreadable_policy_is_a_503_and_nothing_is_written(api_gateway_event, lambda_context):
    s3 = MagicMock()
    with unreadable_source_profiles(), patch.object(h, 's3_client', s3):
        response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                    path='/data-explorer/s3', body={
                                        'key': 'raw/support_tickets/2026/01/01/x.json', 'content': {'text': 't'}})
    assert (response['statusCode'], body['success']) == (503, False)
    s3.put_object.assert_not_called()
