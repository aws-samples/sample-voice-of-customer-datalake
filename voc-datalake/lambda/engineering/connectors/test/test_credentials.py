"""A connection's GitHub App credential from SSM: parsed, cached briefly, never logged (credentials.py)."""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from moto import mock_aws

from engineering.connectors import credentials
from engineering.connectors.credentials import (
    CACHE_SECONDS,
    CredentialUnusable,
    ParameterStoreCredentials,
    parse_credential,
    parse_stored,
)
from engineering.connectors.hosts import NoConnection
from engineering.connectors.test.app_keys import APP_ID, INSTALLATION_ID, OWNER, REPOSITORY, parameter_value, pem

PREFIX = '/voc/engineering/'


@pytest.fixture
def ssm() -> Iterator[Any]:
    with mock_aws():
        yield boto3.client('ssm', region_name='us-east-1')


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def store(ssm: Any, connection_id: str, value: str) -> None:
    ssm.put_parameter(Name=f'{PREFIX}{connection_id}', Value=value, Type='SecureString', Overwrite=True)


def test_reads_the_connections_secure_string_decrypted(ssm: Any) -> None:
    store(ssm, 'conn-1', parameter_value())
    found = ParameterStoreCredentials(PREFIX, client=lambda: ssm).get('conn-1')
    assert (found.app_id, found.installation_id, found.owner, found.repository) == (
        APP_ID, INSTALLATION_ID, OWNER, REPOSITORY)
    assert 'PRIVATE' not in repr(found)


def test_the_default_client_is_the_containers_ssm_client(ssm: Any) -> None:
    credentials._ssm.cache_clear()
    store(ssm, 'conn-1', parameter_value())
    assert ParameterStoreCredentials(PREFIX).get('conn-1').repository == REPOSITORY
    credentials._ssm.cache_clear()


def test_keeps_a_credential_for_the_cache_window_then_reads_it_again(ssm: Any) -> None:
    store(ssm, 'conn-1', parameter_value())
    clock = Clock()
    source = ParameterStoreCredentials(PREFIX, client=lambda: ssm, clock=clock)
    assert source.get('conn-1').app_id == APP_ID
    store(ssm, 'conn-1', parameter_value(app_id='654321'))
    clock.now += CACHE_SECONDS - 1
    assert source.get('conn-1').app_id == APP_ID
    clock.now += 2
    assert source.get('conn-1').app_id == '654321'


def test_a_connection_without_a_parameter_has_no_connection(ssm: Any, caplog: pytest.LogCaptureFixture) -> None:
    with pytest.raises(NoConnection):
        ParameterStoreCredentials(PREFIX, client=lambda: ssm).get('conn-2')
    assert [(r.getMessage(), vars(r)['error_code']) for r in caplog.records] == [
        ('engineering connection credential not read', 'ParameterNotFound')]


@pytest.mark.parametrize(('prefix', 'connection_id'), [('', 'conn-1'), (PREFIX, '../radar/exa-api-key'),
                                                       (PREFIX, ''), (PREFIX, 'a' * 129)])
def test_no_prefix_or_a_connection_id_that_is_not_one_reads_nothing(prefix: str, connection_id: str) -> None:
    def client() -> Any:
        raise AssertionError('SSM is not called')
    with pytest.raises(NoConnection):
        ParameterStoreCredentials(prefix, client=client).get(connection_id)


def test_an_unusable_parameter_is_logged_without_its_value(ssm: Any, caplog: pytest.LogCaptureFixture) -> None:
    value = parameter_value(app_id='not-a-number')
    store(ssm, 'conn-1', value)
    with pytest.raises(CredentialUnusable):
        ParameterStoreCredentials(PREFIX, client=lambda: ssm).get('conn-1')
    assert [r.getMessage() for r in caplog.records] == ['engineering connection credential unusable']
    logged = json.dumps([{k: str(v) for k, v in vars(r).items()} for r in caplog.records])
    assert 'PRIVATE KEY' not in logged
    assert 'not-a-number' not in logged


@pytest.mark.parametrize('text', [
    'not json',
    '[1, 2]',
    parameter_value(app_id=True),
    parameter_value(installation_id='0'),
    parameter_value(repository='no-slash'),
    parameter_value(repository='owner/..'),
    parameter_value(repository='-owner/name'),
    parameter_value(private_key='-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n'),
    parameter_value(private_key=None),
    parameter_value(private_key=pem(ec.generate_private_key(ec.SECP256R1()))),
])
def test_refuses_a_value_that_is_not_a_github_app_credential(text: str) -> None:
    with pytest.raises(CredentialUnusable) as caught:
        parse_credential(text)
    assert 'PRIVATE KEY' not in str(caught.value)


def test_an_installation_id_may_be_a_string_of_digits() -> None:
    assert parse_credential(parameter_value(installation_id='42')).installation_id == 42


# --- a GitLab connection's project token (7.06.00) ------------------------------------------------------------------

GITLAB_TOKEN = 'glpat-' + 'exampleTokenForTests0123'   # (in two parts: no secret scanner takes it for a token)


def gitlab_value(**change: Any) -> str:
    return json.dumps({'host': 'gitlab', 'project_id': 4242, 'repository': 'example-org/payments/refund-service',
                       'token': GITLAB_TOKEN, 'expires_at': '2027-11-01', **change})


def test_a_gitlab_parameter_is_its_project_and_token_and_never_shows_the_token(ssm: Any) -> None:
    store(ssm, 'conn-gl', gitlab_value())
    source = ParameterStoreCredentials(PREFIX, client=lambda: ssm)
    found = source.gitlab('conn-gl')
    assert (found.project_id, found.repository, found.token, found.expires_at) == (
        4242, 'example-org/payments/refund-service', GITLAB_TOKEN, '2027-11-01')
    assert GITLAB_TOKEN not in repr(found)
    assert source.stored('conn-gl') == found


def test_each_hosts_reader_refuses_the_other_hosts_credential(ssm: Any) -> None:
    store(ssm, 'conn-gl', gitlab_value())
    store(ssm, 'conn-gh', parameter_value())
    source = ParameterStoreCredentials(PREFIX, client=lambda: ssm)
    with pytest.raises(CredentialUnusable):
        source.get('conn-gl')
    with pytest.raises(CredentialUnusable):
        source.gitlab('conn-gh')
    with pytest.raises(CredentialUnusable):
        parse_credential(gitlab_value())


@pytest.mark.parametrize('text', [
    gitlab_value(host='bitbucket'), gitlab_value(project_id='0'), gitlab_value(project_id=True),
    gitlab_value(repository='no-namespace'), gitlab_value(repository='a/../b'), gitlab_value(token='ghp_x'),
    gitlab_value(token=None),
])
def test_a_gitlab_value_off_its_shape_is_unusable_and_never_quoted(text: str) -> None:
    with pytest.raises(CredentialUnusable) as caught:
        parse_stored(text)
    assert GITLAB_TOKEN not in str(caught.value)
