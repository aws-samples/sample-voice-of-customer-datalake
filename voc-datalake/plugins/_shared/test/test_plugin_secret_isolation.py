"""Plugin secret prefix isolation fails CLOSED (issue #251).

`plugins/_shared/secrets.py` is the only place a plugin Lambda turns the shared
API-credentials secret into its own config. All ingestion Lambdas share one IAM
role, so that prefix scan is the entire isolation boundary — there is no second
layer to catch a mistake.

REVERT MAP — each assertion below names the mutation it catches:

  test_a_namespace_miss_raises_instead_of_returning_the_whole_secret
    — restores `return filtered if filtered else all_secrets`. That line is the
      defect: a plugin id with a typo matched nothing, and "nothing" was read as
      "not migrated yet", so the plugin received EVERY plugin's credentials. The
      positive control in the same class proves the raise is conditional and not
      a helper that now refuses everything.

  test_an_empty_secret_raises
    — treats `{}` as an empty namespace and returns it. `get_secret` returns `{}`
      for a genuinely empty secret AND for a read that failed (it logs and
      swallows), so a plugin would run credential-less believing it was
      configured.

  test_a_key_outside_every_plugin_namespace_is_not_returned
    — restores BaseIngestor's "no KNOWN prefix means shared/legacy" branch and
      the hand-maintained plugin-id list it needed. Under that branch a plugin id
      missing from the list had its keys reclassified as shared and leaked into
      every other plugin.

  test_a_bare_prefix_key_does_not_count_as_a_match
    — drops the `len(key) > len(prefix)` guard, which both hands the plugin a
      value under the empty key name and lets a single junk key `test_source_`
      satisfy the fail-closed check for a namespace that is otherwise absent.

  test_the_error_names_the_identity_and_prefix_and_nothing_else /
  test_the_log_carries_the_identity_and_prefix_and_no_secret_material
    — widens the message to dump the secret's keys or values "to help debug".
      The failure here is a mis-prefixed plugin; answering it with a list of the
      other plugins' key names turns a misconfiguration into reconnaissance.

  test_both_base_classes_delegate_to_the_one_helper
    — re-inlines the filter into either base class. The webhook copy is how the
      two drifted in the first place: it never had even the (broken) known-prefix
      list that the ingestor copy carried.

Known consequence, deliberate: a plugin that declares NO secret keys in its
manifest now fails at construction rather than silently receiving every other
plugin's keys. Every current plugin declares at least one key and CDK seeds them
all at deploy time, so no shipped plugin is affected; a future one that needs no
configuration should declare a key or not call the base constructor's secret
read, and the error tells it which prefix was expected.
"""

import ast
import inspect
import textwrap
from unittest.mock import MagicMock, patch

import pytest
from shared.exceptions import ConfigurationError

from _shared import base_ingestor, base_webhook
from _shared.secrets import filter_plugin_secrets, plugin_secret_prefix

# The identity these tests run as — read from the same module attribute the base
# classes read, so a rename of the env plumbing cannot leave this file asserting
# against a plugin id that is no longer in play.
PLUGIN_ID = base_ingestor.SOURCE_PLATFORM
PREFIX = plugin_secret_prefix(PLUGIN_ID)

# A shared secret shaped like the deployed one: several plugins' namespaces plus
# the `placeholder` key Secrets Manager generates. Values are recognisable so an
# assertion can prove a leak by content, not only by key name.
OTHER_PLUGIN_KEY = 'synthetic_reviews_company_name'
OTHER_PLUGIN_VALUE = 'other-plugins-value'
UNPREFIXED_KEY = 'placeholder'
UNPREFIXED_VALUE = 'generated-by-secrets-manager'

MIXED_SECRET = {
    f'{PREFIX}api_key': 'mine-key',
    f'{PREFIX}configs': '[]',
    OTHER_PLUGIN_KEY: OTHER_PLUGIN_VALUE,
    UNPREFIXED_KEY: UNPREFIXED_VALUE,
}

# The same payload with THIS plugin's namespace removed: what a mis-prefixed
# identity really sees in production.
FOREIGN_ONLY_SECRET = {
    OTHER_PLUGIN_KEY: OTHER_PLUGIN_VALUE,
    UNPREFIXED_KEY: UNPREFIXED_VALUE,
}


def _make_ingestor():
    class _Ingestor(base_ingestor.BaseIngestor):
        def fetch_new_items(self):
            yield from []

    return _Ingestor()


def _make_webhook():
    class _Webhook(base_webhook.BaseWebhook):
        def parse_webhook_payload(self, body, headers):
            return []

    return _Webhook()


class TestOnlyThisPluginsNamespaceIsLoaded:
    """A valid identity gets its own namespace, in the shape handlers consume."""

    def test_returns_only_this_plugins_keys_with_the_prefix_stripped(self):
        assert filter_plugin_secrets(PLUGIN_ID, MIXED_SECRET) == {
            'api_key': 'mine-key',
            'configs': '[]',
        }

    def test_a_key_outside_every_plugin_namespace_is_not_returned(self):
        loaded = filter_plugin_secrets(PLUGIN_ID, MIXED_SECRET)
        assert UNPREFIXED_KEY not in loaded
        assert UNPREFIXED_VALUE not in loaded.values()

    def test_another_plugins_namespace_is_not_returned(self):
        loaded = filter_plugin_secrets(PLUGIN_ID, MIXED_SECRET)
        assert OTHER_PLUGIN_VALUE not in loaded.values()
        # Not under its stored name and not under a stripped one either.
        assert not any('company_name' in key for key in loaded)

    def test_the_consumer_facing_key_shape_is_the_bare_field_name(self):
        """Handlers call `self.secrets.get('configs')`, never the stored
        `<plugin>_configs`. The stripped shape is the contract, so it is asserted
        rather than left implied by the equality above."""
        loaded = filter_plugin_secrets(PLUGIN_ID, MIXED_SECRET)
        assert 'configs' in loaded
        assert f'{PREFIX}configs' not in loaded


class TestANamespaceMissFailsClosed:
    """Zero matching keys is a configuration error, never the whole secret."""

    def test_a_namespace_miss_raises_instead_of_returning_the_whole_secret(self):
        with pytest.raises(ConfigurationError):
            filter_plugin_secrets(PLUGIN_ID, FOREIGN_ONLY_SECRET)

    def test_the_positive_control_same_payload_plus_our_namespace_succeeds(self):
        """Non-vacuity: every assertion in this class would pass just as well
        against a helper that refuses every input. One key inside our namespace
        must be enough to make the identical call succeed.

        Deliberately asserts only that the call RETURNS and carries our key, not
        the exact mapping — exclusion of everything else is the subject of
        TestOnlyThisPluginsNamespaceIsLoaded. Asserting equality here would make
        this control fail under the fail-open mutation too, and a control that
        fails alongside the thing it controls proves nothing.
        """
        payload = {**FOREIGN_ONLY_SECRET, f'{PREFIX}api_key': 'mine-key'}
        assert filter_plugin_secrets(PLUGIN_ID, payload)['api_key'] == 'mine-key'

    def test_a_mis_prefixed_identity_raises_though_a_close_prefix_exists(self):
        """The typo case from the issue: `test_sourc` for `test_source`. The
        secret is fully populated for the CORRECT id, which is what made the old
        fallback so damaging — the miss looked like a not-yet-migrated plugin."""
        typo = PLUGIN_ID[:-1]
        assert typo and typo != PLUGIN_ID
        with pytest.raises(ConfigurationError):
            filter_plugin_secrets(typo, MIXED_SECRET)

    def test_an_empty_secret_raises(self):
        with pytest.raises(ConfigurationError):
            filter_plugin_secrets(PLUGIN_ID, {})

    def test_a_bare_prefix_key_does_not_count_as_a_match(self):
        with pytest.raises(ConfigurationError):
            filter_plugin_secrets(PLUGIN_ID, {PREFIX: 'junk', **FOREIGN_ONLY_SECRET})

    @pytest.mark.parametrize(
        'identity',
        ['', None, 'Test_Source', 'test-source', '_test_source', 'test_source_', 'a' * 65],
        ids=['empty', 'none', 'uppercase', 'hyphen', 'leading_underscore',
             'trailing_underscore', 'too_long'],
    )
    def test_a_missing_or_malformed_identity_raises(self, identity):
        """A plugin id becomes a key prefix, so it is validated on the same
        character class the write path enforces on `source`. An empty identity is
        the one that matters most: `prefix = '_'` would otherwise match nothing
        and, under the old fallback, return everything."""
        with pytest.raises(ConfigurationError):
            filter_plugin_secrets(identity, MIXED_SECRET)


class TestErrorsRevealTheMisconfigurationAndNothingElse:
    """Identity and expected prefix only — no credential material."""

    @staticmethod
    def _message_for(identity, payload):
        with pytest.raises(ConfigurationError) as excinfo:
            filter_plugin_secrets(identity, payload)
        return str(excinfo.value)

    def test_the_error_names_the_identity_and_prefix_and_nothing_else(self):
        message = self._message_for(PLUGIN_ID, FOREIGN_ONLY_SECRET)
        assert PLUGIN_ID in message
        assert PREFIX in message
        # Nothing about the keys or values that DO exist in the secret.
        assert OTHER_PLUGIN_KEY not in message
        assert OTHER_PLUGIN_VALUE not in message
        assert UNPREFIXED_KEY not in message
        assert UNPREFIXED_VALUE not in message

    def test_the_empty_secret_error_also_names_the_prefix(self):
        message = self._message_for(PLUGIN_ID, {})
        assert PLUGIN_ID in message
        assert PREFIX in message

    def test_the_log_carries_the_identity_and_prefix_and_no_secret_material(self):
        # The module logger is the Powertools `Logger`, which is service-named and
        # does not propagate, so `caplog` never sees it. Patching the logger
        # object is what the neighbouring plugin suites do (test_sqs_utils.py).
        with patch('_shared.secrets.logger') as mock_logger, \
                pytest.raises(ConfigurationError):
            filter_plugin_secrets(PLUGIN_ID, FOREIGN_ONLY_SECRET)

        assert mock_logger.error.call_args_list, (
            'a namespace miss must be logged, not only raised'
        )
        call = mock_logger.error.call_args
        assert call.kwargs['extra'] == {
            'plugin_id': PLUGIN_ID,
            'expected_prefix': PREFIX,
        }
        # The whole call — message AND extra — must be free of secret material.
        # Asserting on the message alone would miss an `extra` that attached the
        # payload, which is the more likely way this regresses.
        rendered = repr(call)
        assert OTHER_PLUGIN_KEY not in rendered
        assert OTHER_PLUGIN_VALUE not in rendered
        assert UNPREFIXED_VALUE not in rendered

    def test_the_log_control_a_successful_load_logs_nothing(self):
        """Non-vacuity for the assertion above: without this, a refusal logged
        unconditionally on every load would satisfy it."""
        with patch('_shared.secrets.logger') as mock_logger:
            filter_plugin_secrets(PLUGIN_ID, MIXED_SECRET)

        assert mock_logger.error.call_args_list == []
        assert mock_logger.warning.call_args_list == []


class TestBothBaseClassesFailClosed:
    """Thin integration checks: the behaviour reaches real construction."""

    @staticmethod
    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def _ingestor_with(payload, mock_get_secret, mock_sqs, mock_s3, mock_dynamo):
        mock_get_secret.return_value = payload
        mock_dynamo.return_value.Table.return_value = MagicMock()
        return _make_ingestor()

    @staticmethod
    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def _webhook_with(payload, mock_get_secret, mock_sqs):
        mock_get_secret.return_value = payload
        return _make_webhook()

    def test_the_ingestor_loads_only_its_own_namespace(self):
        assert self._ingestor_with(MIXED_SECRET).secrets == {
            'api_key': 'mine-key',
            'configs': '[]',
        }

    def test_the_webhook_loads_only_its_own_namespace(self):
        assert self._webhook_with(MIXED_SECRET).secrets == {
            'api_key': 'mine-key',
            'configs': '[]',
        }

    @pytest.mark.parametrize(
        'payload',
        [FOREIGN_ONLY_SECRET, {}],
        ids=['unknown_prefix', 'empty_secret'],
    )
    def test_the_ingestor_refuses_to_construct(self, payload):
        with pytest.raises(ConfigurationError):
            self._ingestor_with(payload)

    @pytest.mark.parametrize(
        'payload',
        [FOREIGN_ONLY_SECRET, {}],
        ids=['unknown_prefix', 'empty_secret'],
    )
    def test_the_webhook_refuses_to_construct(self, payload):
        with pytest.raises(ConfigurationError):
            self._webhook_with(payload)

    def test_an_unconfigured_secrets_arn_still_yields_an_empty_config(self):
        """The one case that is NOT a namespace miss: no ARN means no secret was
        read at all, so there is nothing to over-share. Kept a warning so a local
        or partially-wired invocation is not turned into a hard failure by this
        change."""
        with patch('_shared.base_ingestor.SECRETS_ARN', ''):
            assert self._ingestor_with({'unused': 'never-read'}).secrets == {}
        with patch('_shared.base_webhook.SECRETS_ARN', ''):
            assert self._webhook_with({'unused': 'never-read'}).secrets == {}


class TestOneImplementationOfTheBoundary:
    """Neither base class may carry its own copy of the filter.

    The ingestor and webhook copies had already drifted — only one of them ever
    had the (broken) known-prefix list — so "both call the same function" is the
    property worth pinning, not the behaviour of each copy.
    """

    @staticmethod
    def _load_secrets_body(module):
        """The `_load_secrets` function body, parsed. Scoped to one function
        deliberately: a regex over the module would match the prefix arithmetic
        that legitimately lives in `secrets.py`-style helpers elsewhere."""
        cls = base_ingestor.BaseIngestor if module is base_ingestor else base_webhook.BaseWebhook
        source = textwrap.dedent(inspect.getsource(cls._load_secrets))
        return ast.parse(source).body[0]

    @pytest.mark.parametrize('module', [base_ingestor, base_webhook],
                             ids=['ingestor', 'webhook'])
    def test_both_base_classes_delegate_to_the_one_helper(self, module):
        tree = self._load_secrets_body(module)
        called = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        assert 'filter_plugin_secrets' in called, (
            f'{module.__name__}._load_secrets must delegate to the shared helper'
        )

    @pytest.mark.parametrize('module', [base_ingestor, base_webhook],
                             ids=['ingestor', 'webhook'])
    def test_neither_base_class_re_implements_the_prefix_scan(self, module):
        tree = self._load_secrets_body(module)
        attribute_calls = {
            node.func.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        assert 'startswith' not in attribute_calls, (
            f'{module.__name__}._load_secrets appears to filter by prefix itself; '
            'the scan belongs in _shared/secrets.py alone'
        )

    def test_the_findability_control_the_parser_reads_a_real_body(self):
        """Non-vacuity: if `_load_secrets` were renamed or the parse returned an
        empty tree, both assertions above would fail rather than pass silently —
        but this makes the failure say so. It also pins that the two bodies are
        actually distinct functions, not one inherited from the other."""
        for module in (base_ingestor, base_webhook):
            tree = self._load_secrets_body(module)
            assert isinstance(tree, ast.FunctionDef)
            assert tree.name == '_load_secrets'
            assert len(tree.body) > 1, 'expected a real body, not a stub'
        assert (base_ingestor.BaseIngestor._load_secrets
                is not base_webhook.BaseWebhook._load_secrets)
