"""The web search surface in Administration -> AI models (7.42.00): ``/settings/model`` and its Test route.

* ``GET`` lists ``web_reviews_search`` last, picking from ``web_search_models`` (``allowlist: web_search``), only
  while the settings Lambda says a deployed plugin reads with it (``WEB_SEARCH_MODELS_OFFERED``);
* ``PUT`` holds each surface to its own list: a GPT model for it, a Claude model for every other surface and for
  the pick for all surfaces;
* ``POST /settings/model/test`` with a GPT model sends the mantle probe (shared/web_search_model_probe.py), never
  the Converse one, and only while the surface is offered.
"""
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route

import settings_handler
from settings_handler import lambda_handler
from shared.model_config import ALLOWED_MODEL_IDS, WEB_SEARCH_MODEL_IDS, WEB_SEARCH_MODELS

LUNA = 'openai.gpt-5.6-luna'
SOL = 'openai.gpt-5.6-sol'
SONNET55 = 'global.anthropic.claude-sonnet-5-5'


@pytest.fixture
def table():
    mock = MagicMock()
    mock.get_item.return_value = {}
    with patch.object(settings_handler, 'aggregates_table', mock):
        yield mock


@pytest.fixture
def offered(monkeypatch):
    monkeypatch.setenv('WEB_SEARCH_MODELS_OFFERED', 'true')


@pytest.fixture
def route(api_gateway_event, lambda_context):
    def _call(method, path, body=None):
        return call_route(lambda_handler, api_gateway_event, lambda_context, method=method, path=path, body=body)
    return _call


class TestTheList:
    @pytest.mark.usefixtures('offered')
    def test_the_surface_is_last_with_its_own_models_and_luna_by_default(self, route, table):
        table.get_item.side_effect = lambda Key: (
            {'Item': {'surfaces': {'web_reviews_search': SOL, 'chat': SOL}}} if Key['pk'] == 'SETTINGS#model' else {})
        _, payload = route('GET', '/settings/model')
        last = payload['surfaces'][-1]
        assert last == {'key': 'web_reviews_search', 'default_id': LUNA, 'selected': SOL, 'allowlist': 'web_search'}
        assert payload['web_search_models'] == WEB_SEARCH_MODELS
        assert {s['allowlist'] for s in payload['surfaces'][:-1]} == {'claude'}
        chat = next(s for s in payload['surfaces'] if s['key'] == 'chat')
        assert chat['selected'] is None  # a GPT model stored for a Claude surface is not its pick
        assert not {m['id'] for m in payload['available_models']} & WEB_SEARCH_MODEL_IDS

    @pytest.mark.usefixtures('offered')
    def test_a_claude_model_stored_for_it_reads_as_automatic(self, route, table):
        table.get_item.side_effect = lambda Key: (
            {'Item': {'surfaces': {'web_reviews_search': SONNET55}}} if Key['pk'] == 'SETTINGS#model' else {})
        _, payload = route('GET', '/settings/model')
        assert payload['surfaces'][-1]['selected'] is None

    @pytest.mark.usefixtures('table')
    def test_absent_while_no_deployed_plugin_reads_with_it(self, route, monkeypatch):
        monkeypatch.delenv('WEB_SEARCH_MODELS_OFFERED', raising=False)
        _, payload = route('GET', '/settings/model')
        assert 'web_reviews_search' not in [s['key'] for s in payload['surfaces']]
        assert payload['web_search_models'] == []


class TestSavingAPick:
    @pytest.mark.usefixtures('offered')
    def test_a_gpt_model_for_the_surface_is_saved(self, route, table):
        response, payload = route('PUT', '/settings/model', {'surface': 'web_reviews_search', 'model_id': SOL})
        assert (response['statusCode'], payload['model_id']) == (200, SOL)
        assert table.put_item.call_args.kwargs['Item']['surfaces'] == {'web_reviews_search': SOL}

    @pytest.mark.usefixtures('offered')
    def test_a_claude_model_for_the_surface_is_refused_naming_its_models(self, route, table):
        response, payload = route('PUT', '/settings/model', {'surface': 'web_reviews_search', 'model_id': SONNET55})
        assert response['statusCode'] == 400
        assert payload['error'] == f"model_id must be null or one of: {', '.join(sorted(WEB_SEARCH_MODEL_IDS))}"
        table.put_item.assert_not_called()

    @pytest.mark.usefixtures('offered')
    @pytest.mark.parametrize('surface', ['chat', 'enrichment', None])
    def test_a_gpt_model_for_any_other_surface_or_for_all_is_refused(self, route, table, surface):
        response, payload = route('PUT', '/settings/model', {'surface': surface, 'model_id': LUNA})
        assert response['statusCode'] == 400
        assert payload['error'] == f"model_id must be null or one of: {', '.join(sorted(ALLOWED_MODEL_IDS))}"
        table.put_item.assert_not_called()

    def test_the_surface_is_refused_while_it_is_not_offered(self, route, table, monkeypatch):
        monkeypatch.delenv('WEB_SEARCH_MODELS_OFFERED', raising=False)
        response, payload = route('PUT', '/settings/model', {'surface': 'web_reviews_search', 'model_id': LUNA})
        assert response['statusCode'] == 400
        assert payload['error'].startswith('surface must be null or one of: chat, ')
        assert 'web_reviews_search' not in payload['error']
        table.put_item.assert_not_called()


class TestTheTestRoute:
    @pytest.mark.usefixtures('offered')
    @patch('settings_handler.model_capacity.probe_model')
    @patch('settings_handler.web_search_model_probe.probe_web_search_model')
    def test_a_gpt_model_gets_the_mantle_probe(self, mantle, converse, route):
        mantle.return_value = {'model_id': SOL, 'status': 'available', 'ok': True}
        response, payload = route('POST', '/settings/model/test', {'model_id': SOL})
        assert (response['statusCode'], payload['status']) == (200, 'available')
        mantle.assert_called_once_with(SOL)
        converse.assert_not_called()

    @patch('settings_handler.web_search_model_probe.probe_web_search_model')
    def test_a_gpt_model_is_refused_while_the_surface_is_not_offered(self, mantle, route, monkeypatch):
        monkeypatch.delenv('WEB_SEARCH_MODELS_OFFERED', raising=False)
        response, payload = route('POST', '/settings/model/test', {'model_id': LUNA})
        assert response['statusCode'] == 400
        assert LUNA not in payload['error']
        mantle.assert_not_called()

    @pytest.mark.usefixtures('offered')
    @patch('settings_handler.web_search_model_probe.probe_web_search_model')
    def test_the_refusal_names_the_gpt_models_while_offered(self, mantle, route):
        response, payload = route('POST', '/settings/model/test', {'model_id': 'openai.gpt-4o'})
        assert response['statusCode'] == 400
        assert ', '.join(sorted(WEB_SEARCH_MODEL_IDS)) in payload['error']
        mantle.assert_not_called()
