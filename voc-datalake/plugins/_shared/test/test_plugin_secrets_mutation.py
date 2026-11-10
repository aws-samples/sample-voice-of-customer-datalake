"""Mutation hardening for `plugins/_shared/plugin_secrets.py`.

`test_plugin_secret_isolation.py` pins the security contract — only this
plugin's namespace is returned, a miss fails closed, no secret material leaks
into an error — but it derives every expectation from the module itself
(`plugin_secret_prefix(PLUGIN_ID)`) and checks messages by containment. A
mutation run found what that leaves unseen:

* the PREFIX SHAPE. Both the payloads and the expectations were built with
  `plugin_secret_prefix`, so `f"XX{plugin_id}_XX"` stayed green on both sides.
  The stored key names written by `integrations_handler` are `<id>_<key>`; that
  literal is pinned here.
* the WORDING of every refusal and every log line, and the `extra` keys a log
  query filters on (`plugin_id`, `expected_prefix`, `payload_type`). An operator
  reads these to fix a misconfigured plugin, so each is pinned as a literal.
* the identity PREVIEW the malformed-identity refusal echoes: a truncated
  `repr` for a string, the bare type name otherwise.
* the `sys.path` PRECEDENCE: the plugins directory must go FIRST, so `shared.*`
  resolves to the bundle's copy rather than any earlier entry.
"""

import importlib.util
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

from _shared import plugin_secrets
from _shared.plugin_secrets import filter_plugin_secrets, plugin_secret_prefix
from shared.exceptions import ConfigurationError, SecretUnreadableError
from shared.plugin_identity import PLUGIN_IDENTIFIER_RULES

PLUGINS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(plugin_secrets.__file__)))


def _refusal(plugin_id: object, payload: object, error: type[Exception]) -> tuple[str, MagicMock]:
    """Run a refused load; return the raised message and the patched logger."""
    with patch.object(plugin_secrets, 'logger') as mock_logger, pytest.raises(error) as excinfo:
        filter_plugin_secrets(plugin_id, payload)
    return str(excinfo.value), mock_logger


class TestThePrefixIsTheStoredKeyShape:
    def test_the_prefix_is_the_id_and_one_underscore(self):
        assert plugin_secret_prefix('webscraper') == 'webscraper_'

    def test_a_literal_stored_key_is_returned_under_its_bare_name(self):
        payload = {'webscraper_api_key': 'k', 'webscraper_configs': '[]', 'other_api_key': 'x'}
        assert filter_plugin_secrets('webscraper', payload) == {'api_key': 'k', 'configs': '[]'}


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('plugin_id', 'preview'), [
        ('Bad Id', "'Bad Id'"),
        ('A' * 50, repr('A' * 40)),
        (None, 'NoneType'),
        (7, 'int'),
    ], ids=['string', 'truncated_at_40', 'none', 'int'])
    def test_a_malformed_identity(self, plugin_id: object, preview: str):
        message, mock_logger = _refusal(plugin_id, {'x_key': 'v'}, ConfigurationError)
        assert message == (
            f'Cannot load plugin secrets: plugin identity {preview} is missing or '
            f'malformed (it {PLUGIN_IDENTIFIER_RULES}).'
        )
        mock_logger.error.assert_called_once_with(
            'Refusing to load plugin secrets: plugin identity is missing or malformed',
            extra={'plugin_id': preview},
        )

    @pytest.mark.parametrize(('payload', 'payload_type'), [
        (['webscraper_api_key'], 'list'),
        ('webscraper_api_key', 'str'),
        (3, 'int'),
    ], ids=['list', 'str', 'int'])
    def test_a_payload_that_is_not_a_json_object(self, payload: object, payload_type: str):
        message, mock_logger = _refusal('webscraper', payload, ConfigurationError)
        assert message == (
            "Cannot load plugin secrets for 'webscraper': the shared secret is not "
            "a JSON object, so it cannot carry 'webscraper_*' keys."
        )
        mock_logger.error.assert_called_once_with(
            'Refusing to load plugin secrets: secret payload is not a JSON object',
            extra={'plugin_id': 'webscraper', 'expected_prefix': 'webscraper_',
                   'payload_type': payload_type},
        )

    def test_an_empty_payload(self):
        message, mock_logger = _refusal('webscraper', {}, SecretUnreadableError)
        assert message == (
            "Cannot load plugin secrets for 'webscraper': the shared secret is "
            "empty or unreadable, so no 'webscraper_*' keys could be read."
        )
        mock_logger.error.assert_called_once_with(
            'Refusing to load plugin secrets: secret payload is empty',
            extra={'plugin_id': 'webscraper', 'expected_prefix': 'webscraper_'},
        )

    @pytest.mark.parametrize('payload', [
        {'other_api_key': 'x'},
        {'webscraper_': 'bare prefix'},
        {1: 'non-string key'},
    ], ids=['foreign_key', 'bare_prefix', 'non_string_key'])
    def test_a_namespace_miss(self, payload: dict):
        message, mock_logger = _refusal('webscraper', payload, ConfigurationError)
        assert message == (
            "Cannot load plugin secrets for 'webscraper': the shared secret "
            "contains no 'webscraper_*' keys. Check the plugin id and that its "
            "credentials were saved under that prefix."
        )
        mock_logger.error.assert_called_once_with(
            "Refusing to load plugin secrets: no key carries this plugin's prefix",
            extra={'plugin_id': 'webscraper', 'expected_prefix': 'webscraper_'},
        )


class TestImportPutsThePluginsDirectoryFirst:
    def test_the_plugins_directory_is_inserted_at_index_zero(self):
        spec = importlib.util.spec_from_file_location(
            '_plugin_secrets_import_probe', plugin_secrets.__file__,
        )
        assert spec is not None
        assert spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        saved = list(sys.path)
        sys.path.insert(0, 'sentinel-entry')
        try:
            spec.loader.exec_module(module)
            assert sys.path[:2] == [PLUGINS_DIR, 'sentinel-entry']
        finally:
            sys.path[:] = saved
