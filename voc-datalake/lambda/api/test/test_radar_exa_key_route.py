"""PUT / DELETE /radar/settings/exa-key and settings.exa_configured (moto SSM, docs/radar.md → "Exa")."""
import logging
from unittest.mock import patch

import boto3
import pytest
from test_radar_handler import ADMIN, _call, radar_tables

from shared import radar_exa_key

PARAMETER = '/voc/radar/exa-api-key'
KEY = 'placeholder' + '_0' * 8  # a fake key, built so no scanner reads it as one


@pytest.fixture
def tables():
    with radar_tables() as both, patch.dict('os.environ', {'RADAR_EXA_PARAMETER': PARAMETER}):
        radar_exa_key._ssm.cache_clear()  # a client of this moto session
        yield both
    radar_exa_key._ssm.cache_clear()


def _stored():
    ssm = boto3.client('ssm')
    try:
        return ssm.get_parameter(Name=PARAMETER, WithDecryption=True)['Parameter']
    except ssm.exceptions.ParameterNotFound:
        return None


def _configured(tables, lambda_context, path='/radar/settings'):
    status, body, _ = _call(tables, lambda_context, 'GET', path)
    assert status == 200
    return body['settings']['exa_configured']


@pytest.mark.parametrize(('method', 'body'), [('PUT', {'api_key': KEY}), ('DELETE', None)])
def test_only_admins_change_the_key(tables, lambda_context, method, body):
    assert _call(tables, lambda_context, method, '/radar/settings/exa-key', body=body)[0] == 403
    assert _stored() is None


def test_put_stores_a_secure_string_and_every_settings_read_reports_it(tables, lambda_context):
    assert _configured(tables, lambda_context) is False
    status, body, _ = _call(tables, lambda_context, 'PUT', '/radar/settings/exa-key', claims=ADMIN,
                            body={'api_key': f'  {KEY} '})
    assert (status, body) == (200, {'success': True, 'exa_configured': True})
    stored = _stored()
    assert stored is not None
    assert (stored['Type'], stored['Value']) == ('SecureString', KEY)
    assert _configured(tables, lambda_context) is True
    assert _configured(tables, lambda_context, '/radar') is True


def test_put_replaces_and_delete_clears(tables, lambda_context):
    for key in (KEY, 'another_key_9876'):
        _call(tables, lambda_context, 'PUT', '/radar/settings/exa-key', claims=ADMIN, body={'api_key': key})
    stored = _stored()
    assert stored is not None
    assert stored['Value'] == 'another_key_9876'
    status, body, _ = _call(tables, lambda_context, 'DELETE', '/radar/settings/exa-key', claims=ADMIN)
    assert (status, body, _stored()) == (200, {'success': True, 'exa_configured': False}, None)
    assert _configured(tables, lambda_context) is False
    # Deleting again is still a success.
    assert _call(tables, lambda_context, 'DELETE', '/radar/settings/exa-key', claims=ADMIN)[0] == 200


@pytest.mark.parametrize('body', [{'api_key': 'short'}, {'api_key': 'has spaces in it'}, {'api_key': 'x' * 201},
                                  {'api_key': 12345678}, {}, None])
def test_a_malformed_key_is_a_400_that_never_echoes_it(tables, lambda_context, body):
    status, answer, _ = _call(tables, lambda_context, 'PUT', '/radar/settings/exa-key', claims=ADMIN, body=body)
    assert status == 400
    assert 'has spaces' not in str(answer)
    assert 'short' not in str(answer)
    assert _stored() is None


def test_the_key_is_never_in_a_response_or_a_log(tables, lambda_context, caplog):
    # At the deployed level (LOG_LEVEL=INFO): only botocore's own DEBUG wire trace would carry it.
    with caplog.at_level(logging.INFO):
        _, put, _ = _call(tables, lambda_context, 'PUT', '/radar/settings/exa-key', claims=ADMIN, body={'api_key': KEY})
        _, settings, _ = _call(tables, lambda_context, 'GET', '/radar/settings')
        _, overview, _ = _call(tables, lambda_context, 'GET', '/radar', claims=ADMIN)
    assert all(KEY not in str(answer) for answer in (put, settings, overview))
    assert KEY not in caplog.text


@pytest.mark.usefixtures('tables')
def test_the_scan_reads_the_key_decrypted_and_none_without_it():
    assert radar_exa_key.load_exa_key() is None
    radar_exa_key.put_exa_key(KEY)
    assert radar_exa_key.load_exa_key() == KEY


def test_without_a_configured_parameter_nothing_is_configured(tables, lambda_context):
    with patch.dict('os.environ', {'RADAR_EXA_PARAMETER': ''}):
        assert radar_exa_key.exa_key_configured() is False
        assert radar_exa_key.load_exa_key() is None
        status, _, _ = _call(tables, lambda_context, 'PUT', '/radar/settings/exa-key', claims=ADMIN,
                             body={'api_key': KEY})
    assert status == 500
