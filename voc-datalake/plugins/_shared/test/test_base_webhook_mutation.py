"""Mutation hardening for `_shared/base_webhook.py`.

`test_base_webhook.py` and `test_plugin_secret_isolation.py` prove the webhook's
outcomes (a 200 with the confirmed count, a 400 on bad JSON, a 500 on a failure,
secrets filtered to the plugin's namespace), but a mutation run found what they
could not see, everything pinned only by exact values:

* the IMPORT-TIME contract: each of the four settings is read from the variable
  of that exact name and defaults to ``''``; the plugins root goes to the FRONT
  of ``sys.path``; the public names a plugin handler imports;
* the CLASS shape: ``parse_webhook_payload`` is abstract and ``handle`` is
  wrapped by the Powertools tracer;
* the SECRET READ: the exact ARN read, the warning when it is unset, and that a
  cache eviction happens on an empty payload and only then;
* every REFUSAL, exactly: the status, the literal response body, the log line,
  the error metric and the ``webhook.rejected`` audit event with its reason;
* the ACCEPT path: both ``webhook.received`` audit events in order, the literal
  response body, the defaults for a missing body or headers, a body that is
  already a dict, and base64 bodies decoded as UTF-8;
* the delegations: ``normalize_item``'s ``webhook`` channel and extra fields,
  ``send_to_queue``'s queue, metric name and log label, and the ``unknown``
  client IP when API Gateway sent none.
"""
import base64
import json
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import override
from unittest.mock import call, patch

import pytest

from _shared import base_webhook
from _shared.base_webhook import BaseWebhook
from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh
from _shared.test.scoped_secret import FILLER_KEY
from _shared.test.webhook_fixtures import webhook_event, webhook_parsing
from shared.exceptions import SecretUnreadableError

MODULE_PATH = Path(base_webhook.__file__).resolve()
PLUGINS_ROOT = str(MODULE_PATH.parents[1])
PLATFORM = 'test_source'
BRAND = 'TestBrand'
CLIENT_IP = '198.51.100.7'
ENV_SETTINGS = ('PROCESSING_QUEUE_URL', 'SECRETS_ARN', 'BRAND_NAME', 'SOURCE_PLATFORM')


def _load_fresh_module():
    return load_fresh('_shared._base_webhook_under_test', MODULE_PATH)


def _instantiate(webhook_class: type[BaseWebhook]) -> object:
    """Build *webhook_class* through the base type, as a handler that holds a subclass does."""
    return webhook_class()


@pytest.fixture
def restored_sys_path(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The real `sys.path` as it was; the test runs on a copy that monkeypatch swaps back."""
    original = sys.path.copy()
    monkeypatch.setattr(sys, 'path', original.copy())
    return original


@pytest.fixture
def handle_env(webhook_aws: SimpleNamespace) -> Iterator[SimpleNamespace]:
    """The doubles `handle()` reports through: the audit emitter, the logger and metrics."""
    with (
        patch('_shared.base_webhook.emit_audit_event') as emit,
        patch('_shared.base_webhook.logger') as logger,
        patch('_shared.base_webhook.metrics') as metrics,
    ):
        yield SimpleNamespace(emit=emit, logger=logger, metrics=metrics, aws=webhook_aws)


class _Recording(BaseWebhook):
    """Records what `handle()` hands to the parser and returns ``items``."""

    def __init__(self, items: list[dict] | None = None, error: Exception | None = None):
        super().__init__()
        self.items = items or []
        self.error = error
        self.calls: list[tuple[object, object]] = []

    @override
    def parse_webhook_payload(self, body, headers):
        self.calls.append((body, headers))
        if self.error is not None:
            raise self.error
        return self.items


def _received(details: dict) -> object:
    return call('webhook.received', PLATFORM, True, details)


def _rejected(reason: str) -> object:
    return call('webhook.rejected', PLATFORM, False, {'reason': reason, 'ip_address': CLIENT_IP})


class TestTheImportTimeContract:
    @pytest.mark.parametrize('env_set', [True, False], ids=['from_its_own_variable', 'defaults_to_empty'])
    @pytest.mark.usefixtures('restored_sys_path')
    def test_each_setting(self, monkeypatch: pytest.MonkeyPatch, env_set: bool):
        expected = {name: f'from-env-{name}' if env_set else '' for name in ENV_SETTINGS}
        for name, value in expected.items():
            if env_set:
                monkeypatch.setenv(name, value)
            else:
                monkeypatch.delenv(name, raising=False)

        module = _load_fresh_module()

        assert {name: getattr(module, name) for name in ENV_SETTINGS} == expected

    def test_the_plugins_root_is_put_at_the_front_of_sys_path(self, restored_sys_path):
        assert_loading_puts_root_first(_load_fresh_module, restored_sys_path, PLUGINS_ROOT)

    def test_exports_the_class_and_the_instrumentation_a_plugin_handler_imports(self):
        assert base_webhook.__all__ == ['BaseWebhook', 'logger', 'metrics', 'tracer']


class TestTheClassShape:
    def test_a_subclass_without_parse_webhook_payload_cannot_be_constructed(self):
        class Incomplete(BaseWebhook):
            """Implements nothing."""

        with pytest.raises(TypeError, match='parse_webhook_payload'):
            _instantiate(Incomplete)

    def test_handle_is_wrapped_by_the_tracer(self):
        handle = vars(BaseWebhook)['handle']
        assert handle.__code__.co_filename.endswith(os.path.join('tracing', 'tracer.py'))
        wrapped = vars(handle).get('__wrapped__')
        assert wrapped is not None
        assert wrapped.__qualname__ == 'BaseWebhook.handle'

    def test_construction_takes_the_platform_brand_and_sqs_client(self, webhook_aws):
        webhook = webhook_parsing()

        assert webhook.source_platform == PLATFORM
        assert webhook.brand_name == BRAND
        assert webhook._sqs is webhook_aws.sqs


class TestTheSecretRead:
    def test_reads_the_configured_arn_and_keeps_only_this_plugins_keys(self, webhook_aws):
        with patch('_shared.base_webhook.clear_secret_cache') as clear:
            webhook = webhook_parsing()

        webhook_aws.get_secret.assert_called_once_with(base_webhook.SECRETS_ARN)
        assert webhook.secrets == {FILLER_KEY: 'filler'}
        clear.assert_not_called()

    def test_an_unset_secrets_arn_warns_and_reads_nothing(self, webhook_aws):
        with (
            patch('_shared.base_webhook.SECRETS_ARN', ''),
            patch('_shared.base_webhook.logger') as logger,
        ):
            webhook = webhook_parsing()

        assert webhook.secrets == {}
        webhook_aws.get_secret.assert_not_called()
        logger.warning.assert_called_once_with('SECRETS_ARN not configured')

    def test_an_empty_payload_evicts_the_cache_once_then_refuses(self, webhook_aws):
        webhook_aws.get_secret.return_value = {}
        with (
            patch('_shared.base_webhook.clear_secret_cache') as clear,
            pytest.raises(SecretUnreadableError, match=f"'{PLATFORM}'"),
        ):
            webhook_parsing()

        clear.assert_called_once_with()

    def test_the_filter_is_given_this_plugins_identity(self, webhook_aws):
        with patch('_shared.base_webhook.filter_plugin_secrets', return_value={'k': 'v'}) as flt:
            webhook = webhook_parsing()

        flt.assert_called_once_with(PLATFORM, webhook_aws.get_secret.return_value)
        assert webhook.secrets == {'k': 'v'}


@pytest.mark.usefixtures('webhook_aws')
class TestTheDelegations:
    def test_normalize_item_uses_the_webhook_channel_and_carries_the_raw_item(self):
        item = {'id': 'a'}
        with patch('_shared.base_webhook.normalized_item_fields', return_value={'id': 'a', 'x': 1}) as fields:
            result = webhook_parsing().normalize_item(item)

        fields.assert_called_once_with(
            item, source_platform=PLATFORM, default_channel='webhook', brand_name=BRAND,
        )
        assert result == {'id': 'a', 'x': 1, 'is_webhook': True, 'raw_data': item}

    def test_send_to_queue_names_the_queue_the_metric_and_the_log_label(self, webhook_aws):
        items = [{'id': 'a'}]
        with patch('_shared.base_webhook.send_messages_to_queue', return_value=1) as send:
            assert webhook_parsing().send_to_queue(items) == 1

        send.assert_called_once_with(
            webhook_aws.sqs, base_webhook.PROCESSING_QUEUE_URL, [{'id': 'a', 'pii_policy_applied': 'allow'}],
            metric_name='WebhookItemsIngested', log_label='webhook',
        )

    @pytest.mark.parametrize('event', [{}, {'requestContext': {'identity': {}}}],
                             ids=['no_request_context', 'no_source_ip'])
    def test_a_missing_client_ip_reads_unknown(self, event):
        assert webhook_parsing()._extract_client_ip(event) == 'unknown'


class TestEveryRefusalNamesItsCause:
    def test_invalid_json_is_a_400_with_its_log_line_and_audit_reason(self, handle_env):
        webhook = _Recording()

        result = webhook.handle(webhook_event(body='{nope', source_ip=CLIENT_IP), None)

        assert result == {'statusCode': 400, 'body': '{"error": "Invalid JSON"}'}
        assert webhook.calls == []
        handle_env.logger.exception.assert_called_once_with(
            'Invalid JSON in webhook body: Expecting property name enclosed in double quotes: '
            'line 1 column 2 (char 1)'
        )
        handle_env.metrics.add_metric.assert_not_called()
        assert handle_env.emit.call_args_list == [_received({'ip_address': CLIENT_IP}), _rejected('invalid_json')]

    def test_a_processing_failure_is_a_500_with_its_log_line_metric_and_audit_reason(self, handle_env):
        webhook = _Recording(error=RuntimeError('queue is gone'))

        result = webhook.handle(webhook_event(source_ip=CLIENT_IP), None)

        assert result == {'statusCode': 500, 'body': '{"error": "Internal server error"}'}
        handle_env.logger.exception.assert_called_once_with('Webhook processing failed: queue is gone')
        handle_env.metrics.add_metric.assert_called_once_with(name='WebhookErrors', unit='Count', value=1)
        assert handle_env.emit.call_args_list == [_received({'ip_address': CLIENT_IP}), _rejected('queue is gone')]


class TestTheAcceptPath:
    def test_queued_items_return_the_confirmed_count_and_audit_twice(self, handle_env):
        webhook = _Recording(items=[{'id': '1'}, {'id': '2'}])
        with patch.object(_Recording, 'send_to_queue', return_value=2) as send:
            result = webhook.handle(webhook_event(source_ip=CLIENT_IP), None)

        assert result == {'statusCode': 200, 'body': '{"status": "ok", "items_processed": 2}'}
        assert [item['id'] for item in send.call_args.args[0]] == ['1', '2']
        assert handle_env.emit.call_args_list == [
            _received({'ip_address': CLIENT_IP}),
            _received({'items_processed': 2, 'ip_address': CLIENT_IP}),
        ]
        handle_env.logger.info.assert_not_called()

    def test_no_items_is_a_200_with_zero_and_nothing_is_queued(self, handle_env):
        webhook = _Recording()
        with patch.object(_Recording, 'send_to_queue') as send:
            result = webhook.handle(webhook_event(source_ip=CLIENT_IP), None)

        assert result == {'statusCode': 200, 'body': '{"status": "ok", "items_processed": 0}'}
        send.assert_not_called()
        handle_env.logger.info.assert_called_once_with('No items to process from webhook')
        assert handle_env.emit.call_args_list == [_received({'ip_address': CLIENT_IP})]

    @pytest.mark.usefixtures('handle_env')
    def test_a_missing_body_and_headers_reach_the_parser_as_empty_dicts(self):
        webhook = _Recording()

        webhook.handle({'requestContext': {'identity': {'sourceIp': CLIENT_IP}}}, None)

        assert webhook.calls == [({}, {})]

    @pytest.mark.usefixtures('handle_env')
    def test_a_body_that_is_already_a_dict_is_passed_through(self):
        webhook = _Recording()
        event = {**webhook_event(headers={'h': 'v'}), 'body': {'already': 'parsed'}}

        result = webhook.handle(event, None)

        assert result['statusCode'] == 200
        assert webhook.calls == [({'already': 'parsed'}, {'h': 'v'})]

    @pytest.mark.usefixtures('handle_env')
    def test_a_base64_body_is_decoded_as_utf8(self):
        webhook = _Recording()
        encoded = base64.b64encode(json.dumps({'text': 'café ✓'}, ensure_ascii=False).encode('utf-8')).decode()

        result = webhook.handle(webhook_event(body=encoded, is_base64=True), None)

        assert result['statusCode'] == 200
        assert webhook.calls == [({'text': 'café ✓'}, {})]

    @pytest.mark.usefixtures('handle_env')
    def test_a_body_not_flagged_base64_is_not_decoded(self):
        webhook = _Recording()

        webhook.handle({'body': '{"a": 1}'}, None)

        assert webhook.calls == [({'a': 1}, {})]

