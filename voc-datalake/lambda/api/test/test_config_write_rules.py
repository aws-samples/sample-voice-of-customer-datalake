"""Create-never-overwrites and stale-update refusals on POST /scrapers and POST /integrations/{source}/apps
(tenet 4; shared/config_write_guard.py, docs/scrapers.md → Write rules). Absent = the upsert."""
import json
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

import integrations_handler
import scrapers_handler
from shared import config_write_guard as guard
from shared.exceptions import ConflictError, NotFoundError, ValidationError

STORED_SCRAPER = {'id': 's1', 'name': 'Example Air reviews'}


def _scrapers(api_gateway_event, lambda_context, body, stored=(STORED_SCRAPER,)):
    secret = {'SecretString': json.dumps({'webscraper_configs': json.dumps(list(stored))})}
    with patch.object(scrapers_handler, 'secretsmanager') as client, \
            patch.object(scrapers_handler, 'put_secret_json') as put, \
            patch.object(scrapers_handler, 'validate_url', return_value=(True, '')):
        client.get_secret_value.return_value = secret
        response, answer = call_route(scrapers_handler.lambda_handler, api_gateway_event, lambda_context,
                                      method='POST', path='/scrapers', body=body)
    written = json.loads(put.call_args.args[2]['webscraper_configs']) if put.call_args else None
    return response['statusCode'], answer, written


def _apps(api_gateway_event, lambda_context, body, stored):
    secret = {'SecretString': json.dumps({'app_reviews_ios_configs': json.dumps(stored)})}
    with patch.object(integrations_handler, 'secretsmanager') as client, \
            patch.object(integrations_handler, 'put_secret_json') as put:
        client.get_secret_value.return_value = secret
        response, answer = call_route(integrations_handler.lambda_handler, api_gateway_event, lambda_context,
                                      method='POST', path='/integrations/app_reviews_ios/apps',
                                      path_params={'source': 'app_reviews_ios'}, body=body)
    return response['statusCode'], answer, put.called


class TestScrapers:
    def test_a_create_of_an_existing_id_is_409_and_writes_nothing(self, api_gateway_event, lambda_context):
        status, answer, written = _scrapers(api_gateway_event, lambda_context,
                                            {'scraper': {'id': 's1'}, 'mode': 'create'})
        assert status == 409
        assert 'never overwrites' in answer['error']
        assert written is None

    def test_an_update_of_a_missing_id_is_404(self, api_gateway_event, lambda_context):
        status, _, written = _scrapers(api_gateway_event, lambda_context, {'scraper': {'id': 'nope'}, 'mode': 'update'})
        assert (status, written) == (404, None)

    def test_a_stale_update_is_409(self, api_gateway_event, lambda_context):
        status, answer, written = _scrapers(api_gateway_event, lambda_context, {
            'scraper': {'id': 's1', 'name': 'B'}, 'mode': 'update', 'base_etag': 'not-the-etag'})
        assert status == 409
        assert 'changed since it was read' in answer['error']
        assert written is None

    def test_a_current_update_is_saved_without_its_etag(self, api_gateway_event, lambda_context):
        edited = {**STORED_SCRAPER, 'name': 'B', 'etag': guard.etag(STORED_SCRAPER)}
        status, _, written = _scrapers(api_gateway_event, lambda_context, {
            'scraper': edited, 'mode': 'update', 'base_etag': guard.etag(STORED_SCRAPER)})
        assert status == 200
        assert written == [{'id': 's1', 'name': 'B'}]

    def test_no_mode_is_the_upsert(self, api_gateway_event, lambda_context):
        status, _, written = _scrapers(api_gateway_event, lambda_context, {'scraper': {'id': 's1', 'name': 'C'}})
        assert (status, written) == (200, [{'id': 's1', 'name': 'C'}])

    def test_an_unknown_mode_is_400(self, api_gateway_event, lambda_context):
        status, _, _ = _scrapers(api_gateway_event, lambda_context, {'scraper': {'id': 's2'}, 'mode': 'replace'})
        assert status == 400

    def test_the_list_carries_each_etag(self, api_gateway_event, lambda_context):
        secret = {'SecretString': json.dumps({'webscraper_configs': json.dumps([STORED_SCRAPER])})}
        with patch.object(scrapers_handler, 'secretsmanager') as client:
            client.get_secret_value.return_value = secret
            _, answer = call_route(scrapers_handler.lambda_handler, api_gateway_event, lambda_context,
                                   method='GET', path='/scrapers')
        assert answer['scrapers'] == [{**STORED_SCRAPER, 'etag': guard.etag(STORED_SCRAPER)}]


class TestAppConnectors:
    STORED = [{'id': 'a1', 'app_name': 'Example Air', 'app_id': '123'}]

    @pytest.mark.parametrize('app', [
        {'app_name': ' example air ', 'app_id': '999'},
        {'app_name': 'Other', 'app_id': '123'},
        {'id': 'a1', 'app_name': 'Renamed'},
    ])
    def test_a_create_of_the_same_app_is_409(self, api_gateway_event, lambda_context, app):
        status, answer, written = _apps(api_gateway_event, lambda_context, {'app': app, 'mode': 'create'}, self.STORED)
        assert status == 409
        assert 'already exists' in answer['error']
        assert written is False

    def test_a_new_app_is_created(self, api_gateway_event, lambda_context):
        status, _, written = _apps(api_gateway_event, lambda_context,
                                   {'app': {'app_name': 'Other', 'app_id': '456'}, 'mode': 'create'}, self.STORED)
        assert (status, written) == (200, True)

    def test_a_stale_update_is_409(self, api_gateway_event, lambda_context):
        status, _, written = _apps(api_gateway_event, lambda_context, {
            'app': {'id': 'a1', 'app_name': 'X'}, 'mode': 'update', 'base_etag': 'old'}, self.STORED)
        assert (status, written) == (409, False)


class TestGuard:
    def test_the_etag_ignores_its_own_field(self):
        assert guard.etag({'id': 'x', 'etag': 'y'}) == guard.etag({'id': 'x'})

    def test_the_etag_ignores_key_order(self):
        assert guard.etag({'a': 1, 'b': 2}) == guard.etag({'b': 2, 'a': 1})

    def test_check_write(self):
        with pytest.raises(ConflictError):
            guard.check_write({'id': 'x'}, mode='create', base=None, what='X')
        with pytest.raises(NotFoundError):
            guard.check_write(None, mode='update', base=None, what='X')
        guard.check_write({'id': 'x'}, mode=None, base=None, what='X')

    def test_a_long_base_etag_is_400(self):
        with pytest.raises(ValidationError):
            guard.base_etag({'base_etag': 'x' * 65})
