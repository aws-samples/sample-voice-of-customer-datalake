"""Plugin secret prefix isolation fails CLOSED (issue #251).

`plugins/_shared/plugin_secrets.py` is the only place a plugin Lambda turns the
shared API-credentials secret into its own config. All ingestion Lambdas share one
IAM role, so that prefix scan is the entire isolation boundary — there is no
second layer to catch a mistake.

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

  test_a_transient_read_failure_is_retried_on_the_next_invocation
    — drops the `clear_secret_cache()` in either `_load_secrets` empty-payload
      branch. `get_secret` is lru_cached and swallows every exception into `{}`,
      so without the eviction ONE transient Secrets Manager blip caches that `{}`
      and every later invocation in the warm container raises off the cache with
      no further API call. Only a manual "Run now" clears it, so a SCHEDULED
      plugin — and a webhook, which has no manual run at all — stays wedged for
      the container's lifetime.

  test_a_namespace_miss_moves_the_run_record_to_error /
  test_a_namespace_miss_records_a_circuit_breaker_failure /
  test_a_namespace_miss_emits_a_plugin_failed_audit_event
    — removes `_report_construction_failure` from `BaseIngestor.__init__`, or
      moves the secret read back above the tables it needs. `_load_secrets` runs
      in `__init__`, so the raise never reaches `run()`'s except block: the
      `SOURCE_RUN#` record stays at the 'running' that `run_source` wrote before
      invoking, and the UI polls it with no timeout — a permanent spinner with the
      diagnosis only in CloudWatch.

  test_an_unreadable_secret_is_not_counted_against_the_circuit_breaker
    — raises plain `ConfigurationError` from the empty-payload branch instead of
      `SecretUnreadableError`, or drops the `if not unreadable` guard around
      `record_failure`. `get_secret` swallows every client error into `{}`, so an
      empty payload can be an AWS-side throttle. At the default threshold (5 in 15
      minutes) counting those calls `_trip_breaker`, which disables the plugin's
      EventBridge schedule — and nothing in this tree re-enables one, so a healthy
      plugin's ingestion stops until an operator notices. The sibling assertion
      that a NAMESPACE MISS still counts is what stops this becoming "the breaker
      no longer fires".

  test_a_non_object_payload_is_not_the_unreadable_type /
  test_a_non_object_payload_is_counted_against_the_circuit_breaker
    — folds `not isinstance(all_secrets, Mapping)` back into the empty-payload
      branch. `get_secret` does `json.loads`, so a secret whose body is a JSON
      array, string or number arrives as a non-Mapping — a permanent mistake, not a
      throttle. Classified as "unreadable" it would escape the breaker and retry on
      every schedule tick forever, and be logged as "payload is empty" while
      populated.

  test_a_real_aws_call_is_refused /
  test_the_attempt_is_recorded_even_when_the_code_swallows_it
    — removes `no_real_aws_calls` from `plugins/conftest.py`, or reduces it to
      refusing without recording. Because `_report_construction_failure` now runs
      the circuit breaker on the construction path, and `_shared.circuit_breaker`
      resolves DynamoDB through its OWN import, three tests here issued a genuine
      `dynamodb.Query` against whatever account the runner held credentials for —
      invisibly, since `record_failure` swallowed the result. Refusing alone would
      be swallowed the same way, so the attempt is recorded and asserted at
      teardown.

  test_the_identity_rule_is_the_one_the_write_path_enforces
    — re-inlines the character class into either path. A read that refuses an
      identity the write path accepted is the same drift, one level up, that two
      copies of the prefix scan produced. Its control catches the load being done
      by `sys.path.insert` + `import_module` again, which left `lambda/api` on the
      path and the handler in `sys.modules` for the whole session.

  test_no_plugin_id_is_a_namespace_prefix_of_another
    — the collision the scan cannot see: `app_reviews` alongside
      `app_reviews_ios` would receive the latter's keys under mangled names. Not
      preventable here (a plugin knows only its own id, by design), so this
      asserts the synth-time guard in `plugin-loader.ts` and the tree agree.

  test_every_plugin_declares_at_least_one_secret_key
    — the deploy-time invariant this change introduces, otherwise unpinned: a
      plugin whose manifest declares no `secrets` block gets no `<id>_*` key
      seeded, so its Lambda dies at construction. That fails in CI here rather
      than in a production Lambda.

Known consequence, deliberate: a plugin that declares NO secret keys in its
manifest now fails at construction rather than silently receiving every other
plugin's keys. Every current plugin declares at least one key and CDK seeds them
all at deploy time (both pinned below), so no shipped plugin is affected; a future
one that needs no configuration should declare a key or not call the base
constructor's secret read, and the error tells it which prefix was expected.
"""

import ast
import inspect
import json
import textwrap
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import shared.aws as shared_aws
from shared.exceptions import ConfigurationError, SecretUnreadableError
from shared.plugin_identity import is_valid_plugin_identifier

from _shared import base_ingestor, base_webhook
from _shared.plugin_secrets import filter_plugin_secrets, plugin_secret_prefix

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


def _make_ingestor(execution_id=None):
    class _Ingestor(base_ingestor.BaseIngestor):
        def fetch_new_items(self):
            yield from []

    return _Ingestor(execution_id=execution_id)


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
        with patch('_shared.plugin_secrets.logger') as mock_logger, \
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
        with patch('_shared.plugin_secrets.logger') as mock_logger:
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
    # `_report_construction_failure` runs on the refusal cases below, and
    # `CircuitBreaker` resolves DynamoDB through `_shared.circuit_breaker`'s OWN
    # `get_dynamodb_resource` import — patching `base_ingestor`'s does not reach it,
    # so an unpatched breaker issues a genuine `dynamodb.Query` and `record_failure`
    # swallows the result. Pinned by plugins/conftest.py::no_real_aws_calls.
    @patch.object(base_ingestor.CircuitBreaker, 'record_failure')
    def _ingestor_with(payload, mock_record_failure, mock_get_secret, mock_sqs, mock_s3, mock_dynamo):
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
            'the scan belongs in _shared/plugin_secrets.py alone'
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


class TestATransientReadFailureIsRetryable:
    """A blip must not wedge the warm container.

    `shared.aws.get_secret` is `lru_cache`d and swallows EVERY exception into
    `{}`. Under the old fail-open filter that cached `{}` produced a wrong but
    non-fatal run; now it correctly raises — which makes the caching itself the
    problem, because the raise would then repeat on every later invocation in the
    container with NO further API call. Only a manual "Run now" clears the cache
    (`clear_secret_cache()` via `execution_id`), so a scheduled plugin, and a
    webhook which has no manual run at all, would stay broken until recycled.

    Driven through the real `get_secret` and a stubbed Secrets Manager client
    rather than a patched `get_secret`, deliberately: the cache is the subject, and
    patching the function that holds it removes the thing under test.
    """

    @staticmethod
    def _client_failing_once():
        """A Secrets Manager client that fails the first read, then succeeds."""
        client = MagicMock()
        client.get_secret_value.side_effect = [
            Exception('Throttled'),
            {'SecretString': json.dumps(MIXED_SECRET)},
        ]
        return client

    @pytest.mark.parametrize('kind', ['ingestor', 'webhook'], ids=['ingestor', 'webhook'])
    def test_a_transient_read_failure_is_retried_on_the_next_invocation(self, kind):
        client = self._client_failing_once()
        shared_aws.clear_secret_cache()

        with patch('shared.aws.get_secrets_client', return_value=client), \
                patch('_shared.base_ingestor.get_dynamodb_resource') as mock_dynamo, \
                patch('_shared.base_ingestor.get_s3_client'), \
                patch('_shared.base_ingestor.get_sqs_client'), \
                patch('_shared.base_webhook.get_sqs_client'), \
                patch.object(base_ingestor.CircuitBreaker, 'record_failure'):
            # The breaker is patched even though a SecretUnreadableError does not
            # reach it today: a test about the secret CACHE should not depend on how
            # the breaker classifies the error, and an unpatched breaker reaches real
            # DynamoDB (see plugins/conftest.py::no_real_aws_calls).
            mock_dynamo.return_value.Table.return_value = MagicMock()
            construct = _make_ingestor if kind == 'ingestor' else _make_webhook

            # First invocation: the read fails, `get_secret` returns {} and caches
            # it, and construction refuses to proceed on an empty secret.
            with pytest.raises(ConfigurationError):
                construct()

            # Second invocation in the SAME process — a warm container. It must
            # reach the client again and succeed.
            loaded = construct()

        assert loaded.secrets == {'api_key': 'mine-key', 'configs': '[]'}
        assert client.get_secret_value.call_count == 2, (
            'the failed read stayed memoized: the second construction never '
            'consulted Secrets Manager again'
        )

    def test_the_control_a_successful_read_is_still_cached(self):
        """Non-vacuity, and the property the eviction must not cost: the cache
        still serves a SUCCESSFUL read, so the fix did not turn every invocation
        into a Secrets Manager call. Without this, `clear_secret_cache()` on every
        load would satisfy the assertion above."""
        client = MagicMock()
        client.get_secret_value.return_value = {'SecretString': json.dumps(MIXED_SECRET)}
        shared_aws.clear_secret_cache()

        with patch('shared.aws.get_secrets_client', return_value=client), \
                patch('_shared.base_ingestor.get_dynamodb_resource') as mock_dynamo, \
                patch('_shared.base_ingestor.get_s3_client'), \
                patch('_shared.base_ingestor.get_sqs_client'):
            mock_dynamo.return_value.Table.return_value = MagicMock()
            _make_ingestor()
            _make_ingestor()

        assert client.get_secret_value.call_count == 1


class TestAConstructionFailureIsReported:
    """The raise happens in `__init__`, so it must report for itself.

    Every `lambda_handler` constructs the ingestor before calling `run()`, so a
    `ConfigurationError` from `_load_secrets` never reaches run()'s `except` — the
    block that writes the `SOURCE_RUN#` record, records the circuit-breaker
    failure and emits `plugin.failed`. `integrations_handler.run_source` writes
    `status: 'running'` BEFORE invoking, and the UI polls until a terminal status
    with no timeout, so an unreported construction failure is a permanent
    "Running..." spinner.
    """

    EXECUTION_ID = 'exec-abc123'

    @staticmethod
    def _construct(payload, execution_id):
        """Construct with a manual-run execution_id, returning the mocked table.

        `AGGREGATES_TABLE` is patched to a non-empty name because
        `_update_source_run_status` is a no-op without one, and `plugins/conftest.py`
        does not set it.
        """
        table = MagicMock()
        with patch('_shared.base_ingestor.AGGREGATES_TABLE', 'test-aggregates'), \
                patch('_shared.base_ingestor.get_dynamodb_resource') as mock_dynamo, \
                patch('_shared.base_ingestor.get_s3_client'), \
                patch('_shared.base_ingestor.get_sqs_client'), \
                patch('_shared.base_ingestor.get_secret', return_value=payload), \
                patch('_shared.base_ingestor.clear_secret_cache'), \
                patch.object(base_ingestor.CircuitBreaker, 'record_failure') as record_failure, \
                patch('_shared.base_ingestor.emit_audit_event') as emit:
            mock_dynamo.return_value.Table.return_value = table
            error = None
            try:
                _make_ingestor(execution_id=execution_id)
            except ConfigurationError as raised:
                error = raised
        return error, table, record_failure, emit

    @staticmethod
    def _status_written(table):
        """The `status` value the run record was last updated to, or None."""
        for call in table.update_item.call_args_list:
            values = call.kwargs.get('ExpressionAttributeValues', {})
            if ':status' in values:
                return values[':status']
        return None

    def test_a_namespace_miss_moves_the_run_record_to_error(self):
        error, table, _, _ = self._construct(FOREIGN_ONLY_SECRET, self.EXECUTION_ID)

        assert error is not None, 'expected construction to refuse the payload'
        assert self._status_written(table) == 'error', (
            "the run record was left at the 'running' that run_source wrote, so "
            'the UI would poll it forever'
        )

    def test_the_run_record_is_addressed_by_this_execution(self):
        """The record the UI polls, not just any record: `run_source` keys it
        `SOURCE_RUN#<source>` / `<execution_id>`, and a write to a different sort
        key would leave the polled one at 'running' while this test passed."""
        _, table, _, _ = self._construct(FOREIGN_ONLY_SECRET, self.EXECUTION_ID)

        keys = [call.kwargs.get('Key') for call in table.update_item.call_args_list]
        assert {'pk': f'SOURCE_RUN#{PLUGIN_ID}', 'sk': self.EXECUTION_ID} in keys

    def test_a_namespace_miss_records_a_circuit_breaker_failure(self):
        """Otherwise a plugin broken this way never auto-disables its schedule —
        it just fails every fifteen minutes forever."""
        _, _, record_failure, _ = self._construct(FOREIGN_ONLY_SECRET, self.EXECUTION_ID)

        assert record_failure.call_args_list, 'the circuit breaker saw nothing'

    def test_a_namespace_miss_emits_a_plugin_failed_audit_event(self):
        _, _, _, emit = self._construct(FOREIGN_ONLY_SECRET, self.EXECUTION_ID)

        actions = [call.args[0] for call in emit.call_args_list if call.args]
        assert 'plugin.failed' in actions

    def test_the_report_does_not_replace_the_error_the_operator_needs(self):
        """The reporting runs while a ConfigurationError is propagating. If a
        DynamoDB failure there escaped, it would mask the only message that says
        which prefix was expected — so the original must still arrive even when
        every reporting step throws."""
        table = MagicMock()
        table.update_item.side_effect = Exception('DynamoDB unavailable')

        with patch('_shared.base_ingestor.AGGREGATES_TABLE', 'test-aggregates'), \
                patch('_shared.base_ingestor.get_dynamodb_resource') as mock_dynamo, \
                patch('_shared.base_ingestor.get_s3_client'), \
                patch('_shared.base_ingestor.get_sqs_client'), \
                patch('_shared.base_ingestor.get_secret', return_value=FOREIGN_ONLY_SECRET), \
                patch.object(base_ingestor.CircuitBreaker, 'record_failure',
                             side_effect=Exception('table gone')), \
                patch('_shared.base_ingestor.emit_audit_event',
                      side_effect=Exception('bus gone')):
            mock_dynamo.return_value.Table.return_value = table
            with pytest.raises(ConfigurationError) as excinfo:
                _make_ingestor()

        assert PREFIX in str(excinfo.value)

    def test_the_control_a_successful_construction_reports_nothing(self):
        """Non-vacuity: an unconditional error write would satisfy every
        assertion above."""
        error, table, record_failure, emit = self._construct(MIXED_SECRET, self.EXECUTION_ID)

        assert error is None
        assert self._status_written(table) is None
        assert record_failure.call_args_list == []
        assert [call.args[0] for call in emit.call_args_list if call.args] == []


class TestAnUnreadableSecretIsNotAPluginFailure:
    """A throttle must not auto-disable a healthy plugin's schedule.

    `shared.aws.get_secret` logs and swallows EVERY client error into `{}`, so an
    empty payload means either "genuinely empty" or "the read failed" — the same
    ambiguity the cache eviction acknowledges. Reporting it is right; COUNTING it is
    not: `CircuitBreaker.record_failure` trips at 5 failures in 15 minutes by
    default, and `_trip_breaker` calls `events.disable_rule` on the plugin's
    EventBridge schedule. Nothing in this tree re-enables a disabled rule and
    `record_success` only resets on a run that completes, so five Secrets Manager
    blips inside one window stop a healthy plugin's ingestion until an operator
    notices and re-enables it by hand.

    The fail-OPEN code could not do this — a transient `{}` never raised — so this
    is availability coupling the fail-closed direction introduced, not something
    pre-existing.

    The empty-payload branch therefore raises `SecretUnreadableError`, a
    `ConfigurationError` subclass so nothing that catches the parent stops working,
    and `_report_construction_failure` skips only the breaker for it.
    """

    # Reuses the construction harness above rather than restating it: the subject is
    # which of the three reporting effects fire, and those are exactly what it
    # returns.
    _construct = staticmethod(TestAConstructionFailureIsReported._construct)
    _status_written = staticmethod(TestAConstructionFailureIsReported._status_written)
    EXECUTION_ID = TestAConstructionFailureIsReported.EXECUTION_ID

    def test_an_empty_secret_raises_the_narrower_unreadable_type(self):
        """The classification itself, at the raise site. Asserted separately from
        the breaker behaviour below so a failure says WHICH of the two halves broke
        — the type or the branch that reads it."""
        with pytest.raises(SecretUnreadableError):
            filter_plugin_secrets(PLUGIN_ID, {})

    def test_a_namespace_miss_is_not_the_unreadable_type(self):
        """The other side of the classification: a populated secret that simply has
        no key for this plugin IS someone's mistake, and must stay a plain
        `ConfigurationError`. Without this, raising `SecretUnreadableError` from
        every branch would satisfy the assertion above and silently stop the breaker
        from ever firing."""
        with pytest.raises(ConfigurationError) as excinfo:
            filter_plugin_secrets(PLUGIN_ID, FOREIGN_ONLY_SECRET)

        assert not isinstance(excinfo.value, SecretUnreadableError)

    def test_the_unreadable_type_is_still_caught_as_a_configuration_error(self):
        """Subclassing is the compatibility promise: `BaseIngestor.__init__` and
        every plugin handler catch `ConfigurationError`, and a sibling type would
        escape all of them — turning a handled misconfiguration into an unhandled
        crash. Cheap to assert, and the reason this is not a new top-level
        exception."""
        assert issubclass(SecretUnreadableError, ConfigurationError)

    def test_an_unreadable_secret_is_not_counted_against_the_circuit_breaker(self):
        error, _, record_failure, _ = self._construct({}, self.EXECUTION_ID)

        assert isinstance(error, SecretUnreadableError), (
            'expected construction to refuse an empty payload'
        )
        assert record_failure.call_args_list == [], (
            'a transient Secrets Manager failure was counted as a plugin failure; '
            'five in one window disable the schedule of a plugin that is fine'
        )

    def test_the_control_a_namespace_miss_still_is_counted(self):
        """Non-vacuity, and the property the exemption must not cost: the breaker
        still fires for a genuine misconfiguration. Without this, dropping
        `record_failure` altogether — or widening the exemption to every
        `ConfigurationError` — passes the assertion above while removing the
        auto-disable entirely, which is a defect in the opposite direction."""
        _, _, record_failure, _ = self._construct(FOREIGN_ONLY_SECRET, self.EXECUTION_ID)

        assert record_failure.call_args_list, (
            'a namespace miss is a misconfiguration and retrying it forever is what '
            'the breaker exists to stop'
        )

    def test_a_non_object_payload_is_not_the_unreadable_type(self):
        """`get_secret` does `json.loads`, which succeeds for any valid JSON — so a
        secret whose body is `["a", "b"]`, `"oops"` or `123` arrives as a
        non-Mapping. That is not a throttle: it is a human having written the wrong
        thing, it will never self-heal, and so it belongs to the COUNTED class. The
        log line matters too — "payload is empty" is simply false about a populated
        JSON array."""
        with pytest.raises(ConfigurationError) as excinfo:
            filter_plugin_secrets(PLUGIN_ID, ['a', 'b'])

        assert not isinstance(excinfo.value, SecretUnreadableError)

    def test_a_non_object_payload_is_counted_against_the_circuit_breaker(self):
        """The classification reaching the effect that depends on it. Asserted
        through real construction rather than on the type alone, because the type is
        only interesting if `_report_construction_failure` acts on it."""
        error, _, record_failure, _ = self._construct(['a', 'b'], self.EXECUTION_ID)

        assert error is not None, 'expected construction to refuse a non-object payload'
        assert record_failure.call_args_list, (
            'a secret body that is not a JSON object is a permanent misconfiguration; '
            'exempting it from the breaker means retrying it every tick forever'
        )

    def test_an_unreadable_secret_still_moves_the_run_record_to_error(self):
        """The exemption is scoped to the breaker alone. The run record is what
        clears the UI's spinner, so withholding it would trade one availability
        problem for a worse observability one."""
        _, table, _, _ = self._construct({}, self.EXECUTION_ID)

        assert self._status_written(table) == 'error'

    def test_an_unreadable_secret_still_emits_the_audit_event(self):
        """Likewise. The event also records that the breaker did NOT count this
        one, so an operator reading a burst of them does not conclude the breaker
        is broken."""
        _, _, _, emit = self._construct({}, self.EXECUTION_ID)

        failed = [call for call in emit.call_args_list
                  if call.args and call.args[0] == 'plugin.failed']
        assert failed, 'the failure was silent in the audit trail'
        assert failed[-1].args[3]['counted_against_circuit_breaker'] is False


class TestNoPluginTestReachesRealAws:
    """The guard in `plugins/conftest.py`, controlled for.

    Three tests in this file once issued a genuine `dynamodb.Query` against whatever
    account the runner held credentials for, and it was INVISIBLE: `record_failure`
    swallows its own exceptions, so the call went out, failed, and the assertion
    still passed. `AccessDeniedException` is the benign outcome — a laptop or a CI
    deploy role that does grant DynamoDB gets a real query and `put_item` against a
    live `test-watermarks`, and at threshold a real `events:DisableRule`.

    `no_real_aws_calls` is autouse, so every test in `plugins/` is already covered.
    What is asserted here is that the guard is ARMED — an autouse fixture that
    silently stopped applying (a conftest move, a rename, a `patch.object` target
    change in botocore) would leave the whole suite unprotected with nothing failing.
    """

    def test_a_real_aws_call_is_refused(self, no_real_aws_calls):
        """The guard's own subject, exercised directly rather than trusted: a client
        built the ordinary way must not reach the network. `no_real_aws_calls` is
        requested by name so the deliberate attempt can be cleared from its record —
        otherwise this test would fail at its own teardown for doing its job."""
        import boto3

        client = boto3.client('dynamodb', region_name='us-east-1')

        with pytest.raises(AssertionError, match='refused real AWS call'):
            client.describe_table(TableName='test-watermarks')

        assert no_real_aws_calls == ['dynamodb.DescribeTable']
        no_real_aws_calls.clear()

    def test_the_attempt_is_recorded_even_when_the_code_swallows_it(self, no_real_aws_calls):
        """Why refusing alone is not enough, and the actual defect being guarded
        against: `record_failure`'s `except Exception` hides this AssertionError
        exactly as it hid the original `AccessDeniedException`. The record survives
        the swallow, which is what lets the fixture report at teardown — somewhere no
        `except` in the code under test can reach."""
        import boto3

        client = boto3.client('dynamodb', region_name='us-east-1')
        swallowed = None
        try:
            client.describe_table(TableName='test-watermarks')
        except Exception as error:  # noqa: BLE001 — mimicking record_failure's own catch
            swallowed = error

        assert swallowed is not None, 'the refusal did not even reach the caller'
        assert no_real_aws_calls == ['dynamodb.DescribeTable'], (
            'the guard cannot report an attempt the code under test swallowed'
        )
        no_real_aws_calls.clear()


class TestTheIdentityRuleIsSharedWithTheWritePath:
    """One character class, imported by both sides of the namespace.

    The write path (`integrations_handler._validate_source`) decides what may be
    STORED under a prefix; this module decides what may be READ from one. A value
    one accepts and the other refuses is the same drift, one level up, that two
    copies of the prefix scan produced — so both import
    `shared.plugin_identity.is_valid_plugin_identifier`.
    """

    @staticmethod
    def _load_write_path_module():
        """`integrations_handler`, loaded WITHOUT lasting effects on this process.

        Not `importlib.import_module` after an `sys.path.insert`: that leaves
        `lambda/api` on the path and the module in `sys.modules` for every later
        test in the session, which both makes the plugin suite order-dependent and
        risks a `lambda/api` module shadowing a plugin-side name of the same stem.
        `spec_from_file_location` addresses the file directly and registers nothing.

        The module's own imports are all `shared.*` and stdlib, and `plugins/
        conftest.py` already has `lambda/` on the path, so no path entry is needed
        at all — which is the point.
        """
        import importlib.util

        path = Path(__file__).resolve().parents[3] / 'lambda' / 'api' / 'integrations_handler.py'
        spec = importlib.util.spec_from_file_location('_write_path_under_test', path)
        assert spec and spec.loader, f'could not load {path}'
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_the_identity_rule_is_the_one_the_write_path_enforces(self):
        """Asserted by IDENTITY of the callable, not by comparing behaviour on a
        sample: two independently-written regexes agreeing on the cases a test
        thinks to try is exactly the drift that goes unnoticed."""
        handler = self._load_write_path_module()

        assert handler.is_valid_plugin_identifier is is_valid_plugin_identifier

    def test_the_control_the_write_path_module_loaded_without_polluting_the_session(self):
        """Non-vacuity in the direction that bit this test before: the assertion
        above passes whether or not the load leaked, so this pins the isolation
        itself.

        Asserted on the LOAD's own contract, not on process-global state, and that
        is the load-bearing choice. A before/after diff of `sys.path` looks like the
        obvious control and is worthless here: under the leaky implementation the
        insert is guarded by `if not in sys.path`, so whichever of these two tests
        runs second sees no delta and passes — the control would then hold only in
        one ordering, which is the very flakiness it exists to prevent. Two
        ordering-independent facts stand in for it instead.
        """
        import sys as _sys

        first = self._load_write_path_module()
        second = self._load_write_path_module()

        assert first.is_valid_plugin_identifier is is_valid_plugin_identifier
        # Registered nowhere: `sys.modules` does not map this module's own name to
        # it, so nothing later in the session can import it — or be shadowed by it.
        assert _sys.modules.get(first.__name__) is not first, (
            f'the load registered {first.__name__!r} in sys.modules for the rest of '
            'the session'
        )
        # And each load is genuinely fresh rather than served from that registry,
        # which is what `import_module` would do.
        assert second is not first

    @pytest.mark.parametrize('plugin_id', ['webscraper', 'app_reviews_ios', 's3_import'])
    def test_every_real_plugin_id_satisfies_the_shared_rule(self, plugin_id):
        """The rule has to admit the ids actually deployed. A tightening that
        rejected one of these would fail every one of that plugin's invocations at
        construction, which is not a failure a unit test of the regex alone would
        report as an outage."""
        assert is_valid_plugin_identifier(plugin_id)


class TestTheDeployTimeInvariantsThisBoundaryNeeds:
    """Two facts outside this file that the fail-closed rule depends on.

    Neither is enforceable at runtime — a plugin Lambda sees its own id and its
    own namespace by design — so they are asserted against the manifests on disk,
    which is what CDK reads at synth time.
    """

    @staticmethod
    def _manifests():
        plugins_dir = Path(__file__).resolve().parents[2]
        found = {}
        for path in sorted(plugins_dir.glob('*/manifest.json')):
            if path.parent.name.startswith('_'):
                continue
            found[path.parent.name] = json.loads(path.read_text(encoding='utf-8'))
        return found

    def test_the_manifest_scan_finds_the_real_plugins(self):
        """Non-vacuity for both assertions below: an empty or mis-rooted glob
        would make each of them pass over nothing."""
        manifests = self._manifests()

        assert len(manifests) >= 5, f'expected >=5 plugins, found {sorted(manifests)}'
        assert 'webscraper' in manifests
        # `_template` is scaffolding, not a deployable plugin — CDK's loadPlugins
        # skips `_`-prefixed directories and so must this.
        assert not any(name.startswith('_') for name in manifests)

    def test_every_plugin_declares_at_least_one_secret_key(self):
        """A plugin declaring NO secrets gets no `<id>_*` key seeded into the
        shared secret, so `filter_plugin_secrets` finds an empty namespace and its
        Lambda dies at construction — in production, on the first invocation.
        `manual_import` and `s3_import` are the plausible zero-secret shapes, which
        is why this is pinned rather than asserted in the PR description.

        A future plugin that genuinely needs no configuration is not blocked: it
        can declare one key, or not read secrets in its constructor. What it may
        not do is discover the requirement from a CloudWatch log."""
        empty = [
            name for name, manifest in self._manifests().items()
            if not manifest.get('secrets')
        ]

        assert empty == [], (
            f'Plugins declare no secret keys: {empty}. Since issue #251 an empty '
            'namespace is a ConfigurationError at construction, so such a plugin '
            'cannot start. Declare at least one key in the manifest.'
        )

    def test_no_plugin_id_is_a_namespace_prefix_of_another(self):
        """The one collision the prefix scan cannot see. `app_reviews` alongside
        the existing `app_reviews_ios` would receive that plugin's keys under
        mangled names (`app_reviews_ios_app_id` arriving as `ios_app_id`) — a
        cross-plugin leak, not a display quirk, since this scan IS the boundary.

        `plugin-loader.ts` refuses such a pair at synth time, which is the only
        vantage point holding the whole id set; this asserts the tree agrees, so a
        Python-side reader of the caveat sees it enforced rather than only
        described."""
        ids = sorted(self._manifests())
        collisions = [
            (shorter, longer)
            for shorter in ids
            for longer in ids
            if shorter != longer and longer.startswith(plugin_secret_prefix(shorter))
        ]

        assert collisions == [], (
            f'Plugin ids collide as secret namespaces: {collisions}. The shorter id '
            "would also receive the longer one's keys. Rename one."
        )
