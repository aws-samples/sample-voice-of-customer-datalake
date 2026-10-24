"""Mutation hardening for `shared/mcp_delegate.py`.

`test_mcp_delegation.py` and `test_mcp_security.py` reach this module through the
MCP handler, so they pin what a tool call ANSWERS — a 404 becomes a tool error, a
5xx a -32603, the claims come from the row — and a mutation run found 48 statements
that answer the same way whichever way they are written:

* the dedicated Lambda client. Every test stubs `get_delegate_lambda_client`, so
  the 20 s read timeout, 3 s connect timeout and single attempt that the module's
  own comment argues for were never asserted; the cache could start non-`None`
  (so no client is ever built) or never fill (so one is built per call).
* the synthesized proxy event as a WHOLE: `resource`, `stage: 'v1'`, the
  `Content-Type` header, and a request body that is serialized only when present.
* the exact wording of every `DelegationUnavailable`, and the exact
  `logger.exception` / `logger.error` call for a transport fault or an upstream
  `FunctionError` — the handler maps all of these onto one fixed client message,
  so the handler tests cannot tell them apart.
* decoding: an empty body is `None` not `''`, a non-JSON body is passed through
  as text, a `statusCode` that is not an int (or a payload that is not a proxy
  response at all) is refused, and `ok` is exactly `200 <= status < 300`.
* the dataclasses are frozen with `{}` defaults, and `DomainCall.body` defaults
  to `None` so no route is sent an empty-string body.
"""
from __future__ import annotations

import dataclasses
import io
import json
import typing
from unittest.mock import MagicMock, patch

import pytest
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError

import shared.mcp_delegate as mcp_delegate
from shared.mcp_delegate import (
    OPTIONAL_SYNTHETIC_CLAIM_KEYS,
    SYNTHETIC_CLAIM_KEYS,
    DelegationUnavailable,
    DomainCall,
    DomainResult,
    build_proxy_event,
    call_domain,
    get_delegate_lambda_client,
    synthetic_claims,
)
from shared.project_access import ACTING_SUBJECT_CLAIM
from shared.test.repo_paths import fresh_module_copy

_CLAIMS = {'sub': 'mcp:tok_1', 'cognito:groups': '', 'email': 'mcp:tok_1'}


def _rewrite(record: object, field: str, value: object) -> None:
    """Assign ``field`` at runtime. Through setattr because the type checker
    rightly refuses a direct write to a frozen dataclass, and the runtime
    FrozenInstanceError is exactly what the tests below assert."""
    setattr(record, field, value)


def _call(**overrides) -> DomainCall:
    return DomainCall(**{'function_name': 'voc-metrics-api', 'method': 'GET', 'path': '/x', **overrides})


def _proxy_response(payload, function_error: str | None = None) -> dict:
    """What `lambda.invoke` returns: the proxy response as a streaming body."""
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    response: dict = {'Payload': io.BytesIO(raw)}
    if function_error:
        response['FunctionError'] = function_error
    return response


@pytest.fixture
def lambda_client(monkeypatch):
    client = MagicMock(name='lambda_client')
    monkeypatch.setattr(mcp_delegate, 'get_delegate_lambda_client', lambda: client)
    return client


@pytest.fixture
def delegate_logger(monkeypatch):
    fake = MagicMock(name='logger')
    monkeypatch.setattr(mcp_delegate, 'logger', fake)
    return fake


# ===========================================================================
# The dedicated Lambda client
# ===========================================================================

class TestTheDelegateClientIsBuiltOnceWithTheStatedLimits:
    @pytest.fixture
    def cold_cache(self, monkeypatch):
        """The per-container cache as a cold start sees it."""
        monkeypatch.setattr(mcp_delegate, '_lambda_client', None)

    def test_a_cold_start_leaves_the_cache_empty(self):
        """A non-`None` initial value is returned forever without a client ever
        being built. Asserted on a FRESH copy of the module (not a reload: every
        importer holds `DelegationUnavailable` by reference, and a reload would
        split the class), so no earlier test's call can have filled it."""
        assert fresh_module_copy(mcp_delegate)._lambda_client is None

    @pytest.mark.usefixtures('cold_cache')
    def test_the_client_is_a_lambda_client_with_the_delegation_timeouts(self):
        with patch.object(mcp_delegate.boto3, 'client') as boto_client:
            built = get_delegate_lambda_client()

        boto_client.assert_called_once()
        assert boto_client.call_args.args == ('lambda',)
        assert set(boto_client.call_args.kwargs) == {'config'}
        config = boto_client.call_args.kwargs['config']
        assert isinstance(config, Config)
        # Config sets these per keyword in __init__; the stub declares none of
        # them, so they are read from the instance dict rather than attributes.
        options = vars(config)
        assert options['read_timeout'] == 20
        assert options['connect_timeout'] == 3
        assert options['retries'] == {'max_attempts': 1, 'mode': 'standard'}
        assert built is boto_client.return_value

    def test_the_stated_constants_are_the_ones_the_comment_argues_for(self):
        assert mcp_delegate._DELEGATE_READ_TIMEOUT_SECONDS == 20
        assert mcp_delegate._DELEGATE_CONNECT_TIMEOUT_SECONDS == 3

    @pytest.mark.usefixtures('cold_cache')
    def test_the_client_is_built_once_and_then_reused(self):
        with patch.object(mcp_delegate.boto3, 'client') as boto_client:
            first = get_delegate_lambda_client()
            second = get_delegate_lambda_client()

        assert boto_client.call_count == 1
        assert first is second
        assert mcp_delegate._lambda_client is first


# ===========================================================================
# The dataclasses
# ===========================================================================

class TestTheCallAndResultAreFrozenRecords:
    def test_a_call_defaults_to_empty_mappings_and_no_body(self):
        call = _call()

        assert call.path_parameters == {}
        assert call.query == {}
        assert call.body is None

    def test_two_calls_do_not_share_their_default_mappings(self):
        assert _call().path_parameters is not _call().path_parameters
        assert _call().query is not _call().query

    def test_a_call_cannot_be_rewritten_after_construction(self):
        call = _call()

        with pytest.raises(dataclasses.FrozenInstanceError):
            _rewrite(call, 'method', 'POST')

    def test_a_result_cannot_be_rewritten_after_construction(self):
        result = DomainResult(status_code=200, payload={})

        with pytest.raises(dataclasses.FrozenInstanceError):
            _rewrite(result, 'status_code', 500)

    def test_the_declared_field_types_resolve(self):
        """Annotations are strings under `from __future__ import annotations`; a
        consumer that resolves them (dataclass tooling, schema generation) must
        get the declared types back."""
        hints = typing.get_type_hints(DomainCall)

        assert hints == {
            'function_name': str,
            'method': str,
            'path': str,
            'path_parameters': dict[str, str],
            'query': dict[str, typing.Any],
            'body': dict | None,
        }

    @pytest.mark.parametrize(('status_code', 'ok'), [
        (199, False), (200, True), (201, True), (299, True), (300, False), (301, False),
    ])
    def test_ok_is_exactly_the_2xx_range(self, status_code, ok):
        assert DomainResult(status_code=status_code, payload=None).ok is ok


# ===========================================================================
# Claims
# ===========================================================================

class TestClaimsAreRefusedOrNamedExactly:
    @pytest.mark.parametrize('token_id', [None, '', 7, b'tok', ['tok']])
    def test_a_row_without_a_string_token_id_is_refused_with_the_stated_reason(self, token_id):
        row = {'token_id': token_id} if token_id is not None else {}

        with pytest.raises(DelegationUnavailable) as exc:
            synthetic_claims(row)
        assert str(exc.value) == 'token record has no usable token_id'

    def test_the_claims_are_exactly_the_prefixed_token_id(self):
        assert synthetic_claims({'token_id': 'tok_1'}) == _CLAIMS

    def test_the_email_is_the_prefixed_token_id_not_a_mailbox(self):
        assert synthetic_claims({'token_id': 'tok_1'})['email'] == 'mcp:tok_1'

    def test_a_minter_is_stripped_before_it_becomes_the_acting_subject(self):
        claims = synthetic_claims({'token_id': 'tok_1', 'created_by': '  minter-sub \n'})

        assert claims == {**_CLAIMS, ACTING_SUBJECT_CLAIM: 'minter-sub'}

    @pytest.mark.parametrize('created_by', ['', '   ', None, 7, 'mcp:other', ' mcp:other '])
    def test_an_unusable_minter_leaves_the_claims_untouched(self, created_by):
        assert synthetic_claims({'token_id': 'tok_1', 'created_by': created_by}) == _CLAIMS

    def test_the_named_claim_sets_are_exactly_these(self):
        # Owned by the retired per-project test_mcp_security until 3.00.00: a claim
        # nobody considered must not arrive unremarked.
        assert frozenset({'sub', 'cognito:groups', 'email'}) == SYNTHETIC_CLAIM_KEYS
        assert frozenset({ACTING_SUBJECT_CLAIM}) == OPTIONAL_SYNTHETIC_CLAIM_KEYS
        claims = synthetic_claims({'token_id': 'tok_1', 'created_by': 'minter-sub'})
        assert SYNTHETIC_CLAIM_KEYS <= set(claims) <= SYNTHETIC_CLAIM_KEYS | OPTIONAL_SYNTHETIC_CLAIM_KEYS


# ===========================================================================
# The synthesized proxy event
# ===========================================================================

class TestTheProxyEventIsExactlyWhatAPIGatewayWouldSend:
    def test_a_bare_get_renders_every_field(self):
        event = build_proxy_event(_call(), _CLAIMS)

        assert event == {
            'httpMethod': 'GET',
            'path': '/x',
            'resource': '/x',
            'queryStringParameters': None,
            'pathParameters': None,
            'body': None,
            'headers': {'Content-Type': 'application/json'},
            'requestContext': {
                'authorizer': {'claims': _CLAIMS},
                'stage': 'v1',
            },
            'isBase64Encoded': False,
        }

    def test_a_post_with_a_body_serializes_it_once(self):
        event = build_proxy_event(
            _call(method='POST', path='/projects/{project_id}',
                  path_parameters={'project_id': 'proj_1'},
                  query={'days': 7, 'flag': True, 'off': False, 'skip': None, 'label': 'a b'},
                  body={'name': 'n', 'count': 1}),
            _CLAIMS,
        )

        assert event['httpMethod'] == 'POST'
        assert event['path'] == '/projects/{project_id}'
        assert event['resource'] == '/projects/{project_id}'
        assert event['pathParameters'] == {'project_id': 'proj_1'}
        assert event['queryStringParameters'] == {
            'days': '7', 'flag': 'true', 'off': 'false', 'label': 'a b',
        }
        assert event['body'] == '{"name": "n", "count": 1}'

    def test_an_empty_body_mapping_is_still_a_body(self):
        """`{}` is a body a route may validate; only `None` means "no body"."""
        assert build_proxy_event(_call(body={}), _CLAIMS)['body'] == '{}'

    def test_a_query_of_only_absent_values_is_sent_as_none(self):
        assert build_proxy_event(_call(query={'a': None}), _CLAIMS)['queryStringParameters'] is None

    def test_the_claims_are_copied_not_shared(self):
        claims = dict(_CLAIMS)
        event = build_proxy_event(_call(), claims)
        claims['sub'] = 'tampered'

        assert event['requestContext']['authorizer']['claims'] == _CLAIMS

    def test_path_parameters_are_copied_not_shared(self):
        params = {'project_id': 'proj_1'}
        event = build_proxy_event(_call(path_parameters=params), _CLAIMS)
        params['project_id'] = 'tampered'

        assert event['pathParameters'] == {'project_id': 'proj_1'}

    @pytest.mark.parametrize(('value', 'rendered'), [
        (True, 'true'), (False, 'false'), (0, '0'), (14, '14'), (1.5, '1.5'), ('x', 'x'),
    ])
    def test_query_values_render_as_api_gateway_strings(self, value, rendered):
        assert mcp_delegate._stringify(value) == rendered


# ===========================================================================
# Invoking the domain function
# ===========================================================================

class TestTheInvokeIsSynchronousAndCarriesTheEvent:
    def test_a_call_without_a_function_name_is_refused_before_any_invoke(self, lambda_client):
        with pytest.raises(DelegationUnavailable) as exc:
            call_domain(_call(function_name=''), claims=_CLAIMS)

        assert str(exc.value) == 'no function configured for GET /x'
        lambda_client.invoke.assert_not_called()

    def test_the_invoke_is_request_response_with_the_serialized_event(self, lambda_client):
        lambda_client.invoke.return_value = _proxy_response({'statusCode': 200, 'body': '{}'})
        call = _call(query={'days': 7})

        result = call_domain(call, claims=_CLAIMS)

        lambda_client.invoke.assert_called_once_with(
            FunctionName='voc-metrics-api',
            InvocationType='RequestResponse',
            Payload=json.dumps(build_proxy_event(call, _CLAIMS)),
        )
        assert result == DomainResult(status_code=200, payload={})


class TestEveryFaultIsNamedAndLoggedExactly:
    @pytest.mark.parametrize(('exc', 'error_type'), [
        (ClientError({'Error': {'Code': 'ResourceNotFoundException', 'Message': 'no such function'}},
                     'Invoke'), 'ClientError'),
        (EndpointConnectionError(endpoint_url='https://lambda'), 'EndpointConnectionError'),
    ])
    def test_a_transport_fault_is_logged_by_route_and_type_then_raised_by_type(
        self, lambda_client, delegate_logger, exc, error_type,
    ):
        lambda_client.invoke.side_effect = exc

        with pytest.raises(DelegationUnavailable) as raised:
            call_domain(_call(method='POST', path='/projects'), claims=_CLAIMS)

        assert str(raised.value) == error_type
        assert raised.value.__cause__ is exc
        delegate_logger.exception.assert_called_once_with(
            'Domain invoke failed',
            extra={'route': 'POST /projects', 'error_type': error_type},
        )
        delegate_logger.error.assert_not_called()

    def test_an_unhandled_exception_upstream_is_logged_and_its_trace_withheld(
        self, lambda_client, delegate_logger,
    ):
        lambda_client.invoke.return_value = _proxy_response(
            {'errorMessage': 'Table not found: voc-feedback', 'stackTrace': ['...']},
            function_error='Unhandled',
        )

        with pytest.raises(DelegationUnavailable) as raised:
            call_domain(_call(), claims=_CLAIMS)

        assert str(raised.value) == 'domain function raised'
        assert 'voc-feedback' not in str(raised.value)
        delegate_logger.error.assert_called_once_with(
            'Domain function raised',
            extra={'route': 'GET /x', 'function_error': 'Unhandled'},
        )
        delegate_logger.exception.assert_not_called()

    def test_a_successful_response_logs_nothing(self, lambda_client, delegate_logger):
        lambda_client.invoke.return_value = _proxy_response({'statusCode': 200, 'body': '{}'})

        call_domain(_call(), claims=_CLAIMS)

        delegate_logger.error.assert_not_called()
        delegate_logger.exception.assert_not_called()

    @pytest.mark.parametrize('response', [
        {'Payload': io.BytesIO(b'not json')},
        {'Payload': io.BytesIO(b'\xff')},
        {},
    ])
    def test_an_undecodable_response_is_named(self, lambda_client, response):
        lambda_client.invoke.return_value = response

        with pytest.raises(DelegationUnavailable) as raised:
            call_domain(_call(), claims=_CLAIMS)

        assert str(raised.value) == 'domain response was not JSON'

    @pytest.mark.parametrize('payload', [
        ['statusCode'], 'statusCode', 200, None, {}, {'body': '{}'},
    ])
    def test_a_payload_that_is_not_a_proxy_response_is_named(self, lambda_client, payload):
        lambda_client.invoke.return_value = _proxy_response(payload)

        with pytest.raises(DelegationUnavailable) as raised:
            call_domain(_call(), claims=_CLAIMS)

        assert str(raised.value) == 'domain response was not a proxy response'

    @pytest.mark.parametrize('status_code', ['200', 200.0, None, [200]])
    def test_a_non_integer_status_code_is_named(self, lambda_client, status_code):
        lambda_client.invoke.return_value = _proxy_response({'statusCode': status_code, 'body': '{}'})

        with pytest.raises(DelegationUnavailable) as raised:
            call_domain(_call(), claims=_CLAIMS)

        assert str(raised.value) == 'domain response had no integer statusCode'


class TestTheBodyIsDecodedAsTheRouteMeantIt:
    @pytest.mark.parametrize('proxy', [
        {'statusCode': 204},
        {'statusCode': 204, 'body': None},
        {'statusCode': 204, 'body': ''},
    ])
    def test_no_body_is_none_not_an_empty_string(self, lambda_client, proxy):
        lambda_client.invoke.return_value = _proxy_response(proxy)

        assert call_domain(_call(), claims=_CLAIMS) == DomainResult(status_code=204, payload=None)

    def test_a_json_body_is_parsed(self, lambda_client):
        lambda_client.invoke.return_value = _proxy_response(
            {'statusCode': 404, 'body': '{"message": "Feedback not found"}'},
        )

        assert call_domain(_call(), claims=_CLAIMS) == DomainResult(
            status_code=404, payload={'message': 'Feedback not found'},
        )

    @pytest.mark.parametrize('raw_body', ['<html>Bad Gateway</html>', 'null and void', '{"half": ', 7])
    def test_a_non_json_body_is_passed_through_with_its_status(self, lambda_client, raw_body):
        lambda_client.invoke.return_value = _proxy_response({'statusCode': 502, 'body': raw_body})

        assert call_domain(_call(), claims=_CLAIMS) == DomainResult(status_code=502, payload=raw_body)
