"""
Security regression tests for integrations_handler.py (issue #261).

Three load-bearing behaviours are tested here:

1. Cross-namespace read isolation
   A key stored at the top level of the shared secret (belonging to another
   feature) must not be returned when a caller requests it through a specific
   source's credentials endpoint.
   Regression: test_cross_namespace_read_is_blocked

2. Write-path validation
   A PUT request that contains a malformed key must be rejected, and the
   secret must remain unchanged.
   Regression: test_invalid_write_key_rejected_and_secret_unchanged

3. Admin gate on both routes
   Non-admin callers must receive 403 on both GET and PUT.
   Regressions: test_non_admin_read_rejected, test_non_admin_write_rejected
"""
import json
from unittest.mock import patch


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
