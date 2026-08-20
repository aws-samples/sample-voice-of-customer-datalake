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
from plugin_manifests import (
    MANIFEST_KEYS,
    PLUGIN_IDS,
    PLUGIN_SECRET_DEFAULTS,
    freshly_deployed_secret,
)


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
    def test_status_reports_all_known_plugins(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults
    ):
        """GET /integrations/status returns an entry for every known plugin, not just webscraper.

        Regression guard for the previously hardcoded webscraper-only dict.
        If any plugin is missing, its 'Connected' badge in the Settings UI
        will never render regardless of what is stored in Secrets Manager.

        The expected set is PLUGIN_IDS, read from the manifests, so adding a
        plugin extends this guard without a test edit.
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
        missing = set(PLUGIN_IDS) - set(body.keys())
        assert not missing, (
            f"GET /integrations/status is missing entries for: {missing}. "
            "The 'Connected' badge will never render for these plugins."
        )

        # Each value above differs from its seeded default, so each source is configured.
        for plugin_id in PLUGIN_IDS:
            assert body[plugin_id]['configured'] is True, plugin_id


class TestFreshDeployReportsNothingConfigured:
    """
    A CDK-seeded default is not a configured value.

    Every credential key exists from the moment the stack deploys, because
    ingestion-stack.ts seeds the shared secret from each manifest's `secrets`
    block. Several of those defaults are non-empty strings — '[]' for the
    webscraper configs array, 'imports/' and 'processed/' for s3_import,
    'most_recent'/'newest', '500', '1440' for the app-review plugins. So a
    presence check, or any truthiness check, reports a source as connected
    before a human has entered anything.

    Measured on the real seeded secret, that was 4 of 5 sources claiming to be
    configured on a fresh deploy, which lights SourceCard's "Connected" badge
    and enables its Test button against an integration that cannot run.

    Reverting the default comparison in get_integration_status turns
    test_fresh_deploy_reports_nothing_configured red.
    """

    @patch('integrations_handler.secretsmanager')
    def test_fresh_deploy_reports_nothing_configured(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults
    ):
        """Against the exact secret CDK seeds, every source reports configured=False."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps(freshly_deployed_secret())
        }

        from integrations_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(method='GET', path='/integrations/status'), lambda_context
        )
        assert response['statusCode'] == 200
        body = json.loads(response['body'])

        # Sanity: the fixture must actually contain non-empty seeded values, or
        # this test would pass for the wrong reason.
        seeded = freshly_deployed_secret()
        assert [k for k, v in seeded.items() if v and k != 'placeholder'], (
            'fixture has no truthy seeded values, so it cannot detect the bug'
        )

        claiming_configured = sorted(k for k, v in body.items() if v['configured'])
        assert not claiming_configured, (
            f'{claiming_configured} report configured=True on a fresh deploy. '
            'A seeded default is being counted as a value a human entered.'
        )
        for plugin_id in PLUGIN_IDS:
            assert body[plugin_id]['credentials_set'] == [], plugin_id

    @patch('integrations_handler.secretsmanager')
    def test_value_differing_from_its_default_is_configured(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults
    ):
        """Editing one field flips exactly that source, and only that source."""
        secret = freshly_deployed_secret()
        secret['webscraper_configs'] = '[{"id": "s1", "url": "https://example.test"}]'
        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps(secret)}

        from integrations_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(method='GET', path='/integrations/status'), lambda_context
        )
        body = json.loads(response['body'])

        assert body['webscraper']['configured'] is True
        assert body['webscraper']['credentials_set'] == ['configs']
        others = sorted(k for k in PLUGIN_IDS if k != 'webscraper' and body[k]['configured'])
        assert not others, f'{others} became configured without being touched'

    @patch('integrations_handler.secretsmanager')
    def test_key_with_no_declared_default_is_reported(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults
    ):
        """A key written via PUT that no manifest declares still shows up.

        The scan is by prefix rather than over declared keys precisely so this
        works — the write path accepts any well-formed key, and status must not
        silently omit it.
        """
        secret = freshly_deployed_secret()
        secret['webscraper_undeclared_key'] = 'some-value'
        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps(secret)}

        from integrations_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(method='GET', path='/integrations/status'), lambda_context
        )
        body = json.loads(response['body'])
        assert body['webscraper']['credentials_set'] == ['undeclared_key']
        assert body['webscraper']['configured'] is True


class TestRuntimeWrittenConfigsArrays:
    """
    An empty `<source>_configs` array is not a configured source.

    save_app_config() writes `<source>_configs` for the multi-instance app
    plugins at RUNTIME, so no manifest declares those keys and there is no seeded
    default to compare them against. An untouched one holds '[]', which is
    truthy, so the default comparison alone still reported app_reviews_ios and
    app_reviews_android as connected.

    This shape is not hypothetical: it is what the deployed secret actually held
    when this was measured — `app_reviews_ios_configs` and
    `app_reviews_android_configs` present as '[]' beside nothing but seeded
    defaults.
    """

    @patch('integrations_handler.secretsmanager')
    def test_empty_runtime_configs_array_is_not_configured(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults
    ):
        secret = freshly_deployed_secret()
        # Exactly what save_app_config leaves behind before any app is added.
        secret['app_reviews_ios_configs'] = '[]'
        secret['app_reviews_android_configs'] = '[]'
        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps(secret)}

        from integrations_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(method='GET', path='/integrations/status'), lambda_context
        )
        body = json.loads(response['body'])

        claiming = sorted(k for k, v in body.items() if v['configured'])
        assert not claiming, f'{claiming} report configured on an empty configs array'

    @patch('integrations_handler.secretsmanager')
    def test_populated_runtime_configs_array_is_configured(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults
    ):
        """Adding an app instance does flip the source — the guard is not blanket."""
        secret = freshly_deployed_secret()
        secret['app_reviews_ios_configs'] = '[{"id": "a1", "app_name": "Example"}]'
        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps(secret)}

        from integrations_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(method='GET', path='/integrations/status'), lambda_context
        )
        body = json.loads(response['body'])

        assert body['app_reviews_ios']['configured'] is True
        assert body['app_reviews_ios']['credentials_set'] == ['configs']
        assert body['app_reviews_android']['configured'] is False

    @pytest.mark.parametrize('value', ['', '[]', '{}', '  ', ' [] '])
    def test_empty_shapes_are_never_configured(self, value):
        """Whitespace, empty string and empty JSON containers all mean 'unset'."""
        from integrations_handler import _is_configured_value

        assert _is_configured_value(value, None) is False
        assert _is_configured_value(value, 'some-default') is False

    @pytest.mark.parametrize(
        ('value', 'default', 'expected'),
        [
            ('imports/', 'imports/', False),   # untouched non-empty default
            ('uploads/', 'imports/', True),    # edited away from the default
            ('[{"id":1}]', '[]', True),        # webscraper with a scraper added
            ('500', '500', False),             # untouched numeric default
            ('750', '500', True),              # edited numeric default
            ('a-value', None, True),           # no declared default at all
        ],
    )
    def test_default_comparison(self, value, default, expected):
        from integrations_handler import _is_configured_value

        assert _is_configured_value(value, default) is expected

    @pytest.mark.parametrize(
        ('value', 'expected'),
        [
            ([], False),                   # a real JSON array, not the string '[]'
            ({}, False),                   # a real JSON object
            (None, False),                 # an explicit JSON null
            (0, False),
            ([{'id': 'a1'}], True),        # populated array
            ({'k': 'v'}, True),
            (7, True),
        ],
    )
    def test_non_string_stored_values(self, value, expected):
        """A value that is not a string is judged on emptiness alone.

        The secret is parsed JSON, so a value need not be a string. Every writer
        in this repo stores strings (`json.dumps` of the array, not the array),
        but a secret edited by hand in the console — or a future writer that
        stores a real array — lands here. Emptiness is the only test available,
        since a seeded default is always a string and so never compares equal.
        """
        from integrations_handler import _is_configured_value

        assert _is_configured_value(value, None) is expected
        # A declared default cannot rescue or condemn a non-string value.
        assert _is_configured_value(value, '[]') is expected

    @patch('integrations_handler.secretsmanager')
    def test_hand_edited_real_array_is_not_configured(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults
    ):
        """End-to-end: a real empty array in the secret does not flip a source."""
        secret = freshly_deployed_secret()
        secret['app_reviews_ios_configs'] = []  # not '[]' — an actual JSON array
        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps(secret)}

        from integrations_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(method='GET', path='/integrations/status'), lambda_context
        )
        assert response['statusCode'] == 200
        body = json.loads(response['body'])
        assert body['app_reviews_ios']['configured'] is False


class TestPluginSecretDefaultsParsing:
    """
    PLUGIN_SECRET_DEFAULTS is infrastructure-supplied, so the handler must not
    turn a bad value into a 500 on a route that has nothing to do with it.
    """

    def test_absent_variable_yields_no_sources(self, monkeypatch):
        """Unset means an empty mapping, not a raise."""
        import integrations_handler as h

        monkeypatch.delenv(h.PLUGIN_SECRET_DEFAULTS_VAR, raising=False)
        h._plugin_secret_defaults.cache_clear()
        assert h._plugin_secret_defaults() == {}

    @pytest.mark.parametrize('bad', ['not json at all', '[]', '"a string"', '42'])
    def test_malformed_variable_yields_no_sources(self, monkeypatch, bad):
        """Invalid JSON, or valid JSON of the wrong shape, degrades to {}."""
        import integrations_handler as h

        monkeypatch.setenv(h.PLUGIN_SECRET_DEFAULTS_VAR, bad)
        h._plugin_secret_defaults.cache_clear()
        assert h._plugin_secret_defaults() == {}

    def test_one_malformed_entry_does_not_hide_the_others(self, monkeypatch):
        """A bad per-plugin entry is dropped individually."""
        import integrations_handler as h

        monkeypatch.setenv(
            h.PLUGIN_SECRET_DEFAULTS_VAR,
            json.dumps({'good': {'a': '1'}, 'bad': 'not-a-mapping'}),
        )
        h._plugin_secret_defaults.cache_clear()
        assert h._plugin_secret_defaults() == {'good': {'a': '1'}}

    def test_non_string_values_within_an_entry_are_dropped(self, monkeypatch):
        """Only str -> str pairs survive, so the comparison below is total."""
        import integrations_handler as h

        monkeypatch.setenv(
            h.PLUGIN_SECRET_DEFAULTS_VAR,
            json.dumps({'p': {'ok': 'v', 'bad': 7}}),
        )
        h._plugin_secret_defaults.cache_clear()
        assert h._plugin_secret_defaults() == {'p': {'ok': 'v'}}

    def test_matches_what_cdk_would_hand_down(self, monkeypatch):
        """Parsing the manifest-derived map round-trips to the same mapping.

        Pins the contract between aggregateSecretsByPlugin() in
        lib/plugin-loader.ts and this parser: both sides are derived from
        plugins/*/manifest.json, so a shape change on either side shows up here.
        """
        import integrations_handler as h

        monkeypatch.setenv(h.PLUGIN_SECRET_DEFAULTS_VAR, json.dumps(PLUGIN_SECRET_DEFAULTS))
        h._plugin_secret_defaults.cache_clear()
        assert h._plugin_secret_defaults() == PLUGIN_SECRET_DEFAULTS
        assert set(h._plugin_secret_defaults()) == set(PLUGIN_IDS)


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
    def test_value_larger_than_4kib_is_accepted(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """A single large value is stored, because size is bounded per SECRET, not per value.

        This route is how the Settings webscraper card saves its `configs`
        textarea — a JSON array that grows by roughly 500 bytes per scraper the
        user adds. An earlier revision capped each value at 4096 bytes, which
        made saving fail at around eight scrapers while the Scrapers page went
        on growing the very same `webscraper_configs` key with no cap at all.

        Regression guard: reintroducing a per-value cap below the service limit
        turns this 200 into a 400.
        """
        big_configs = json.dumps([{'id': f's{i}', 'url': 'https://e.test'} for i in range(400)])
        assert len(big_configs) > 4096, 'fixture must exceed the cap this test retires'

        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps({})}

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
        )
        event['body'] = json.dumps({'configs': big_configs})

        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200, response['body']
        written = json.loads(mock_secrets.put_secret_value.call_args.kwargs['SecretString'])
        assert written['webscraper_configs'] == big_configs

    @patch('integrations_handler.secretsmanager')
    def test_write_exceeding_the_secret_limit_is_rejected(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """A write that would push the whole secret past the service limit returns 400.

        Secrets Manager refuses a SecretString over 65,536 bytes with an opaque
        error; catching it before the write turns a 500 into an actionable 400
        AND leaves the stored secret untouched.
        """
        from shared.aws import SECRET_STRING_MAX_BYTES

        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps({})}

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
        )
        event['body'] = json.dumps({'configs': 'x' * (SECRET_STRING_MAX_BYTES + 1)})

        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400, response['body']
        # The read happens (the merge needs the current secret) but the WRITE must not.
        mock_secrets.put_secret_value.assert_not_called()

    @patch('integrations_handler.secretsmanager')
    def test_many_small_values_still_bounded_by_the_secret_limit(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        """Values that each fit are still refused when their TOTAL does not.

        This is the case a per-value cap structurally cannot catch, and the
        reason the bound moved to the serialized secret.
        """
        from shared.aws import SECRET_STRING_MAX_BYTES

        # An existing secret already near the limit, plus one modest addition.
        existing = {'other_feature_blob': 'y' * (SECRET_STRING_MAX_BYTES - 200)}
        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps(existing)}

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
        )
        event['body'] = json.dumps({'configs': 'z' * 500})

        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400, response['body']
        mock_secrets.put_secret_value.assert_not_called()


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
