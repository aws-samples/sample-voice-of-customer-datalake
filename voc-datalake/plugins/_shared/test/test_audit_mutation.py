"""Mutation hardening for `_shared/audit.py`.

The earlier `test_audit.py` (deleted; every test there was a weaker duplicate
of one below) checked that `emit_audit_event` logs *something* under ``AUDIT``
and that the dataclass holds what it is given, but a mutation run found 36 of
42 mutants those tests could not see — everything the module does beyond "the
logger was called":

* the LOG LINE as a whole: the exact ``audit_event`` dict with every default
  (``details={}``, ``request_id=user_id=ip_address=''``) and a real UTC ISO
  timestamp, not merely the presence of a key;
* the FAILURE LOG is gone with the EventBridge path it covered: audit events
  are CloudWatch-only, and ``TestNoEventBusRemains`` keeps them that way;
* the IMPORT-TIME contract: the plugins root is put
  at the FRONT of ``sys.path`` (so ``shared.*`` resolves from the bundle);
* the ``AuditAction`` literal — its thirteen values, in order — which other
  modules and the webhook/ingestor tests spell as strings.
"""
import ast
import os
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import get_args
from unittest.mock import MagicMock, patch

import pytest

from _shared import audit
from _shared.audit import AuditAction, AuditEvent, emit_audit_event
from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh

MODULE_PATH = Path(audit.__file__).resolve()
PLUGINS_ROOT = str(MODULE_PATH.parents[1])
FIXED_TIMESTAMP = '2025-01-01T12:00:00+00:00'

EVERY_ACTION = (
    'plugin.invoked',
    'plugin.completed',
    'plugin.failed',
    'plugin.enabled',
    'plugin.disabled',
    'webhook.received',
    'webhook.verified',
    'webhook.rejected',
    'message.ingested',
    'message.validated',
    'message.rejected',
    'secret.accessed',
    'config.updated',
)


def _load_fresh_audit_module():
    """Execute the module's file again, in a module registered nowhere (see `fresh_import.load_fresh`)."""
    return load_fresh('_shared._audit_under_test', MODULE_PATH)


@pytest.fixture
def restored_sys_path() -> Iterator[list[str]]:
    """Snapshot `sys.path` for a test that imports `audit.py` afresh, and restore it after."""
    before = list(sys.path)
    yield before
    sys.path[:] = before


@pytest.fixture
def fixed_clock() -> Iterator[MagicMock]:
    with patch('_shared.audit.datetime') as clock:
        clock.now.return_value.isoformat.return_value = FIXED_TIMESTAMP
        yield clock


@pytest.fixture
def audit_logger() -> Iterator[MagicMock]:
    with patch('_shared.audit.logger') as logger:
        yield logger


class TestTheImportTimeContract:
    def test_the_plugins_root_is_put_at_the_front_of_sys_path(self, restored_sys_path):
        assert_loading_puts_root_first(_load_fresh_audit_module, restored_sys_path, PLUGINS_ROOT)

    def test_the_action_literal_lists_exactly_these_thirteen_values_in_order(self):
        assert get_args(AuditAction) == EVERY_ACTION


class TestTheEventDefaults:
    def test_to_dict_fills_every_optional_field_with_the_empty_string(self):
        event = AuditEvent(
            timestamp=FIXED_TIMESTAMP,
            action='plugin.invoked',
            plugin_id='webscraper',
            success=True,
            details={'items': 10},
        )

        assert event.to_dict() == {
            'timestamp': FIXED_TIMESTAMP,
            'action': 'plugin.invoked',
            'plugin_id': 'webscraper',
            'success': True,
            'details': {'items': 10},
            'request_id': '',
            'user_id': '',
            'ip_address': '',
        }


class TestTheCloudWatchLine:
    def test_logs_the_whole_event_under_audit_with_every_default_filled(
        self, audit_logger, fixed_clock
    ):
        emit_audit_event('plugin.failed', 'webscraper', False)

        fixed_clock.now.assert_called_once_with(UTC)
        audit_logger.info.assert_called_once_with('AUDIT', extra={'audit_event': {
            'timestamp': FIXED_TIMESTAMP,
            'action': 'plugin.failed',
            'plugin_id': 'webscraper',
            'success': False,
            'details': {},
            'request_id': '',
            'user_id': '',
            'ip_address': '',
        }})

    @pytest.mark.usefixtures('fixed_clock')
    def test_logs_every_argument_it_is_given(self, audit_logger):
        emit_audit_event(
            'webhook.rejected',
            'github_issues',
            False,
            details={'reason': 'invalid_signature'},
            request_id='req-1',
            user_id='user-2',
            ip_address='203.0.113.9',
        )

        audit_logger.info.assert_called_once_with('AUDIT', extra={'audit_event': {
            'timestamp': FIXED_TIMESTAMP,
            'action': 'webhook.rejected',
            'plugin_id': 'github_issues',
            'success': False,
            'details': {'reason': 'invalid_signature'},
            'request_id': 'req-1',
            'user_id': 'user-2',
            'ip_address': '203.0.113.9',
        }})

    def test_the_real_timestamp_is_an_aware_utc_iso_string(self, audit_logger):
        before = datetime.now(UTC)
        emit_audit_event('plugin.invoked', 'webscraper', True)
        after = datetime.now(UTC)

        stamped = datetime.fromisoformat(
            audit_logger.info.call_args.kwargs['extra']['audit_event']['timestamp']
        )
        assert stamped.tzinfo == UTC
        assert before <= stamped <= after


class TestNoEventBusRemains:
    """Audit events are CloudWatch-only.

    An `AUDIT_EVENT_BUS` → `put_events` branch used to sit here, but no stack
    ever set the variable and the client factory it needed did not exist, so it
    was dead config that read like a feature. These fail if it comes back
    without the infrastructure (a bus, a `PutEvents` grant) to make it real.
    """

    def test_the_module_reads_no_event_bus_and_has_no_eventbridge_path(self):
        source = MODULE_PATH.read_text()

        for removed in ('AUDIT_EVENT_BUS', 'EventBusName', 'put_events', 'eventbridge'):
            assert removed not in source, removed

    def test_the_module_imports_nothing_that_could_reach_aws(self):
        tree = ast.parse(MODULE_PATH.read_text())
        imported = {
            alias.name if isinstance(node, ast.Import) else f'{node.module}.{alias.name}'
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }

        assert not [name for name in imported if 'boto' in name or name.startswith('shared.aws')]

    def test_emitting_logs_once_and_never_builds_a_client(self, audit_logger):
        with patch.dict(os.environ, {'AUDIT_EVENT_BUS': 'audit-bus'}):
            emit_audit_event('plugin.disabled', 'webscraper', True, details={'ids': {1, 2}})

        audit_logger.info.assert_called_once()
        audit_logger.warning.assert_not_called()
