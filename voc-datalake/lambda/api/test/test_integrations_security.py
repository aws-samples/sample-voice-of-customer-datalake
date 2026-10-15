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

8. Every `<source>` route validates and gates
   `_validate_source_parameter` reaches all seven routes taking a `<source>` path
   parameter, and the five that write reach `require_admin`. The allowlist and the
   admin gate were first wired into the two credentials routes only, which left a
   `users`-group caller able to write the shared secret and invoke an ingestor.
   Regressions: TestEverySourceRouteIsValidated, TestEverySourceWriteIsAdminGated,
                TestSourceRouteCoverageIsComplete

9. The query-string source route validates too
   `GET /sources/status` is the ONE route taking a source from the query string
   rather than a `<source>` path parameter, so the inventory above cannot see it —
   and it was the last unvalidated one, reaching `_build_rule_name`/`describe_rule`
   and a `SOURCE_RUN#` partition key with any value a caller sent. Its batch branch
   cannot raise (one unknown name must not fail the whole response, and its own
   default list contains the deliberate non-plugin `manual_import`), so the two
   branches are guarded differently — and therefore disagree about `manual_import`
   itself, which is asserted in BOTH directions rather than only the accepting one.
   Regression: TestTheQueryStringSourceRouteIsValidated

10. That route's fan-out is bounded as well as validated
   Validation bounds WHICH EventBridge rules `?sources=` may describe, not how
   MANY calls it makes: the list was neither de-duplicated nor capped, so one
   valid name repeated 500 times measured 200 / 500 `describe_rule` calls / 1 key
   in the response — every repeat overwriting the same entry, since the response
   is keyed by source name. Asserted on the CALL COUNT, because a body-only
   assertion cannot see this and every case in item 9 passes without the fix.
   Regression: TestTheStatusRouteDoesNotFanOutPerDuplicate
"""
import ast
import inspect
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


class TestIsConfiguredValue:
    """
    Unit truth table for _is_configured_value(value, seeded_default).

    Split out from TestRuntimeWrittenConfigsArrays, which owns the end-to-end
    `<source>_configs` regression: mixing the two made the revert-mapping
    unreadable, because a failure in this class says nothing about that scenario.
    """

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

    @pytest.mark.parametrize('value', [[], {}, None, 0])
    def test_empty_non_string_values_are_never_configured(self, value):
        """A real JSON array/object/null/zero is unset, whatever the default says."""
        from integrations_handler import _is_configured_value

        assert _is_configured_value(value, None) is False
        # An unrelated default cannot rescue an empty shape.
        assert _is_configured_value(value, 'unrelated-default') is False

    @pytest.mark.parametrize('value', [[{'id': 'a1'}], {'k': 'v'}, 7])
    def test_populated_non_string_values_are_configured(self, value):
        """A non-empty JSON value counts, unless it matches its seeded default.

        The secret is parsed JSON, so a value need not be a string: a hand-edited
        console entry can store a real array, object or number. The default
        comparison still applies to these — see
        test_non_string_value_still_compared_against_its_default — but none of
        these values equals the unrelated default passed below, so being non-empty
        is what settles them.
        """
        from integrations_handler import _is_configured_value

        assert _is_configured_value(value, None) is True
        assert _is_configured_value(value, 'unrelated-default') is True

    @pytest.mark.parametrize(
        ('value', 'default', 'expected'),
        [
            (1440, '1440', False),   # int equal to its seeded string default
            (500, '500', False),
            (750, '500', True),      # int differing from its seeded default
            (1440, None, True),      # same int, but nothing seeded to match
        ],
    )
    def test_non_string_value_still_compared_against_its_default(
        self, value, default, expected
    ):
        """A non-string is compared to the seeded default via its text.

        Skipping the comparison for non-strings would report an int 1440 sitting
        beside the seeded default '1440' as configured, though it is the same
        untouched state as the string form. Reachable only via a hand-edited
        secret, but the helper should not depend on that.
        """
        from integrations_handler import _is_configured_value

        assert _is_configured_value(value, default) is expected


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

    TWO checks, because the form check alone is not enough: the colliding value is
    itself well-formed.  Since issue #251 the prefix scan in
    `plugins/_shared/plugin_secrets.py` is the entire isolation boundary between
    plugins, so a write landing in another plugin's namespace is a cross-plugin
    credential injection.  `source` is therefore also restricted to the
    manifest-derived plugin ids CDK hands down as PLUGIN_SECRET_DEFAULTS.
    """

    @patch('integrations_handler.secretsmanager')
    def test_a_real_plugin_id_is_accepted(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """Positive control for the allowlist below: a real plugin id still works.

        Without this, rejecting EVERY source would satisfy the two rejection cases
        that follow while breaking credential management entirely.
        """
        mock_secrets.get_secret_value.return_value = {
            'SecretString': '{"webscraper_api_key": "value"}'
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper/credentials',
            path_params={'source': 'webscraper'},
            query_params={'keys': 'api_key'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200

    @patch('integrations_handler.secretsmanager')
    def test_a_well_formed_but_unknown_source_is_rejected_on_read(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The form check cannot close the collision gap, because the colliding
        value is WELL-FORMED.

        'webscraper_admin' passes the character class, yet
        webscraper_admin + key='api_key' addresses the same stored key as
        webscraper + key='admin_api_key'. The source must therefore be a plugin
        that actually exists, which `PLUGIN_SECRET_DEFAULTS` is the manifest-derived
        list of.
        """
        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper_admin/credentials',
            path_params={'source': 'webscraper_admin'},
            query_params={'keys': 'api_key'},
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        mock_secrets.get_secret_value.assert_not_called()

    @patch('integrations_handler.put_secret_json')
    @patch('integrations_handler.secretsmanager')
    def test_a_write_cannot_address_another_plugins_namespace(
        self, mock_secrets, mock_put, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        """The concrete cross-plugin credential injection, end to end.

        source='app_reviews' + key='ios_app_id' stores `app_reviews_ios_app_id`,
        which `app_reviews_ios`'s Lambda then reads as its own `app_id` — since
        issue #251 the prefix scan is the ENTIRE isolation boundary between
        plugins, so this is credential injection rather than a display quirk.
        `plugin-loader.ts` refuses a colliding pair of MANIFEST ids, but cannot see
        a source invented in a request. 'app_reviews' is well-formed and is not a
        plugin, so it must be refused before anything is written.
        """
        mock_secrets.get_secret_value.return_value = {
            'SecretString': '{"app_reviews_ios_app_name": "RealApp"}'
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path='/integrations/app_reviews/credentials',
            path_params={'source': 'app_reviews'},
            body={'ios_app_id': '99999'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert mock_put.call_args_list == [], (
            'a value was written into app_reviews_ios namespace via source=app_reviews'
        )

    @patch('integrations_handler.secretsmanager')
    def test_an_unavailable_allowlist_falls_back_to_the_form_check(
        self, mock_secrets, api_gateway_event, lambda_context, monkeypatch,
    ):
        """Fails OPEN when PLUGIN_SECRET_DEFAULTS is absent, deliberately.

        `_plugin_secret_defaults` already degrades to `{}` rather than 500ing the
        Settings page. Turning that degradation into "no source may be configured"
        would let one bad environment variable break credential management
        outright, so the form check alone applies — which is the state this route
        shipped in. Pinned so the fallback is a decision rather than an accident.
        """
        import integrations_handler as h

        monkeypatch.delenv(h.PLUGIN_SECRET_DEFAULTS_VAR, raising=False)
        h._plugin_secret_defaults.cache_clear()
        mock_secrets.get_secret_value.return_value = {
            'SecretString': '{"webscraper_admin_api_key": "value"}'
        }

        event = api_gateway_event(
            method='GET',
            path='/integrations/webscraper_admin/credentials',
            path_params={'source': 'webscraper_admin'},
            query_params={'keys': 'api_key'},
        )
        response = h.lambda_handler(event, lambda_context)
        h._plugin_secret_defaults.cache_clear()

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


# ---------------------------------------------------------------------------
# Every `<source>` route validates its source and gates its writes.
#
# The allowlist and the admin gate were both wired into the two credentials
# routes and into nothing else, while five other routes turned the same
# request-supplied `<source>` into a Secrets Manager key, an ingestor Lambda
# name or an EventBridge rule name. Measured before the fix, as a caller whose
# only Cognito group is `users`:
#
#   POST /integrations/app_reviews_ios/apps  → 200, one put_secret_json
#   POST /sources/not_a_plugin/run           → 200, real lambda:Invoke of
#                                              voc-ingestor-not_a_plugin, plus a
#                                              SOURCE_RUN#not_a_plugin row
#   PUT  /sources/not_a_plugin/enable        → 200, events:EnableRule
#
# The route-by-route cases below are the behavioural half. The `ast` pass after
# them is the half that covers a route added LATER: a behavioural test can only
# assert about a route somebody remembered to write it for, and forgetting is the
# failure this whole section exists to catch.
# ---------------------------------------------------------------------------

def _handler_module():
    import integrations_handler
    return integrations_handler


def _route_functions() -> dict[str, ast.FunctionDef]:
    """Every module-level function carrying an `@app.<method>("<path>")` decorator.

    Parsed rather than read off the resolver, because the resolver records the
    route's PATH and handler but not the guards inside the handler's body, which
    is the thing under test. Keyed by function name; the paths are recovered
    separately in `_route_paths` below.
    """
    tree = ast.parse(inspect.getsource(_handler_module()))
    routes = {}
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        if any(_route_path_of(decorator) for decorator in node.decorator_list):
            routes[node.name] = node
    return routes


def _route_path_of(decorator: ast.expr) -> str | None:
    """The literal path of an `@app.get("/x")`-style decorator, else None.

    Matches on the `app` receiver and a string first argument, so
    `@tracer.capture_method` (no arguments) and any future non-routing decorator
    are ignored without needing a list of method names to exclude.
    """
    if not isinstance(decorator, ast.Call):
        return None
    func = decorator.func
    if not isinstance(func, ast.Attribute):
        return None
    if not isinstance(func.value, ast.Name) or func.value.id != 'app':
        return None
    if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
        return None
    path = decorator.args[0].value
    return path if isinstance(path, str) else None


def _route_paths(node: ast.FunctionDef) -> list[str]:
    return [
        path for path in (_route_path_of(d) for d in node.decorator_list)
        if path is not None
    ]


def _calls_in(node: ast.FunctionDef) -> set[str]:
    """Names of the plain-function calls anywhere in *node*'s body."""
    return {
        call.func.id
        for call in ast.walk(node)
        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
    }


def _source_routes() -> dict[str, ast.FunctionDef]:
    """Route functions that take a `<source>` path parameter.

    Selected by the DECORATOR's path containing `<source>`, not by the presence of
    a `source` argument. That is the whole of the criterion, and the exclusion it
    produces rests on nothing else: `get_sources_status` takes its sources from the
    QUERY STRING (`?sources=a,b,c` and `?run_status=`), so it is out of scope for a
    path-parameter inventory.

    It is NOT out of scope for validation, and an earlier version of this docstring
    wrongly said it addressed no namespace — it derives an EventBridge rule name
    (`_build_rule_name`, then `describe_rule`) and a `SOURCE_RUN#` partition key.
    That route validates its sources INLINE, in the handler, because one branch
    answers about several sources at once and so cannot raise; see
    `_is_addressable_source` and TestTheQueryStringSourceRouteIsValidated below.
    """
    return {
        name: node for name, node in _route_functions().items()
        if any('<source>' in path for path in _route_paths(node))
    }


# The routes that WRITE — a Secrets Manager value, an ingestor invocation, or an
# EventBridge rule state. Listed explicitly because "does this route write?" is a
# judgement no parse can make, and because the read/write split is the whole
# argument for gating five of the seven: `list_app_configs` returns a public app
# store id and a display name to any authenticated user, which the Scrapers page
# renders for everyone.
SOURCE_WRITE_ROUTES = {
    'update_credentials',
    'save_app_config',
    'delete_app_config',
    'run_source',
    'enable_source',
    'disable_source',
}

# `get_credentials` is admin-gated too, but as a READ: it returns stored
# configuration values. Kept out of the set above so that set means "mutates
# something", which is what its assertions claim.
SOURCE_ADMIN_ROUTES = SOURCE_WRITE_ROUTES | {'get_credentials'}


class TestSourceRouteCoverageIsComplete:
    """Non-vacuity for the two `ast` classes below.

    Every assertion there is "for each route found", so a parse that finds NOTHING
    — a rename of `app`, a move to a router object, a decorator style change —
    passes all of them over an empty set. These cases make that loud, and pin the
    route inventory the two lists above are asserted against.
    """

    def test_the_parser_finds_every_source_route(self):
        found = set(_source_routes())
        assert found == {
            'get_credentials',
            'update_credentials',
            'list_app_configs',
            'save_app_config',
            'delete_app_config',
            'run_source',
            'enable_source',
            'disable_source',
        }, (
            'the route inventory changed; a NEW <source> route must be added to '
            'SOURCE_WRITE_ROUTES (if it mutates) and will otherwise be asserted '
            'as a read'
        )

    def test_every_named_write_route_is_a_route_the_parser_found(self):
        """The lists above cannot name a function that no longer exists.

        Otherwise deleting or renaming a route would silently drop its guard
        assertions rather than failing.
        """
        assert SOURCE_ADMIN_ROUTES <= set(_source_routes())

    def test_the_only_ungated_source_route_is_the_app_config_read(self):
        """States the read/write split as an assertion, so widening it is a choice.

        If a future route is added and left out of SOURCE_WRITE_ROUTES, this fails
        rather than quietly accepting it as a read that needs no admin.
        """
        assert set(_source_routes()) - SOURCE_ADMIN_ROUTES == {'list_app_configs'}


class TestEverySourceRouteIsValidated:
    """Each `<source>` route validates the parameter before using it.

    `<source>` becomes a Secrets Manager key prefix (`_get_app_configs_key`), an
    ingestor function name (`_build_ingestor_function_name`) or an EventBridge rule
    name (`_build_rule_name`) on every one of these routes, so there is no route on
    which "is this a real plugin?" is the wrong question.
    """

    @pytest.mark.parametrize('route', sorted(_source_routes()))
    def test_the_route_validates_its_source(self, route):
        calls = _calls_in(_source_routes()[route])
        assert '_validate_source_parameter' in calls, (
            f'{route} uses <source> without validating it; a well-formed but '
            'unknown value reaches a secret key, a Lambda name or a rule name'
        )

    def test_the_validator_applies_both_checks(self):
        """The form check alone is what left the collision open, so both must run.

        Asserted on the helper rather than at each of the seven call sites: a route
        calling `_validate_source_parameter` gets both, and this is what makes that
        true.
        """
        validator = next(
            node for node in ast.parse(inspect.getsource(_handler_module())).body
            if isinstance(node, ast.FunctionDef)
            and node.name == '_validate_source_parameter'
        )
        assert _calls_in(validator) == {
            '_validate_source',
            '_validate_source_is_a_known_plugin',
        }


class TestEverySourceWriteIsAdminGated:
    """Each mutating `<source>` route calls require_admin.

    The three `apps` routes and the three `sources` routes carried no gate while
    the credentials routes beside them did, so the boundary depended on which key
    a write happened to land under.
    """

    @pytest.mark.parametrize('route', sorted(SOURCE_ADMIN_ROUTES))
    def test_the_route_requires_admin(self, route):
        assert 'require_admin' in _calls_in(_source_routes()[route]), (
            f'{route} mutates or reads configuration with no admin gate'
        )

    def test_the_control_the_app_config_read_is_deliberately_open(self):
        """Non-vacuity: without this, gating EVERY route would satisfy the above.

        `list_app_configs` is rendered for every authenticated user on the Scrapers
        page and returns a public app store id and a display name. Gating it would
        empty that list for non-admins, so its openness is a decision and is pinned
        as one.
        """
        assert 'require_admin' not in _calls_in(_source_routes()['list_app_configs'])


class TestAnUnknownSourceReachesNoResource:
    """The allowlist, driven through lambda_handler on the newly-guarded routes.

    Admin events throughout: the subject is the allowlist, so a 403 from the admin
    gate would mask whether the source was checked at all.
    """

    @patch('integrations_handler.put_secret_json')
    @patch('integrations_handler.secretsmanager')
    def test_an_unknown_source_cannot_write_an_app_config(
        self, mock_secrets, mock_put, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        """POST /integrations/<source>/apps writes `<source>_configs` on the SAME
        shared secret the credentials route writes, so it needs the same check.

        The 400 here is OVERDETERMINED, and the assertion says so deliberately:
        `APP_CONFIG_PLUGINS` is a two-element set, so an unknown source is refused
        by that narrower check even with the allowlist removed. What this case pins
        is which of the two answers, i.e. that the allowlist runs FIRST — because
        "does not support multiple app configs" is a misleading thing to tell
        someone who named a source that does not exist at all, and reading it sends
        them looking for a manifest capability rather than a typo.

        The load-bearing guard for these three routes is the `ast` pass in
        TestEverySourceRouteIsValidated: a behavioural assertion cannot distinguish
        a defence-in-depth check from an absent one when a narrower check already
        refuses the same input.
        """
        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/integrations/not_a_plugin/apps',
            path_params={'source': 'not_a_plugin'},
            body={'app': {'app_name': 'Injected'}},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert mock_put.call_args_list == [], 'a value was written under not_a_plugin_configs'
        error = json.loads(response['body']).get('error', '')
        assert 'not a configured plugin' in error, (
            f'expected the allowlist to answer first, got: {error!r}'
        )

    @patch('shared.tables.get_aggregates_table')
    @patch('boto3.client')
    def test_an_unknown_source_invokes_no_lambda_and_writes_no_run_record(
        self, mock_boto_client, mock_table, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        """POST /sources/<source>/run interpolated <source> straight into a Lambda
        function name and a `SOURCE_RUN#<source>` partition key."""
        lambda_client = mock_boto_client.return_value
        lambda_client.invoke.return_value = {'StatusCode': 202}
        table = mock_table.return_value

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/sources/not_a_plugin/run',
            path_params={'source': 'not_a_plugin'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert lambda_client.invoke.call_args_list == []
        assert table.put_item.call_args_list == [], (
            'a SOURCE_RUN# partition was written for a source that is not a plugin'
        )

    @pytest.mark.parametrize('action', ['enable', 'disable'])
    @patch('integrations_handler.events_client')
    def test_an_unknown_source_touches_no_eventbridge_rule(
        self, mock_events, action, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='PUT',
            path=f'/sources/not_a_plugin/{action}',
            path_params={'source': 'not_a_plugin'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert mock_events.enable_rule.call_args_list == []
        assert mock_events.disable_rule.call_args_list == []

    @patch('integrations_handler.secretsmanager')
    def test_the_control_a_real_plugin_id_still_reads_its_app_configs(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """Non-vacuity for the four cases above: rejecting every source would
        satisfy them all while breaking the Scrapers page outright."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'app_reviews_ios_configs': json.dumps([{'id': 'a1', 'app_name': 'Real'}]),
            })
        }

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/integrations/app_reviews_ios/apps',
            path_params={'source': 'app_reviews_ios'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['apps'][0]['app_name'] == 'Real'

    @patch('shared.tables.get_aggregates_table')
    @patch('boto3.client')
    def test_the_control_a_real_plugin_id_still_runs(
        self, mock_boto_client, mock_table, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        lambda_client = mock_boto_client.return_value
        lambda_client.invoke.return_value = {'StatusCode': 202}
        mock_table.return_value = None

        from integrations_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/sources/webscraper/run',
            path_params={'source': 'webscraper'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert lambda_client.invoke.call_args_list, 'the real ingestor was not invoked'

    @patch('shared.tables.get_aggregates_table')
    @patch('boto3.client')
    def test_an_unavailable_allowlist_still_admits_a_run(
        self, mock_boto_client, mock_table, api_gateway_event, lambda_context, monkeypatch,
    ):
        """Fails OPEN when PLUGIN_SECRET_DEFAULTS is absent, on these routes too.

        Same reasoning as on the credentials routes: `_plugin_secret_defaults`
        degrades to `{}` rather than 500ing, and turning that into "no source may
        be run or toggled" would let one bad environment variable take ingestion
        management out entirely. The ADMIN gate is unconditional and covers this
        state — see TestNoNonAdminReachesASourceWrite.
        """
        import integrations_handler as h

        monkeypatch.delenv(h.PLUGIN_SECRET_DEFAULTS_VAR, raising=False)
        h._plugin_secret_defaults.cache_clear()
        lambda_client = mock_boto_client.return_value
        lambda_client.invoke.return_value = {'StatusCode': 202}
        mock_table.return_value = None

        event = api_gateway_event(
            method='POST',
            path='/sources/webscraper/run',
            path_params={'source': 'webscraper'},
        )
        response = h.lambda_handler(event, lambda_context)
        h._plugin_secret_defaults.cache_clear()

        assert response['statusCode'] == 200


class TestNoNonAdminReachesASourceWrite:
    """A `users`-group caller is refused on every mutating `<source>` route.

    Real plugin ids throughout, so the refusal cannot be coming from the allowlist
    — the admin gate is the subject. Each case also asserts the ABSENCE of the side
    effect, not just the status: a route that answered 403 while still writing
    would satisfy a status-only assertion.
    """

    @patch('integrations_handler.put_secret_json')
    @patch('integrations_handler.secretsmanager')
    def test_a_non_admin_cannot_save_an_app_config(
        self, mock_secrets, mock_put, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        mock_secrets.get_secret_value.return_value = {'SecretString': '{}'}

        from integrations_handler import lambda_handler

        event = _non_admin_event(
            api_gateway_event,
            method='POST',
            path='/integrations/app_reviews_ios/apps',
            path_params={'source': 'app_reviews_ios'},
            body={'app': {'app_name': 'Injected'}},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        assert mock_put.call_args_list == [], (
            'a users-group caller wrote app_reviews_ios_configs on the shared secret'
        )

    @patch('integrations_handler.put_secret_json')
    @patch('integrations_handler.secretsmanager')
    def test_a_non_admin_cannot_delete_an_app_config(
        self, mock_secrets, mock_put, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'app_reviews_ios_configs': json.dumps([{'id': 'a1', 'app_name': 'Real'}]),
            })
        }

        from integrations_handler import lambda_handler

        event = _non_admin_event(
            api_gateway_event,
            method='DELETE',
            path='/integrations/app_reviews_ios/apps/a1',
            path_params={'source': 'app_reviews_ios', 'app_id': 'a1'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        assert mock_put.call_args_list == [], 'a users-group caller deleted an app config'

    @patch('shared.tables.get_aggregates_table')
    @patch('boto3.client')
    def test_a_non_admin_cannot_trigger_a_run(
        self, mock_boto_client, mock_table, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        """Every run fetches from a third-party API and writes the data lake, so
        this is a billed operation and a rate limit any authenticated user could
        exhaust."""
        lambda_client = mock_boto_client.return_value
        lambda_client.invoke.return_value = {'StatusCode': 202}
        table = mock_table.return_value

        from integrations_handler import lambda_handler

        event = _non_admin_event(
            api_gateway_event,
            method='POST',
            path='/sources/webscraper/run',
            path_params={'source': 'webscraper'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        assert lambda_client.invoke.call_args_list == [], (
            'a users-group caller invoked the webscraper ingestor'
        )
        assert table.put_item.call_args_list == []

    @pytest.mark.parametrize('action', ['enable', 'disable'])
    @patch('integrations_handler.events_client')
    def test_a_non_admin_cannot_toggle_a_schedule(
        self, mock_events, action, api_gateway_event, lambda_context,
        plugin_secret_defaults,
    ):
        """`disable` is the direction that matters most: it silently stops
        ingestion, and nothing in this repo re-enables a rule automatically."""
        from integrations_handler import lambda_handler

        event = _non_admin_event(
            api_gateway_event,
            method='PUT',
            path=f'/sources/webscraper/{action}',
            path_params={'source': 'webscraper'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        assert mock_events.enable_rule.call_args_list == []
        assert mock_events.disable_rule.call_args_list == []

    @patch('integrations_handler.secretsmanager')
    def test_the_control_a_non_admin_can_still_list_app_configs(
        self, mock_secrets, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """Non-vacuity, and the property the gates must not cost: the Scrapers page
        renders this list for every authenticated user."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps({
                'app_reviews_ios_configs': json.dumps([{'id': 'a1', 'app_name': 'Real'}]),
            })
        }

        from integrations_handler import lambda_handler

        event = _non_admin_event(
            api_gateway_event,
            method='GET',
            path='/integrations/app_reviews_ios/apps',
            path_params={'source': 'app_reviews_ios'},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['apps'][0]['app_name'] == 'Real'


class TestTheQueryStringSourceRouteIsValidated:
    """`GET /sources/status` validates the sources it takes from the query string.

    The one route outside `_source_routes()`' inventory, because its sources arrive
    as `?sources=a,b,c` and `?run_status=` rather than as a `<source>` path
    parameter — so the guard the other seven share by construction had to be wired
    in by hand here, and was not. Measured before the fix, as a caller whose only
    Cognito group is `users`:

      ?sources=not_a_plugin,../../etc  → 200, with describe_rule called for
                                        voc-ingest-not_a_plugin-schedule and
                                        voc-ingest-../../etc-schedule, and each
                                        rule's State, ScheduleExpression and
                                        rule_name returned
      ?run_status=not_a_plugin         → 200, an unbounded SOURCE_RUN# query with
                                        the run's `errors` array verbatim

    Admin events are NOT used here, unlike the classes above: this route is open to
    any authenticated user by design (`SourceCard.tsx` reads it on every Settings
    render), so a non-admin event is the real caller and proves the validation is
    not coming from an admin gate that does not exist.

    The two branches are asserted differently because they behave differently, and
    the asymmetry is the point — see `_is_addressable_source` for why the batch
    branch must NOT raise. Its visible consequence is that `manual_import` is
    accepted by one branch and refused by the other, so both answers are asserted:
    a claim asserted in one direction only can regress in the other.
    """

    @staticmethod
    def _status_event(api_gateway_event, query):
        return _non_admin_event(
            api_gateway_event,
            method='GET',
            path='/sources/status',
            query_params=query,
        )

    @patch('integrations_handler.events_client')
    def test_an_unknown_source_reaches_no_eventbridge_rule(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The batch branch reports the source as absent instead of describing it.

        Asserts the ABSENCE of the call, not just the response shape: a route that
        answered `exists: False` while still calling `describe_rule` would satisfy a
        response-only assertion and still enumerate rules.
        """
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.return_value = {
            'State': 'ENABLED', 'ScheduleExpression': 'rate(1 day)',
        }

        from integrations_handler import lambda_handler

        event = self._status_event(api_gateway_event, {'sources': 'not_a_plugin'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert mock_events.describe_rule.call_args_list == [], (
            'an arbitrary query-string value reached EventBridge'
        )
        assert body['sources']['not_a_plugin'] == {'enabled': False, 'exists': False}
        # No rule name reflected back: the pre-fix response carried
        # 'voc-ingest-not_a_plugin-schedule', which tells a caller the naming
        # convention for rules it may not address.
        assert 'rule_name' not in body['sources']['not_a_plugin']

    @patch('integrations_handler.events_client')
    def test_a_malformed_source_reaches_no_eventbridge_rule(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The traversal-shaped value from the report, which the form check catches.

        Separate from the case above because it fails a DIFFERENT check — the
        character class rather than the allowlist — and `_is_addressable_source`
        converts both to the same answer. A guard wired to only one of the two would
        pass one of these cases.
        """
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )

        from integrations_handler import lambda_handler

        event = self._status_event(api_gateway_event, {'sources': '../../etc'})
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert mock_events.describe_rule.call_args_list == []
        assert json.loads(response['body'])['sources']['../../etc'] == {
            'enabled': False, 'exists': False,
        }

    @patch('integrations_handler.events_client')
    def test_the_control_a_real_plugin_id_is_still_described(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """Non-vacuity: rejecting every source would satisfy both cases above while
        making every schedule on the Settings page read as disabled."""
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.return_value = {
            'State': 'ENABLED', 'ScheduleExpression': 'rate(1 day)',
        }

        from integrations_handler import lambda_handler

        event = self._status_event(api_gateway_event, {'sources': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert mock_events.describe_rule.call_args_list, (
            'a configured plugin was not described'
        )
        assert body['sources']['webscraper']['enabled'] is True

    @patch('integrations_handler.events_client')
    def test_a_mixed_request_reports_the_unknown_and_still_describes_the_known(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The reason the batch branch skips rather than raises.

        One unknown name among several must not fail the whole response. A raising
        guard here would answer 400 and the caller would learn nothing about the
        sources it asked about that DO exist.
        """
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.return_value = {
            'State': 'ENABLED', 'ScheduleExpression': 'rate(1 day)',
        }

        from integrations_handler import lambda_handler

        event = self._status_event(
            api_gateway_event, {'sources': 'not_a_plugin,webscraper'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['sources']['not_a_plugin'] == {'enabled': False, 'exists': False}
        assert body['sources']['webscraper']['enabled'] is True

    @patch('integrations_handler.events_client')
    def test_the_default_request_still_reports_all_three_of_its_sources(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The regression this route's guard must not cause, and why it cannot raise.

        `SourceCard.tsx` calls `getSourcesStatus()` with NO argument on every
        Settings render, taking the fallback list below. `manual_import` is in that
        list, is a legitimate `source_platform` (it is in `KNOWN_SOURCES` in
        `plugins/_shared/schemas.py`) and has no manifest — so it is absent from
        `PLUGIN_SECRET_DEFAULTS` and a raising guard would answer 400 to that
        request for every user, admin included.

        Asserted as an equality over the keys, not a membership: dropping
        `manual_import` from the response entirely is the other way this regresses,
        and `'manual_import' in body` would not notice a route that reported it as
        an error instead of a status.
        """
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.side_effect = (
            mock_events.exceptions.ResourceNotFoundException
        )

        from integrations_handler import lambda_handler

        event = self._status_event(api_gateway_event, {})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert set(body['sources']) == {'webscraper', 'manual_import', 's3_import'}
        assert body['sources']['manual_import'] == {'enabled': False, 'exists': False}

    @patch('shared.tables.get_aggregates_table')
    def test_the_run_status_branch_refuses_the_manual_import_the_other_accepts(
        self, mock_table, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The deliberate counterpart of the case above, and the ONE input on which
        the two branches of this route disagree.

        `manual_import` is accepted there and refused here. Both are right, because
        the branches report different things about it: only `run_source` and
        `BaseIngestor` write a `SOURCE_RUN#` partition, and `manual_import` has no
        ingestor — so no current path writes `SOURCE_RUN#manual_import` while the
        allowlist is available, and a 400 naming the reason beats the pre-fix 200
        `{'status': 'never_run'}` about a source with nothing to report. The batch
        branch reports schedule state, where "no rule exists" is a real answer.

        Scoped to the configured state, not stated as impossible, for the two
        reasons the handler comment records: neither guard is retroactive, so a
        deployment upgraded from the pre-guard base may hold a stale row (measured
        on that base — a `users` caller wrote it); and the documented fail-open on
        an unavailable PLUGIN_SECRET_DEFAULTS admits `manual_import` on both
        branches, which is why `plugin_secret_defaults` is a fixture here rather
        than assumed.

        Asserting only the accepting half left the asymmetry unpinned in the
        direction that could regress: a future edit swapping this branch to
        `_is_addressable_source` would answer 200 with an empty status, which
        `test_the_default_request_still_reports_all_three_of_its_sources` cannot
        see. Separate from `..._an_unknown_run_status_source_queries_nothing`
        because `not_a_plugin` is not in the route's own default list, so it does
        not exercise the disagreement at all.
        """
        table = mock_table.return_value

        from integrations_handler import lambda_handler

        event = self._status_event(api_gateway_event, {'run_status': 'manual_import'})
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert table.query.call_args_list == [], (
            'a SOURCE_RUN# partition was queried for a source that has no ingestor'
        )

    @patch('shared.tables.get_aggregates_table')
    def test_the_asymmetry_is_a_property_of_the_configured_state_only(
        self, mock_table, api_gateway_event, lambda_context, monkeypatch,
    ):
        """With the allowlist unavailable the two branches STOP disagreeing.

        The case above is the configured state. The allowlist is what produces its
        400, so under the documented fail-open — `_validate_source_is_a_known_plugin`
        returning early, which `_is_addressable_source` inherits — this branch admits
        `manual_import` like the batch one, and the partition is queried.

        Pinned because the comment at that branch now scopes its claim to the
        configured state instead of calling `SOURCE_RUN#manual_import` impossible,
        and that scoping is the kind of prose this PR has already had to correct
        twice: true when written, unverifiable afterwards. Asserting it means a
        change making the fail-open stricter has to update the comment rather than
        leave it describing a state that no longer exists.
        """
        import integrations_handler as h

        table = mock_table.return_value
        table.query.return_value = {'Items': []}
        monkeypatch.delenv(h.PLUGIN_SECRET_DEFAULTS_VAR, raising=False)
        h._plugin_secret_defaults.cache_clear()

        event = self._status_event(api_gateway_event, {'run_status': 'manual_import'})
        response = h.lambda_handler(event, lambda_context)
        h._plugin_secret_defaults.cache_clear()

        assert response['statusCode'] == 200
        assert len(table.query.call_args_list) == 1, (
            'the fail-open should admit manual_import here as it does in the batch '
            'branch; if it no longer does, the scoping comment on that branch is stale'
        )

    @patch('shared.tables.get_aggregates_table')
    def test_an_unknown_run_status_source_queries_nothing(
        self, mock_table, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """This branch DOES raise: it answers about one source, so a 400 is honest.

        The `errors` array this returns is the one field in the response that can
        carry a `ConfigurationError` message naming a namespace, which is why an
        unbounded query on an attacker-chosen partition mattered here.
        """
        table = mock_table.return_value

        from integrations_handler import lambda_handler

        event = self._status_event(api_gateway_event, {'run_status': 'not_a_plugin'})
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert table.query.call_args_list == [], (
            'a SOURCE_RUN# partition was queried for a source that is not a plugin'
        )

    @patch('shared.tables.get_aggregates_table')
    def test_the_control_a_real_plugin_id_still_returns_its_run_status(
        self, mock_table, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """Non-vacuity for the case above: the Scrapers page polls this every two
        seconds while a run is in flight, so refusing every source would leave a
        completed run showing as running forever."""
        table = mock_table.return_value
        table.query.return_value = {'Items': [{
            'sk': 'run_webscraper_1', 'status': 'completed', 'items_found': 7,
        }]}

        from integrations_handler import lambda_handler

        event = self._status_event(api_gateway_event, {'run_status': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert table.query.call_args_list, 'a configured plugin was not queried'
        assert body['status'] == 'completed'
        assert body['items_found'] == 7

    @patch('integrations_handler.events_client')
    def test_an_unavailable_allowlist_still_reports_every_source(
        self, mock_events, api_gateway_event, lambda_context, monkeypatch,
    ):
        """Fails OPEN when PLUGIN_SECRET_DEFAULTS is absent, here as elsewhere.

        `_is_addressable_source` delegates to `_validate_source_is_a_known_plugin`,
        which returns early in that state, so this route inherits the degradation
        rather than restating it. On a READ-only route the trade is easier than on
        the write routes: the worst case is the pre-allowlist behaviour, and this
        route never had an admin gate to fall back on.
        """
        import integrations_handler as h

        monkeypatch.delenv(h.PLUGIN_SECRET_DEFAULTS_VAR, raising=False)
        h._plugin_secret_defaults.cache_clear()
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.return_value = {
            'State': 'ENABLED', 'ScheduleExpression': 'rate(1 day)',
        }

        event = self._status_event(api_gateway_event, {'sources': 'custom_source'})
        response = h.lambda_handler(event, lambda_context)
        h._plugin_secret_defaults.cache_clear()

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['sources']['custom_source']['enabled'] is True

    def test_the_predicate_shares_the_rule_it_enforces(self):
        """`_is_addressable_source` must DELEGATE, not restate.

        A second copy of "is this a real plugin?" is how the batch branch comes to
        accept a value the path routes refuse. Parsed rather than behavioural
        because the equivalence is the property: a behavioural test would pass just
        as well against a duplicated rule that happens to agree today.
        """
        predicate = next(
            node for node in ast.parse(inspect.getsource(_handler_module())).body
            if isinstance(node, ast.FunctionDef) and node.name == '_is_addressable_source'
        )
        assert _calls_in(predicate) == {'_validate_source_parameter'}

    def test_the_route_uses_the_predicate_and_the_validator(self):
        """Both branches are guarded, and by the intended one of the two.

        The findability half matters as much as the assertion: if the route were
        renamed or its guards moved into a helper, `next` raises StopIteration here
        rather than this passing over a route that no longer exists.
        """
        route = next(
            node for node in ast.parse(inspect.getsource(_handler_module())).body
            if isinstance(node, ast.FunctionDef) and node.name == 'get_sources_status'
        )
        calls = _calls_in(route)
        assert '_is_addressable_source' in calls, 'the ?sources= branch is unguarded'
        assert '_validate_source_parameter' in calls, (
            'the ?run_status= branch is unguarded'
        )

    def test_the_route_is_deliberately_not_admin_gated(self):
        """Pins the one judgement here that is not "add the guard".

        `SourceCard.tsx` and `PluginConfigModal.tsx` both read this route for
        ordinary users, so gating it would blank the schedule state on the Settings
        page for non-admins. Recorded as a decision so a future reader does not
        read the absence as the same oversight the validation was.
        """
        route = next(
            node for node in ast.parse(inspect.getsource(_handler_module())).body
            if isinstance(node, ast.FunctionDef) and node.name == 'get_sources_status'
        )
        assert 'require_admin' not in _calls_in(route)


class TestTheStatusRouteDoesNotFanOutPerDuplicate:
    """`?sources=` describes each rule ONCE, however many times it was named.

    The class above bounds WHICH rules this route may describe. It does not bound
    how MANY calls it makes, and those are different properties: the list was
    neither de-duplicated nor capped, so the caller chose the AWS call count. This
    is the only read in the handler that fans out one call per list element.

    Measured before the fix, as a caller whose only Cognito group is `users`:

      ?sources=<one valid name × 500>  → 200, 500 describe_rule calls,
                                         1 key in the response body

    All 499 repeats overwrote the same `status[source]` entry, so they could not
    change the response — work unbounded by the caller against a fixed observable
    result, which is what makes it an amplifier rather than an inefficiency.
    `DescribeRule` is throttled per account, shared with the rest of the stack.

    Every assertion here is on the CALL COUNT rather than the body, deliberately:
    the body is identical with and without the fix, which is exactly why the nine
    cases in `TestTheQueryStringSourceRouteIsValidated` all pass on the pre-fix
    code. A body-only assertion cannot see this defect.
    """

    @staticmethod
    def _status_event(api_gateway_event, query):
        return _non_admin_event(
            api_gateway_event,
            method='GET',
            path='/sources/status',
            query_params=query,
        )

    @staticmethod
    def _stub(mock_events):
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.return_value = {
            'State': 'ENABLED', 'ScheduleExpression': 'rate(1 day)',
        }

    @patch('integrations_handler.events_client')
    def test_a_repeated_source_is_described_once(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The reported case: one valid name repeated many times, one AWS call."""
        self._stub(mock_events)

        from integrations_handler import lambda_handler

        event = self._status_event(
            api_gateway_event, {'sources': ','.join(['webscraper'] * 500)}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert mock_events.describe_rule.call_count == 1, (
            'a repeated source name fanned out one describe_rule call per '
            f'occurrence ({mock_events.describe_rule.call_count} calls)'
        )
        # The response is unchanged by de-duplication — stated as an assertion
        # because "the fix is observable to no caller" is the reason it is safe.
        assert body['sources']['webscraper']['enabled'] is True
        assert len(body['sources']) == 1

    @patch('integrations_handler.events_client')
    def test_the_control_distinct_sources_are_each_still_described(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """Non-vacuity: de-duplicating too eagerly would collapse a real request.

        A fix that described only the first entry, or dropped the loop, would make
        the call count trivially 1 and satisfy the case above. This asserts one call
        PER distinct source, and the ORDER, which `dict.fromkeys` preserves and a
        `set` would not.

        Deliberately duplicate-free input, so this control stays GREEN under the
        very mutation it controls for — the pre-fix code describes two distinct
        sources twice as well. A control that fails alongside its subject proves
        nothing about vacuity.
        """
        self._stub(mock_events)

        from integrations_handler import lambda_handler

        event = self._status_event(
            api_gateway_event, {'sources': 'webscraper,s3_import'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert mock_events.describe_rule.call_count == 2, (
            'two distinct sources were not each described exactly once'
        )
        described = [c.kwargs['Name'] for c in mock_events.describe_rule.call_args_list]
        assert described == [
            'voc-ingest-webscraper-schedule', 'voc-ingest-s3_import-schedule',
        ]
        assert set(body['sources']) == {'webscraper', 's3_import'}

    @patch('integrations_handler.events_client')
    def test_a_source_list_over_the_cap_is_refused_before_any_lookup(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The cap raises rather than truncating, and describes nothing first.

        A malformed REQUEST, unlike an unaddressable source: there is no per-entry
        answer to report, so this branch behaves like the write path's key-count
        guard. Asserting no call happened is the load-bearing half — a route that
        answered 400 after describing 51 rules would pass a status-only assertion.
        """
        from integrations_handler import (
            MAX_SOURCES_PER_STATUS_REQUEST,
            lambda_handler,
        )

        self._stub(mock_events)
        too_many = ','.join(
            f'plugin_{i}' for i in range(MAX_SOURCES_PER_STATUS_REQUEST + 1)
        )
        event = self._status_event(api_gateway_event, {'sources': too_many})
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert mock_events.describe_rule.call_args_list == []

    @patch('integrations_handler.events_client')
    def test_the_control_a_list_at_the_cap_is_still_answered(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """Non-vacuity for the cap: an off-by-one that refused the limit itself
        would satisfy the case above, and the cap is meant to bound abuse rather
        than any request a caller could legitimately make."""
        from integrations_handler import (
            MAX_SOURCES_PER_STATUS_REQUEST,
            lambda_handler,
        )

        self._stub(mock_events)
        at_cap = ','.join(
            f'plugin_{i}' for i in range(MAX_SOURCES_PER_STATUS_REQUEST)
        )
        event = self._status_event(api_gateway_event, {'sources': at_cap})
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        # None is a configured plugin, so the allowlist answers all of them and
        # EventBridge is never reached — the cap is what is under test, and it
        # must not fire at exactly the limit.
        assert len(json.loads(response['body'])['sources']) == (
            MAX_SOURCES_PER_STATUS_REQUEST
        )

    @patch('integrations_handler.events_client')
    def test_the_cap_counts_distinct_sources_not_typed_ones(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """De-duplication runs BEFORE the cap, which is the useful order.

        The bound that matters is the number of rules actually described, so a
        caller who repeats one legitimate name past the cap is answered rather than
        refused. Capping the typed list first would reject a request that costs one
        AWS call.
        """
        from integrations_handler import (
            MAX_SOURCES_PER_STATUS_REQUEST,
            lambda_handler,
        )

        self._stub(mock_events)
        event = self._status_event(api_gateway_event, {
            'sources': ','.join(
                ['webscraper'] * (MAX_SOURCES_PER_STATUS_REQUEST + 10)
            ),
        })
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert mock_events.describe_rule.call_count == 1

    @patch('integrations_handler.events_client')
    def test_the_default_request_is_unaffected_by_either_guard(
        self, mock_events, api_gateway_event, lambda_context, plugin_secret_defaults,
    ):
        """The regression control, on the path every Settings render takes.

        `SourceCard.tsx` calls `getSourcesStatus()` with no argument, so the
        fallback list must reach the loop untouched by de-duplication or the cap —
        it holds no duplicates and three entries, and `manual_import` among them is
        a deliberate non-plugin.
        """
        mock_events.exceptions.ResourceNotFoundException = type(
            'ResourceNotFoundException', (Exception,), {}
        )
        mock_events.describe_rule.side_effect = (
            mock_events.exceptions.ResourceNotFoundException
        )

        from integrations_handler import lambda_handler

        event = self._status_event(api_gateway_event, {})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert set(body['sources']) == {'webscraper', 'manual_import', 's3_import'}
