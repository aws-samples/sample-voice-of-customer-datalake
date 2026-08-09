"""
Security regression tests for integrations_handler.py (issue #261).

Behaviours tested:

1. Cross-namespace read isolation
   A key stored at the top level of the shared secret (belonging to another
   feature) must not be returned when a caller requests it through a specific
   source's credentials endpoint.
   Regression: test_cross_namespace_read_is_blocked

2. Write-path validation
   A PUT request that contains a malformed key must be rejected, and the
   secret must remain unchanged.
   Regression: test_invalid_write_key_rejected_and_secret_unchanged

3. Admin gate on GET, PUT, and GET /integrations/status
   Non-admin callers must receive 403 on all three routes.
   Regressions: test_non_admin_read_rejected, test_non_admin_write_rejected,
                test_non_admin_status_rejected

4. Source parameter validation
   Malformed or namespace-colliding source values are rejected with 400.

5. GET ?keys= parameter validation
   Malformed keys in the query string are rejected with 400 before the
   secret is read.

6. Non-dict body rejection
   A list or string body returns 400 before the secret is touched.

7. Manifest key acceptance
   Every config key declared in plugin manifests passes _validate_credential_key.
"""
import json
from unittest.mock import patch

import pytest


def _non_admin_event(api_gateway_event, **kwargs):
    """Build an API Gateway event that has no admin group membership."""
    event = api_gateway_event(**kwargs)
    event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
    return event


class TestCrossNamespaceReadBlocked:
    """
    Cross-namespace read: a top-level key that belongs to another feature
    must NOT be returned when requested through a specific source's endpoint.

    This is the canonical regression guard for the unprefixed-fallback removal.
    Reverting that change causes this test to return a non-empty result instead
    of {}.
    """

    @patch('integrations_handler.secretsmanager')
    def test_cross_namespace_read_is_blocked(self, mock_secrets, api_gateway_event, lambda_context):
        """Top-level secret keys are not visible through source-scoped reads.

        Setup: the secret contains 'other_feature_blob' — a top-level key
        written by a different handler — but NOT 'webscraper_other_feature_blob'.

        Request: GET /integrations/webscraper/credentials?keys=other_feature_blob

        Expected: the response must be {} — the top-level key must not leak.
        """
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                # A key written by the scrapers handler at the top level.
                # It is not in the webscraper_ namespace.
                'other_feature_blob': 'sensitive-data-from-another-feature',
                # A legitimately namespaced key for a different source.
                'myapp_api_token': 'token-for-myapp',
            })
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'other_feature_blob'},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        # The cross-namespace key must not appear in the response.
        assert body == {}, (
            "Cross-namespace key leak detected: the response contained keys "
            f"that do not belong to the 'webscraper' namespace: {body}"
        )

    @patch('integrations_handler.secretsmanager')
    def test_namespaced_key_is_returned(self, mock_secrets, api_gateway_event, lambda_context):
        """Correctly namespaced keys ARE returned (positive-path control)."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'webscraper_app_name': 'my-app',
                'other_feature_blob': 'should-not-appear',
            })
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'app_name'},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body == {'app_name': 'my-app'}


class TestInvalidWriteKeyRejected:
    """
    Write-path validation: a PUT with a malformed key must be rejected and
    the secret must be unchanged.

    Asserting the secret (not just the response code) is the load-bearing
    check here — a handler that returns 400 but still writes would pass a
    response-only assertion.

    Reverting _validate_credential_key causes the secret to be written and
    this test's secret-unchanged assertion to fail.
    """

    @patch('integrations_handler.secretsmanager')
    def test_invalid_write_key_rejected_and_secret_unchanged(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Malformed key in request body → 400 and no write to the secret."""
        existing_secret = {'webscraper_app_name': 'existing-value'}
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps(existing_secret)
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            # Key contains a dot — must be rejected.
            body={'invalid.key': 'value'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400, (
            f"Expected 400 for invalid key, got {response['statusCode']}"
        )
        # Validation runs before the secret is read — the PR description
        # claims "invalid keys return 400 before the secret is read".
        mock_secrets.get_secret_value.assert_not_called()
        # The secret must not have been written.
        mock_secrets.put_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_key_with_leading_underscore_rejected(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Key starting with underscore → 400 and no write."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'_private': 'value'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.put_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_key_with_uppercase_rejected(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Key containing uppercase letters → 400 and no write."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'MyKey': 'value'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.put_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_too_many_keys_rejected(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """More than MAX_CREDENTIAL_KEYS_PER_REQUEST keys → 400 and no write."""
        from integrations_handler import MAX_CREDENTIAL_KEYS_PER_REQUEST, lambda_handler

        # Build a body that exceeds the limit with valid-form keys.
        body = {f"key{i}": f"val{i}" for i in range(MAX_CREDENTIAL_KEYS_PER_REQUEST + 1)}
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body=body,
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.put_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_valid_key_accepted(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Valid-form keys are accepted (positive-path control)."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        mock_secrets.put_secret_value.return_value = {}

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'app_name': 'my-app', 'sort_by': 'recent'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200
        mock_secrets.put_secret_value.assert_called_once()


class TestAdminGateOnCredentialsRoutes:
    """
    Admin gate: non-admin callers must receive 403 on both the read (GET)
    and write (PUT) /integrations/<source>/credentials routes.

    Reverting the require_admin call in either handler causes the
    corresponding test to return 200/other status instead of 403.
    """

    def test_non_admin_read_rejected(self, api_gateway_event, lambda_context):
        """Non-admin caller gets 403 on GET /integrations/<source>/credentials.

        Regression: test_non_admin_read_rejected
        """
        from integrations_handler import lambda_handler

        event = _non_admin_event(
            api_gateway_event,
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'api_key'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 403, (
            f"Expected 403 for non-admin GET, got {response['statusCode']}"
        )
        body = json.loads(response['body'])
        assert body.get('success') is False

    def test_non_admin_write_rejected(self, api_gateway_event, lambda_context):
        """Non-admin caller gets 403 on PUT /integrations/<source>/credentials.

        Regression: test_non_admin_write_rejected
        """
        from integrations_handler import lambda_handler

        event = _non_admin_event(
            api_gateway_event,
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'api_key': 'value'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 403, (
            f"Expected 403 for non-admin PUT, got {response['statusCode']}"
        )
        body = json.loads(response['body'])
        assert body.get('success') is False

    @patch('integrations_handler.secretsmanager')
    def test_admin_read_succeeds(self, mock_secrets, api_gateway_event, lambda_context):
        """Admin caller can read credentials (positive-path control)."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_api_key': 'key123'})
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'api_key'},
        )
        response = lambda_handler(event, lambda_context)
        # The conftest fixture sets cognito:groups = 'admins'.
        assert response['statusCode'] == 200

    @patch('integrations_handler.secretsmanager')
    def test_admin_write_succeeds(self, mock_secrets, api_gateway_event, lambda_context):
        """Admin caller can write credentials (positive-path control)."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({})
        }
        mock_secrets.put_secret_value.return_value = {}

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            body={'api_key': 'new-value'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200

    def test_non_admin_status_rejected(self, api_gateway_event, lambda_context):
        """Non-admin caller gets 403 on GET /integrations/status.

        Regression guard for the admin gate added in issue #261 follow-up.
        """
        from integrations_handler import lambda_handler

        event = _non_admin_event(
            api_gateway_event,
            method='GET',
            path='/integrations/status',
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 403, (
            f"Expected 403 for non-admin GET /integrations/status, got {response['statusCode']}"
        )
        body = json.loads(response['body'])
        assert body.get('success') is False

    @patch('integrations_handler.secretsmanager')
    def test_status_reports_all_known_plugins(self, mock_secrets, api_gateway_event, lambda_context):
        """GET /integrations/status returns an entry for every known plugin, not just webscraper.

        Regression guard for the previously hardcoded webscraper-only dict.
        If any plugin is missing, its 'Connected' badge in the Settings UI
        will never render regardless of what is stored in Secrets Manager.
        """
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'webscraper_configs': '[{"id": "x"}]',
                'app_reviews_ios_app_id': '12345',
                'app_reviews_android_package_name': 'com.example.app',
                's3_import_bucket_name': 'my-bucket',
                'synthetic_reviews_company_name': 'Acme Corp',
            })
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/status',
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200

        body = json.loads(response['body'])
        expected_plugins = {
            'app_reviews_android',
            'app_reviews_ios',
            's3_import',
            'synthetic_reviews',
            'webscraper',
        }
        # Every known plugin must appear in the response.
        missing = expected_plugins - set(body.keys())
        assert not missing, (
            f"GET /integrations/status is missing entries for: {missing}. "
            "The 'Connected' badge will never render for these plugins."
        )

        # Configured plugins must be reported as configured.
        assert body['webscraper']['configured'] is True
        assert body['app_reviews_ios']['configured'] is True
        assert body['app_reviews_android']['configured'] is True
        assert body['s3_import']['configured'] is True
        assert body['synthetic_reviews']['configured'] is True


class TestSourceParameterValidation:
    """
    Source path parameter validation.

    'source' is used to build the namespace prefix f"{source}_".  Without
    validation a caller can provoke namespace collisions:
      source='foo_bar' + key='baz'  →  'foo_bar_baz'
      source='foo'     + key='bar_baz'  →  'foo_bar_baz'  (same key!)

    Both GET and PUT must reject a malformed or colliding source with 400
    before reading or writing the secret.
    """

    @patch('integrations_handler.secretsmanager')
    def test_valid_form_source_accepted(self, mock_secrets, api_gateway_event, lambda_context):
        """Source 'webscraper_admin' satisfies the form check and is accepted.

        The form validation (lowercase, digits, underscores, no leading/trailing _)
        correctly admits a well-formed source like 'webscraper_admin'.  Form
        validation alone cannot close the namespace-collision gap for this value
        (webscraper_admin + key='api_key' produces the same path as
        webscraper + key='admin_api_key'), which is why the PR description
        notes a manifest-derived allowlist as the stronger long-term fix.
        """
        mock_secrets.get_secret_value.return_value = {
            'SecretString': '{"webscraper_admin_api_key": "value"}'
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper_admin/credentials',
            path_params={'source': 'webscraper_admin'},
            query_params={'keys': 'api_key'},
        )
        response = lambda_handler(event, lambda_context)
        # A valid-form source is accepted; it is NOT rejected with 400.
        assert response['statusCode'] == 200

    @patch('integrations_handler.secretsmanager')
    def test_uppercase_source_get_rejected(self, mock_secrets, api_gateway_event, lambda_context):
        """Source with uppercase letters returns 400 on GET before the secret is read.

        The error message must say 'source identifier' (not 'credential key') so
        it is clear which parameter is invalid when debugging a 400.
        """
        import json as _json

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/WebScraper/credentials',
            path_params={'source': 'WebScraper'},
            query_params={'keys': 'api_key'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        # Validation runs before the secret is read.
        mock_secrets.get_secret_value.assert_not_called()
        # Error message must identify it as a source identifier, not a key.
        # The API returns errors under the 'error' key for ValidationError.
        body = _json.loads(response['body'])
        error_text = (body.get('error') or body.get('message') or '').lower()
        assert 'source identifier' in error_text

    @patch('integrations_handler.secretsmanager')
    def test_uppercase_source_put_rejected(self, mock_secrets, api_gateway_event, lambda_context):
        """Source with uppercase letters returns 400 on PUT before the secret is touched.

        The error message must say 'source identifier' (not 'credential key') so
        it is clear which parameter is invalid when debugging a 400.
        """
        import json as _json

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/WebScraper/credentials',
            path_params={'source': 'WebScraper'},
            body={'api_key': 'value'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.get_secret_value.assert_not_called()
        mock_secrets.put_secret_value.assert_not_called()
        # Error message must identify it as a source identifier, not a key.
        # The API returns errors under the 'error' key for ValidationError.
        body = _json.loads(response['body'])
        error_text = (body.get('error') or body.get('message') or '').lower()
        assert 'source identifier' in error_text


class TestGetKeysValidation:
    """
    GET ?keys= parameter validation.

    The read path must reject malformed keys in the query string before
    reading from Secrets Manager, mirroring the all-or-nothing validation
    on the write path.
    """

    @patch('integrations_handler.secretsmanager')
    def test_malformed_key_in_query_returns_400(self, mock_secrets, api_gateway_event, lambda_context):
        """GET with a malformed key in ?keys= returns 400 without reading the secret."""
        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'invalid.key'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400, (
            f"Expected 400 for malformed key in ?keys=, got {response['statusCode']}"
        )
        # The secret must not have been read — validation runs first.
        mock_secrets.get_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_key_with_hyphen_in_query_rejected(self, mock_secrets, api_gateway_event, lambda_context):
        """GET with a hyphenated key in ?keys= returns 400."""
        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'api-key'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.get_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_valid_query_key_is_accepted(self, mock_secrets, api_gateway_event, lambda_context):
        """GET with a valid key in ?keys= reads the secret (positive-path control)."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({'webscraper_app_name': 'my-app'})
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'app_name'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200
        mock_secrets.get_secret_value.assert_called_once()


class TestNonDictBodyRejection:
    """
    Non-dict body validation for PUT /integrations/<source>/credentials.

    Sending a list, string, or null as the body must return 400 before the
    secret is touched.
    """

    @patch('integrations_handler.secretsmanager')
    def test_list_body_rejected(self, mock_secrets, api_gateway_event, lambda_context):
        """A JSON list body returns 400 and the secret is untouched."""
        import json as _json

        from integrations_handler import lambda_handler

        # Manually craft an event with a list body because the conftest
        # helper json.dumps the body dict.
        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
        )
        event['body'] = _json.dumps(['item1', 'item2'])

        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.get_secret_value.assert_not_called()
        mock_secrets.put_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_string_body_rejected(self, mock_secrets, api_gateway_event, lambda_context):
        """A JSON string body returns 400 and the secret is untouched."""
        import json as _json

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
        )
        event['body'] = _json.dumps('just-a-string')

        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.get_secret_value.assert_not_called()
        mock_secrets.put_secret_value.assert_not_called()


class TestValueValidation:
    """
    Value type and length validation for PUT /integrations/<source>/credentials.

    Non-string values and oversized values must be rejected before writing.
    """

    @patch('integrations_handler.secretsmanager')
    def test_non_string_value_rejected(self, mock_secrets, api_gateway_event, lambda_context):
        """A non-string value returns 400 and the secret is untouched."""
        import json as _json

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
        )
        event['body'] = _json.dumps({'app_name': 12345})

        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.get_secret_value.assert_not_called()
        mock_secrets.put_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_oversized_value_rejected(self, mock_secrets, api_gateway_event, lambda_context):
        """A value exceeding MAX_CREDENTIAL_VALUE_BYTES returns 400."""
        import json as _json

        from integrations_handler import MAX_CREDENTIAL_VALUE_BYTES, lambda_handler

        oversized_value = 'x' * (MAX_CREDENTIAL_VALUE_BYTES + 1)
        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
        )
        event['body'] = _json.dumps({'app_name': oversized_value})

        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.get_secret_value.assert_not_called()
        mock_secrets.put_secret_value.assert_not_called()


# ---------------------------------------------------------------------------
# Manifest key acceptance tests
#
# These parametrized tests assert that every config key declared in the plugin
# manifests passes _validate_credential_key.  A regression here means a real
# field name would be rejected when the frontend tries to save it.
#
# The lists are loaded dynamically from the frontend manifests.json so that
# new plugins and fields are automatically covered without any test update.
# ---------------------------------------------------------------------------

import json as _json
import pathlib as _pathlib

_MANIFESTS_PATH = (
    _pathlib.Path(__file__).parents[3]  # voc-datalake/
    / 'frontend' / 'src' / 'plugins' / 'manifests.json'
)


def _load_manifests():
    """Load plugin manifests from the frontend source tree.

    Emits a warning if the file is absent (e.g. in a minimal CI checkout that
    does not include the frontend), so the gap is visible in CI output rather
    than silently producing zero parametrized test cases.
    """
    if not _MANIFESTS_PATH.exists():
        import warnings
        warnings.warn(
            f'manifests.json not found at {_MANIFESTS_PATH}; '
            'TestManifestKeysAccepted will collect zero test cases and the '
            'manifest-key acceptance guard will be inactive for this run.',
            stacklevel=1,
        )
        return []
    return _json.loads(_MANIFESTS_PATH.read_text())


_MANIFESTS = _load_manifests()

# All unique config keys across all plugins — deduplicated because several
# plugins share field names like 'app_name', 'sort_by', 'frequency_minutes'.
MANIFEST_KEYS = sorted({
    field['key']
    for manifest in _MANIFESTS
    for field in manifest.get('config', [])
})

# Plugin IDs used as `source=` path parameters.
PLUGIN_IDS = [m['id'] for m in _MANIFESTS]


class TestManifestKeysAccepted:
    """Every config key from every plugin manifest must pass _validate_credential_key."""

    @pytest.mark.parametrize('key', MANIFEST_KEYS)
    def test_manifest_key_passes_validation(self, key):
        """No ValidationError is raised for a real manifest field name."""
        from integrations_handler import _validate_credential_key
        # Must not raise.
        _validate_credential_key(key)

    @pytest.mark.parametrize('plugin_id', PLUGIN_IDS)
    def test_plugin_id_passes_validation(self, plugin_id):
        """Plugin IDs used as `source` path parameters must pass _validate_source."""
        from integrations_handler import _validate_source
        # Must not raise.
        _validate_source(plugin_id)
