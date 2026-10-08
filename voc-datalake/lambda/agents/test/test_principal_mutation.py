"""Mutation hardening for `agents/principal.py`.

`test_runtime_units.py` round-trips the claims through `project_access` and
pins one `RouteError` by status; `test_prototype_pins_flow.py` only checks that
every pin call is the agent principal. A mutation run found everything else
unobserved:

* the claims dict itself — the ``email`` key, the empty ``cognito:groups``, the
  ``''`` defaults that keep the owner / acting claims OFF the dict, the exact
  ``agent record has no agent_id`` refusal (and that an EMPTY id is refused like
  a missing one), and the ``,`` that joins the editor subs;
* the route transport — the exact ``DomainCall`` each helper sends (env var
  names ``PROJECTS_FUNCTION`` / ``METRICS_FUNCTION`` / ``MEMORY_FUNCTION``, the
  ``''`` function name when the env var is unset, ``query`` / ``path_parameters``
  normalised to ``{}``, the ``project_id`` / ``job_id`` path-parameter keys, and
  the 20-document clip of ``selected_document_ids``);
* the error mapping — ``message`` is read before ``error``, clipped to exactly
  300 characters, the ``HTTP <status>`` fallback, and the three ``502 … was
  malformed`` refusals (a non-dict body is refused as well as a dict without a
  ``project``).

Every expectation here is the literal string, number, key or call the module
emits.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from agents import principal
from shared import project_access
from shared.mcp_delegate import DelegationUnavailable, DomainCall, DomainResult

# What `agent_claims` yields for a bare row — and the claims every route call below carries.
CLAIMS = {'sub': 'agent:ag_1', 'cognito:groups': '', 'email': 'agent:ag_1'}


class TestClaimsDeriveOnlyFromTheAgentRow:
    def test_the_minimal_row_yields_exactly_sub_groups_and_email(self):
        assert principal.agent_claims({'agent_id': 'ag_1'}) == CLAIMS

    def test_every_claim_is_the_literal_key_and_value(self):
        claims = principal.agent_claims({'agent_id': 'ag_1', 'owner_sub': 'human-o'},
                                        owner_sub='human-po', editor_subs=('e1', 'e2'))
        assert claims == {
            'sub': 'agent:ag_1',
            'cognito:groups': '',
            'email': 'agent:ag_1',
            'voc:acting_subject': 'human-o',
            'voc:agent_owner_sub': 'human-po',
            'voc:agent_editor_subs': 'e1,e2',
        }

    @pytest.mark.parametrize('agent', [
        {'agent_id': ''},
        {'agent_id': None},
        {'agent_id': 7},
        {'owner_sub': 'o'},
    ], ids=['empty', 'none', 'int', 'missing'])
    def test_a_missing_or_empty_agent_id_is_refused_by_name(self, agent):
        with pytest.raises(DelegationUnavailable) as raised:
            principal.agent_claims(agent)
        assert str(raised.value) == 'agent record has no agent_id'

    @pytest.mark.parametrize('row', [
        {'agent_id': 'ag_1'},
        {'agent_id': 'ag_1', 'owner_sub': None},
        {'agent_id': 'ag_1', 'owner_sub': 42},
        {'agent_id': 'ag_1', 'owner_sub': ''},
    ], ids=['absent', 'none', 'int', 'empty'])
    def test_no_usable_owner_sub_means_no_acting_claim(self, row):
        claims = principal.agent_claims(row)
        assert project_access.ACTING_SUBJECT_CLAIM not in claims
        assert project_access.AGENT_OWNER_CLAIM not in claims
        assert project_access.AGENT_EDITORS_CLAIM not in claims

    @pytest.mark.parametrize('synthetic', ['agent:ag_2', 'mcp:tok'])
    def test_a_synthetic_owner_is_never_forwarded_as_acting_or_owner(self, synthetic):
        claims = principal.agent_claims({'agent_id': 'ag_1', 'owner_sub': synthetic}, owner_sub=synthetic)
        assert claims == CLAIMS

    def test_editors_are_comma_joined_in_order_and_capped_at_ten(self):
        editors = tuple(f'e{n}' for n in range(12))
        claims = principal.agent_claims({'agent_id': 'ag_1'}, editor_subs=editors)
        assert claims['voc:agent_editor_subs'] == 'e0,e1,e2,e3,e4,e5,e6,e7,e8,e9'

    def test_editors_that_cannot_be_forwarded_are_dropped_before_the_cap(self):
        claims = principal.agent_claims(
            {'agent_id': 'ag_1'}, editor_subs=('', 'a,b', 'mcp:t', 'agent:ag_2', 'e1'))
        assert claims['voc:agent_editor_subs'] == 'e1'

    def test_only_unforwardable_editors_means_no_editors_claim(self):
        claims = principal.agent_claims({'agent_id': 'ag_1'}, editor_subs=('', 'mcp:t'))
        assert 'voc:agent_editor_subs' not in claims


def _domain(result: DomainResult):
    return patch.object(principal, 'call_domain', return_value=result)


@pytest.fixture
def projects_function(monkeypatch) -> str:
    monkeypatch.setenv('PROJECTS_FUNCTION', 'fn-projects')
    return 'fn-projects'


class TestEveryHelperSendsTheExactDomainCall:
    @pytest.mark.parametrize(('helper', 'env_name', 'function_name'), [
        (principal.projects, 'PROJECTS_FUNCTION', 'fn-projects'),
        (principal.metrics, 'METRICS_FUNCTION', 'fn-metrics'),
        (principal.memory, 'MEMORY_FUNCTION', 'fn-memory'),
    ])
    def test_each_domain_reads_its_own_env_var(self, monkeypatch, helper, env_name, function_name):
        for name in ('PROJECTS_FUNCTION', 'METRICS_FUNCTION', 'MEMORY_FUNCTION'):
            monkeypatch.setenv(name, f'wrong-{name}')
        monkeypatch.setenv(env_name, function_name)
        with _domain(DomainResult(200, {'ok': True})) as call_domain:
            assert helper('GET', '/x', CLAIMS) == {'ok': True}
        call_domain.assert_called_once_with(
            DomainCall(function_name=function_name, method='GET', path='/x',
                       path_parameters={}, query={}, body=None),
            claims=CLAIMS)

    def test_an_unset_env_var_sends_the_empty_function_name(self, monkeypatch):
        monkeypatch.delenv('METRICS_FUNCTION', raising=False)
        with _domain(DomainResult(200, {})) as call_domain:
            principal.metrics('GET', '/metrics/summary', CLAIMS)
        assert call_domain.call_args.args[0].function_name == ''

    def test_absent_query_and_path_parameters_become_empty_dicts(self):
        with _domain(DomainResult(200, {})) as call_domain:
            principal.call('PROJECTS_FUNCTION', 'POST', '/p', CLAIMS, body={'a': 1})
        sent = call_domain.call_args.args[0]
        assert (sent.query, sent.path_parameters, sent.body) == ({}, {}, {'a': 1})

    def test_given_query_and_path_parameters_are_forwarded_unchanged(self):
        with _domain(DomainResult(200, {})) as call_domain:
            principal.call('PROJECTS_FUNCTION', 'GET', '/p', CLAIMS,
                           query={'days': 7}, path_parameters={'project_id': 'p1'})
        sent = call_domain.call_args.args[0]
        assert (sent.query, sent.path_parameters, sent.body) == ({'days': 7}, {'project_id': 'p1'}, None)

    def test_get_project_sends_the_project_id_path_parameter(self, projects_function):
        payload = {'project': {'project_id': 'p1'}, 'personas': []}
        with _domain(DomainResult(200, payload)) as call_domain:
            assert principal.get_project('p1', CLAIMS) == payload
        call_domain.assert_called_once_with(
            DomainCall(function_name=projects_function, method='GET', path='/projects/p1',
                       path_parameters={'project_id': 'p1'}, query={}, body=None),
            claims=CLAIMS)

    def test_get_job_sends_both_path_parameters(self, projects_function):
        with _domain(DomainResult(200, {'status': 'done'})) as call_domain:
            assert principal.get_job('p1', 'j1', CLAIMS) == {'status': 'done'}
        call_domain.assert_called_once_with(
            DomainCall(function_name=projects_function, method='GET', path='/projects/p1/jobs/j1',
                       path_parameters={'project_id': 'p1', 'job_id': 'j1'}, query={}, body=None),
            claims=CLAIMS)

    def test_chat_context_posts_the_first_twenty_document_ids(self, projects_function):
        document_ids = [f'doc_{n:02d}' for n in range(25)]
        with _domain(DomainResult(200, {'personas': []})) as call_domain:
            assert principal.chat_context('p1', CLAIMS, document_ids) == {'personas': []}
        call_domain.assert_called_once_with(
            DomainCall(function_name=projects_function, method='POST', path='/projects/p1/chat-context',
                       path_parameters={'project_id': 'p1'}, query={},
                       body={'selected_document_ids': document_ids[:20]}),
            claims=CLAIMS)
        assert len(call_domain.call_args.args[0].body['selected_document_ids']) == 20

    def test_chat_context_with_twenty_ids_sends_all_of_them(self):
        document_ids = [f'doc_{n:02d}' for n in range(20)]
        with _domain(DomainResult(200, {})) as call_domain:
            principal.chat_context('p1', CLAIMS, document_ids)
        assert call_domain.call_args.args[0].body == {'selected_document_ids': document_ids}


class TestEveryRouteErrorNamesItsCause:
    @pytest.mark.parametrize('status', [200, 201, 204, 299])
    def test_any_2xx_returns_the_payload(self, status):
        with _domain(DomainResult(status, {'x': 1})):
            assert principal.call('PROJECTS_FUNCTION', 'GET', '/p', CLAIMS) == {'x': 1}

    @pytest.mark.parametrize('status', [199, 300, 404, 500])
    def test_any_non_2xx_raises_with_that_status(self, status):
        with _domain(DomainResult(status, {})), pytest.raises(principal.RouteError) as raised:
            principal.call('PROJECTS_FUNCTION', 'GET', '/p', CLAIMS)
        assert raised.value.status_code == status

    @pytest.mark.parametrize(('payload', 'message'), [
        ({'message': 'Project not found'}, 'Project not found'),
        ({'error': 'You do not have permission'}, 'You do not have permission'),
        ({'message': 'first', 'error': 'second'}, 'first'),
        ({'message': 7, 'error': 'typed one wins'}, 'typed one wins'),
        ({'detail': 'ignored'}, 'HTTP 404'),
        ({}, 'HTTP 404'),
        ('plain text', 'HTTP 404'),
        (None, 'HTTP 404'),
        (['message'], 'HTTP 404'),
    ])
    def test_the_message_is_the_routes_own_or_the_http_status(self, payload, message):
        with _domain(DomainResult(404, payload)), pytest.raises(principal.RouteError) as raised:
            principal.projects('GET', '/projects/p1', CLAIMS)
        assert (raised.value.status_code, str(raised.value)) == (404, message)

    @pytest.mark.parametrize(('length', 'kept'), [(299, 299), (300, 300), (301, 300), (900, 300)])
    def test_the_message_is_clipped_to_exactly_three_hundred_characters(self, length, kept):
        with (
            _domain(DomainResult(400, {'message': 'm' * length})),
            pytest.raises(principal.RouteError) as raised,
        ):
            principal.projects('GET', '/projects/p1', CLAIMS)
        assert str(raised.value) == 'm' * kept

    def test_the_status_code_attribute_is_the_constructor_argument(self):
        error = principal.RouteError(409, 'conflict')
        assert (error.status_code, str(error), error.args) == (409, 'conflict', ('conflict',))


class TestMalformedBodiesAreRefusedAs502:
    @pytest.mark.parametrize('payload', [
        None, [], 'text', 7,
        {}, {'project': None}, {'project': 'p1'}, {'project': ['p1']},
    ], ids=['none', 'list', 'str', 'int', 'empty', 'project-none', 'project-str', 'project-list'])
    def test_get_project_needs_a_project_dict(self, payload):
        with _domain(DomainResult(200, payload)), pytest.raises(principal.RouteError) as raised:
            principal.get_project('p1', CLAIMS)
        assert (raised.value.status_code, str(raised.value)) == (502, 'project response was malformed')

    @pytest.mark.parametrize('payload', [None, [], 'text', 7], ids=['none', 'list', 'str', 'int'])
    def test_get_job_needs_a_dict(self, payload):
        with _domain(DomainResult(200, payload)), pytest.raises(principal.RouteError) as raised:
            principal.get_job('p1', 'j1', CLAIMS)
        assert (raised.value.status_code, str(raised.value)) == (502, 'job response was malformed')

    def test_get_job_accepts_any_dict(self):
        with _domain(DomainResult(200, {})):
            assert principal.get_job('p1', 'j1', CLAIMS) == {}

    @pytest.mark.parametrize('payload', [None, [], 'text', 7], ids=['none', 'list', 'str', 'int'])
    def test_chat_context_needs_a_dict(self, payload):
        with _domain(DomainResult(200, payload)), pytest.raises(principal.RouteError) as raised:
            principal.chat_context('p1', CLAIMS, ['doc_1'])
        assert (raised.value.status_code, str(raised.value)) == (502, 'chat-context response was malformed')

    def test_a_route_failure_is_reported_before_shape_checking(self):
        with (
            _domain(DomainResult(404, {'message': 'Project not found'})),
            pytest.raises(principal.RouteError) as raised,
        ):
            principal.get_project('p1', CLAIMS)
        assert (raised.value.status_code, str(raised.value)) == (404, 'Project not found')
