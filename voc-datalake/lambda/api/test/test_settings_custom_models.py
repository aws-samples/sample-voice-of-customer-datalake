"""The deployment's own models in Administration -> AI models (7.65.00): ``/settings/model`` and its Test route.

* ``GET`` lists them as ``custom_models`` (each with its surfaces, residency and price), and a surface's stored
  custom pick reads back only on a surface the model declares;
* ``PUT`` takes a custom model for a surface it declares, and refuses it elsewhere and for all surfaces;
* ``POST /settings/model/test`` takes a custom model and a ``probe`` (basic, json, tools); the image model and the
  web search models take basic only.
"""
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from test_settings_handler_mutation import aggregates_mock

from settings_handler import lambda_handler
from shared.custom_models import CUSTOM_MODELS_ENV
from shared.image_model_status import image_model_info
from shared.model_config import clear_model_cache
from shared.test.repo_paths import repo_root

REGISTRY = (repo_root() / 'lib' / 'test-support' / 'custom-models-env.json').read_text(encoding='utf-8')
NOVA = 'amazon.nova-pro-v1:0'
LLAMA = 'us.meta.llama3-3-70b-instruct-v1:0'
OPUS55 = 'global.anthropic.claude-opus-5-5'
LUNA = 'openai.gpt-5.6-luna'
MINE = 'arn:aws:bedrock:us-west-2:111111111111:imported-model/abc123def456'

table = pytest.fixture(aggregates_mock, name='table')


@pytest.fixture(autouse=True)
def _registry(monkeypatch):
    monkeypatch.setenv(CUSTOM_MODELS_ENV, REGISTRY)
    clear_model_cache()
    yield
    clear_model_cache()


@pytest.fixture
def route(api_gateway_event, lambda_context):
    """``(response, payload)`` of one request to the settings handler."""
    return lambda method, path, body=None: call_route(
        lambda_handler, api_gateway_event, lambda_context, method=method, path=path, body=body)


class TestTheList:
    def test_lists_the_custom_models_and_reads_a_pick_only_where_declared(self, route, table):
        table.get_item.side_effect = lambda Key: (
            {'Item': {'surfaces': {'documents': NOVA, 'chat': NOVA}}} if Key['pk'] == 'SETTINGS#model' else {})
        _, payload = route('GET', '/settings/model')
        assert [model['id'] for model in payload['custom_models']] == [NOVA, LLAMA,
                                                                        'arn:aws:bedrock:us-west-2:111111111111:imported-model/abc123def456']
        assert payload['custom_models'][0]['price'] == {'in': 0.8, 'out': 3.2}
        selected = {surface['key']: surface['selected'] for surface in payload['surfaces']}
        assert (selected['documents'], selected['chat']) == (NOVA, None)
        assert NOVA not in {model['id'] for model in payload['available_models']}

    def test_a_non_admin_reads_an_imported_model_by_its_key_and_label_only(self, api_gateway_event, lambda_context,
                                                                            table):
        # (review round 1 of the second gate, 7.66.00: an imported model's id is an ARN; its pick reads as its key)
        table.get_item.side_effect = lambda Key: (
            {'Item': {'surfaces': {'memory': MINE}}} if Key['pk'] == 'SETTINGS#model' else {})
        member = {'sub': 'sub-mo', 'cognito:groups': 'users', 'cognito:username': 'mo'}
        _, payload = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                                path='/settings/model', claims=member)
        rows = {row.get('key'): row for row in payload['custom_models']}
        assert rows['mine'] == {'key': 'mine', 'label': 'Example imported model'}
        assert rows['nova']['id'] == NOVA   # (a Bedrock model's id names no account)
        assert {surface['key']: surface['selected'] for surface in payload['surfaces']}['memory'] == 'mine'
        assert MINE not in repr(payload)
        _, admin = route_as_admin(api_gateway_event, lambda_context)
        assert MINE in repr(admin)

    def test_lists_none_without_the_registry(self, route, table, monkeypatch):
        monkeypatch.delenv(CUSTOM_MODELS_ENV)
        table.get_item.return_value = {}
        _, payload = route('GET', '/settings/model')
        assert payload['custom_models'] == []


def route_as_admin(api_gateway_event, lambda_context):
    return call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path='/settings/model')


class TestThePick:
    def test_saves_a_custom_model_for_a_surface_it_declares(self, route, table):
        table.get_item.return_value = {}
        response, payload = route('PUT', '/settings/model', {'surface': 'documents', 'model_id': NOVA})
        assert (response['statusCode'], payload['model_id']) == (200, NOVA)
        assert table.put_item.call_args.kwargs['Item']['surfaces'] == {'documents': NOVA}

    @pytest.mark.parametrize('body', [{'surface': 'agent_reviewer', 'model_id': NOVA}, {'model_id': LLAMA},
                                      {'surface': 'web_reviews_search', 'model_id': LLAMA}])
    def test_refuses_it_elsewhere_and_for_all_surfaces(self, route, table, body, monkeypatch):
        monkeypatch.setenv('WEB_SEARCH_MODELS_OFFERED', 'true')
        table.get_item.return_value = {}
        response, _ = route('PUT', '/settings/model', body)
        assert response['statusCode'] == 400
        table.put_item.assert_not_called()


class TestTheProbes:
    @pytest.mark.parametrize('probe', ['basic', 'json', 'tools'])
    @patch('settings_handler.model_capacity.probe_model')
    def test_probes_a_custom_model(self, probe_model, route, probe):
        probe_model.return_value = {'model_id': LLAMA, 'probe': probe, 'status': 'available'}
        response, payload = route('POST', '/settings/model/test', {'model_id': LLAMA, 'probe': probe})
        assert (response['statusCode'], payload['probe']) == (200, probe)
        probe_model.assert_called_once_with(LLAMA, probe)

    @patch('settings_handler.model_capacity.probe_model')
    def test_a_claude_model_takes_the_json_probe(self, probe_model, route):
        probe_model.return_value = {'model_id': OPUS55, 'status': 'available'}
        route('POST', '/settings/model/test', {'model_id': OPUS55, 'probe': 'json'})
        probe_model.assert_called_once_with(OPUS55, 'json')

    @pytest.mark.parametrize('body', [
        {'model_id': LLAMA, 'probe': 'vision'}, {'model_id': LLAMA, 'probe': ['json']},
        {'model_id': image_model_info()['id'], 'probe': 'json'}, {'model_id': LUNA, 'probe': 'tools'},
        {'model_id': 'amazon.nova-lite-v1:0'}, {'model_id': {'id': NOVA}, 'probe': 'json'},
    ])
    @patch('settings_handler.web_search_model_probe.probe_web_search_model')
    @patch('settings_handler.image_model_status.probe_image_model')
    @patch('settings_handler.model_capacity.probe_model')
    def test_refuses_an_unknown_probe_or_model_and_a_check_of_the_image_or_a_gpt_model(
            self, probe_model, image_probe, gpt_probe, route, body, monkeypatch):
        monkeypatch.setenv('WEB_SEARCH_MODELS_OFFERED', 'true')
        response, _ = route('POST', '/settings/model/test', body)
        assert response['statusCode'] == 400
        for probe in (probe_model, image_probe, gpt_probe):
            probe.assert_not_called()
