"""Mutation hardening for `shared/mcp_global_tokens.py`.

`test_global_mcp_tokens_api.py`, `test_global_mcp_protocol.py` and
`test_global_mcp_e2e.py` reach this module only through the two handlers, so they
pin what a request ANSWERS — a revoked token is a 401, an over-long lifetime a 400,
an audit page lists events — and a mutation run found the statements they cannot
tell apart:

* every storage key and bound as a LITERAL: the ``MCPGTOKEN`` partition, the
  ``MCPAUDIT#`` prefix, ``TOKEN#`` sort keys, the 30/90-day lifetimes, the 20-token
  and 80-character caps, the 50-row audit page and the 90-day audit TTL. The
  handlers build rows from these, so a drifted spelling is self-consistent within
  one process and no handler test sees it.
* the ACCEPTED side of every boundary: a 1-day and a 90-day lifetime mint, a
  128-character id is a path id, a 64-character tool name is kept whole, and a
  deadline exactly ``now`` is already expired (``<=``, not ``<``).
* the fail-closed defaults field by field: a missing or unreadable ``expires_at``
  is ``expired``; a malformed ``project_id`` pins to ``UNMATCHABLE_PROJECT``
  (which is itself not a path id); an unknown scope reads as ``read``; an unknown
  outcome is recorded and shown as ``failed``; ``can_run_agents`` needs BOTH the
  admin mint and the ``write`` scope.
* the audit row as a WHOLE: its exact key set, the ``<iso>#<8 hex>`` sort key, the
  truncated tool name, the ``ttl`` as an int epoch 90 days out, and the
  ``project_id`` attribute that is present only for a path-safe id.
"""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta, timezone
from typing import ClassVar

import pytest

from shared import mcp_global_tokens as gt

NOW = datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC)


class TestStorageKeysAreSpelledExactly:
    def test_partition_and_prefix_literals(self):
        assert gt.GLOBAL_TOKEN_PK == 'MCPGTOKEN'
        assert gt.AUDIT_PK_PREFIX == 'MCPAUDIT#'

    def test_token_sort_key_matches_the_per_project_spelling(self):
        assert gt.token_sk('tok_abc') == 'TOKEN#tok_abc'

    def test_audit_partition_is_prefix_plus_token_id(self):
        assert gt.audit_pk('tok_abc') == 'MCPAUDIT#tok_abc'


class TestBoundsAreTheDocumentedNumbers:
    def test_audit_bounds(self):
        assert gt.AUDIT_RETENTION_DAYS == 90
        assert gt.AUDIT_PAGE_SIZE == 50

    def test_lifetime_and_cap_bounds(self):
        assert gt.DEFAULT_EXPIRY_DAYS == 30
        assert gt.MAX_EXPIRY_DAYS == 90
        assert gt.MAX_ACTIVE_TOKENS_PER_USER == 20
        assert gt.MAX_TOKEN_NAME_LENGTH == 80


class TestVocabularyLiterals:
    def test_scopes(self):
        assert gt.SCOPE_READ == 'read'
        assert gt.SCOPE_WRITE == 'write'
        assert gt.VALID_SCOPES == ('read', 'write')

    def test_statuses(self):
        assert gt.STATUS_ACTIVE == 'active'
        assert gt.STATUS_REVOKED == 'revoked'
        assert gt.STATUS_EXPIRED == 'expired'

    def test_outcomes_in_order(self):
        assert gt.OUTCOME_OK == 'ok'
        assert gt.OUTCOME_ERROR == 'error'
        assert gt.OUTCOME_DENIED == 'denied'
        assert gt.OUTCOME_FAILED == 'failed'
        assert gt.OUTCOMES == ('ok', 'error', 'denied', 'failed')

    def test_unmatchable_project_is_the_nul_sentinel_and_never_a_path_id(self):
        assert gt.UNMATCHABLE_PROJECT == '\u0000unmatchable'
        assert gt.is_path_id(gt.UNMATCHABLE_PROJECT) is False


class TestPathIdAcceptsExactlyTheSafeAlphabet:
    @pytest.mark.parametrize('value', [
        'a', 'proj_abc-123', 'ABCxyz_09-', 'a' * 128, 'tok_' + 'f' * 16, '0' * 32,
    ])
    def test_accepted(self, value):
        assert gt.is_path_id(value) is True

    @pytest.mark.parametrize('value', [
        '', 'a' * 129, 'a/b', 'a.b', 'a%2Fb', 'a b', ' a', '\na', 'a#b', 'ä',
    ])
    def test_rejected_strings(self, value):
        assert gt.is_path_id(value) is False

    @pytest.mark.parametrize('value', [None, 7, b'abc', ['a'], {'a': 1}, True])
    def test_rejected_non_strings(self, value):
        assert gt.is_path_id(value) is False


class TestScopePredicates:
    @pytest.mark.parametrize(('scope', 'allows'), [
        ('write', True), ('read', False), ('WRITE', False), ('write ', False),
        (None, False), ('', False), (True, False), (['write'], False),
    ])
    def test_only_the_exact_write_value_grants_writes(self, scope, allows):
        assert gt.scope_allows_write(scope) is allows

    @pytest.mark.parametrize(('scope', 'valid'), [
        ('read', True), ('write', True), ('admin', False), ('', False), (None, False),
        (b'read', False), (['read'], False), (('read', 'write'), False), (0, False),
    ])
    def test_scope_is_valid_needs_a_string_in_the_vocabulary(self, scope, valid):
        assert gt.scope_is_valid(scope) is valid


class TestExpiryForIsStrictAtBothEnds:
    def test_none_means_exactly_thirty_days(self):
        assert gt.expiry_for(None, NOW) == '2026-02-14T12:00:00+00:00'
        assert gt.expiry_for(None, NOW) == (NOW + timedelta(days=30)).isoformat()

    @pytest.mark.parametrize(('days', 'expected'), [
        (1, '2026-01-16T12:00:00+00:00'),
        (30, '2026-02-14T12:00:00+00:00'),
        (90, '2026-04-15T12:00:00+00:00'),
    ])
    def test_accepted_lifetimes_are_added_to_now(self, days, expected):
        assert gt.expiry_for(days, NOW) == expected

    @pytest.mark.parametrize('days', [0, -1, 91, 365, 1000, True, False, '30', 30.0, 30.5, [30], {}])
    def test_refused_lifetimes_name_the_bounds(self, days):
        with pytest.raises(ValueError, match=r'^expires_in_days must be an integer between 1 and 90$'):
            gt.expiry_for(days, NOW)

    def test_naive_now_yields_a_naive_deadline(self):
        assert gt.expiry_for(2, datetime(2026, 1, 15, 12, 0, 0)) == '2026-01-17T12:00:00'


class TestParsedTime:
    @pytest.mark.parametrize('value', [None, '', 7, b'2026-01-15', 'not a date', '2026-13-45T00:00:00'])
    def test_unreadable_values_are_none(self, value):
        assert gt._parsed_time(value) is None

    def test_naive_string_is_read_as_utc(self):
        parsed = gt._parsed_time('2026-01-15T12:00:00')
        assert parsed == NOW
        assert parsed is not None
        assert parsed.tzinfo is UTC

    def test_aware_string_keeps_its_own_offset(self):
        parsed = gt._parsed_time('2026-01-15T14:00:00+02:00')
        assert parsed == NOW
        assert parsed is not None
        assert parsed.utcoffset() == timedelta(hours=2)
        assert parsed.tzinfo == timezone(timedelta(hours=2))


class TestTokenStatusFailsClosed:
    @pytest.mark.parametrize('revoked_at', ['2026-01-01T00:00:00+00:00', 'x', 1, True])
    def test_any_truthy_revoked_at_is_revoked_before_the_deadline_is_read(self, revoked_at):
        row = {'revoked_at': revoked_at, 'expires_at': '2030-01-01T00:00:00+00:00'}
        assert gt.token_status(row, NOW) == 'revoked'

    def test_revoked_wins_even_over_an_expired_deadline(self):
        row = {'revoked_at': '2026-01-01T00:00:00+00:00', 'expires_at': '2020-01-01T00:00:00+00:00'}
        assert gt.token_status(row, NOW) == 'revoked'

    @pytest.mark.parametrize('revoked_at', [None, '', 0, False])
    def test_falsy_revoked_at_is_not_a_revocation(self, revoked_at):
        row = {'revoked_at': revoked_at, 'expires_at': '2030-01-01T00:00:00+00:00'}
        assert gt.token_status(row, NOW) == 'active'

    @pytest.mark.parametrize('row', [
        {}, {'expires_at': None}, {'expires_at': ''}, {'expires_at': 'garbage'}, {'expires_at': 12345},
    ])
    def test_missing_or_unreadable_deadline_is_expired(self, row):
        assert gt.token_status(row, NOW) == 'expired'

    def test_deadline_equal_to_now_is_already_expired(self):
        assert gt.token_status({'expires_at': NOW.isoformat()}, NOW) == 'expired'

    def test_deadline_one_microsecond_after_now_is_active(self):
        later = (NOW + timedelta(microseconds=1)).isoformat()
        assert gt.token_status({'expires_at': later}, NOW) == 'active'

    def test_deadline_one_microsecond_before_now_is_expired(self):
        earlier = (NOW - timedelta(microseconds=1)).isoformat()
        assert gt.token_status({'expires_at': earlier}, NOW) == 'expired'

    def test_naive_deadline_is_compared_as_utc(self):
        assert gt.token_status({'expires_at': '2026-01-15T12:00:01'}, NOW) == 'active'
        assert gt.token_status({'expires_at': '2026-01-15T11:59:59'}, NOW) == 'expired'


class TestPinnedProjectNarrowsNeverWidens:
    @pytest.mark.parametrize('row', [{}, {'project_id': None}, {'project_id': ''}])
    def test_absent_or_empty_is_a_workspace_token(self, row):
        assert gt.pinned_project(row) is None

    def test_a_path_id_is_returned_verbatim(self):
        assert gt.pinned_project({'project_id': 'proj_abc-1'}) == 'proj_abc-1'

    @pytest.mark.parametrize('value', ['a/b', 'a b', 'x' * 129, 7, ['proj_a'], 0, False])
    def test_a_malformed_value_pins_to_the_unmatchable_sentinel(self, value):
        assert gt.pinned_project({'project_id': value}) == '\u0000unmatchable'


class TestTokenViewShape:
    FULL_ROW: ClassVar[dict[str, object]] = {
        'pk': 'MCPGTOKEN', 'sk': 'TOKEN#tok_1', 'secret_hash': 'deadbeef',
        'token_id': 'tok_1', 'name': 'laptop', 'scope': 'write', 'project_id': 'proj_1',
        'created_at': '2026-01-01T00:00:00+00:00', 'expires_at': '2026-03-01T00:00:00+00:00',
        'last_used_at': '2026-01-10T00:00:00+00:00', 'revoked_at': None, 'minted_by_admin': True,
        'created_by': 'user-sub',
    }

    def test_every_field_and_nothing_else(self):
        assert gt.token_view(self.FULL_ROW, NOW) == {
            'token_id': 'tok_1',
            'name': 'laptop',
            'scope': 'write',
            'project_id': 'proj_1',
            'created_at': '2026-01-01T00:00:00+00:00',
            'expires_at': '2026-03-01T00:00:00+00:00',
            'last_used_at': '2026-01-10T00:00:00+00:00',
            'revoked_at': None,
            'status': 'active',
            'can_run_agents': True,
        }

    def test_empty_row_reads_as_an_expired_read_token(self):
        assert gt.token_view({}, NOW) == {
            'token_id': None, 'name': '', 'scope': 'read', 'project_id': None,
            'created_at': None, 'expires_at': None, 'last_used_at': None, 'revoked_at': None,
            'status': 'expired', 'can_run_agents': False,
        }

    @pytest.mark.parametrize('scope', ['admin', '', None, 7])
    def test_unknown_scope_reads_as_read(self, scope):
        assert gt.token_view({**self.FULL_ROW, 'scope': scope}, NOW)['scope'] == 'read'

    def test_empty_project_id_reads_as_none(self):
        assert gt.token_view({**self.FULL_ROW, 'project_id': ''}, NOW)['project_id'] is None

    def test_a_revoked_row_shows_its_revocation_time_and_status(self):
        view = gt.token_view({**self.FULL_ROW, 'revoked_at': '2026-01-12T00:00:00+00:00'}, NOW)
        assert view['revoked_at'] == '2026-01-12T00:00:00+00:00'
        assert view['status'] == 'revoked'

    def test_an_expired_row_shows_its_deadline_and_status(self):
        view = gt.token_view({**self.FULL_ROW, 'expires_at': '2026-01-14T00:00:00+00:00'}, NOW)
        assert view['expires_at'] == '2026-01-14T00:00:00+00:00'
        assert view['status'] == 'expired'

    @pytest.mark.parametrize(('minted_by_admin', 'scope', 'can'), [
        (True, 'write', True),
        (True, 'read', False),
        (False, 'write', False),
        (None, 'write', False),
        ('yes', 'write', True),
        (1, 'write', True),
        (0, 'write', False),
        (True, 'WRITE', False),
    ])
    def test_can_run_agents_needs_admin_mint_and_write_scope(self, minted_by_admin, scope, can):
        row = {**self.FULL_ROW, 'minted_by_admin': minted_by_admin, 'scope': scope}
        assert gt.token_view(row, NOW)['can_run_agents'] is can


class TestAuditItemRecordsExactlyFourFacts:
    def test_whole_row_for_a_pinned_call(self):
        item = gt.audit_item('tok_1', tool='get_project', project_id='proj_1', outcome='ok', now=NOW)
        suffix = item.pop('sk')
        assert re.fullmatch(r'2026-01-15T12:00:00\+00:00#[0-9a-f]{8}', suffix)
        assert item == {
            'pk': 'MCPAUDIT#tok_1',
            'token_id': 'tok_1',
            'tool': 'get_project',
            'at': '2026-01-15T12:00:00+00:00',
            'outcome': 'ok',
            'project_id': 'proj_1',
            'ttl': int(datetime(2026, 4, 15, 12, 0, 0, tzinfo=UTC).timestamp()),
        }

    def test_ttl_is_an_int_epoch_ninety_days_out(self):
        item = gt.audit_item('tok_1', tool='t', project_id=None, outcome='ok', now=NOW)
        assert item['ttl'] == 1776254400
        assert type(item['ttl']) is int

    def test_two_rows_in_the_same_microsecond_get_different_sort_keys(self):
        first = gt.audit_item('tok_1', tool='t', project_id=None, outcome='ok', now=NOW)
        second = gt.audit_item('tok_1', tool='t', project_id=None, outcome='ok', now=NOW)
        assert first['sk'] != second['sk']
        assert first['sk'][:len(NOW.isoformat()) + 1] == second['sk'][:len(NOW.isoformat()) + 1]
        assert len(first['sk']) == len(NOW.isoformat()) + 1 + 8

    @pytest.mark.parametrize('project_id', [None, '', 'a/b', 'p' * 129, 'a b'])
    def test_project_id_is_absent_unless_path_safe(self, project_id):
        item = gt.audit_item('tok_1', tool='t', project_id=project_id, outcome='ok', now=NOW)
        assert 'project_id' not in item

    @pytest.mark.parametrize('outcome', ['ok', 'error', 'denied', 'failed'])
    def test_known_outcomes_are_kept(self, outcome):
        assert gt.audit_item('tok_1', tool='t', project_id=None, outcome=outcome, now=NOW)['outcome'] == outcome

    @pytest.mark.parametrize('outcome', ['OK', 'success', '', 'unknown'])
    def test_unknown_outcome_is_recorded_as_failed(self, outcome):
        assert gt.audit_item('tok_1', tool='t', project_id=None, outcome=outcome, now=NOW)['outcome'] == 'failed'

    def test_tool_name_is_kept_whole_at_64_and_cut_at_65(self):
        whole = 'x' * 64
        assert gt.audit_item('tok_1', tool=whole, project_id=None, outcome='ok', now=NOW)['tool'] == whole
        assert gt.audit_item('tok_1', tool='y' * 65, project_id=None, outcome='ok', now=NOW)['tool'] == 'y' * 64
        assert gt._MAX_TOOL_NAME_LENGTH == 64


class TestAuditViewShowsExactlyFourFacts:
    def test_full_row_maps_field_for_field(self):
        row = {'pk': 'MCPAUDIT#tok_1', 'sk': 'x', 'token_id': 'tok_1', 'ttl': 1,
               'tool': 'get_project', 'at': '2026-01-15T12:00:00+00:00', 'project_id': 'proj_1', 'outcome': 'denied'}
        assert gt.audit_view(row) == {
            'tool': 'get_project', 'at': '2026-01-15T12:00:00+00:00', 'project_id': 'proj_1', 'outcome': 'denied',
        }

    def test_empty_row_reads_as_a_failed_unnamed_call(self):
        assert gt.audit_view({}) == {'tool': '', 'at': '', 'project_id': None, 'outcome': 'failed'}

    @pytest.mark.parametrize('outcome', ['ok', 'error', 'denied', 'failed'])
    def test_known_outcomes_are_shown(self, outcome):
        assert gt.audit_view({'outcome': outcome})['outcome'] == outcome

    @pytest.mark.parametrize('outcome', ['OK', None, '', 7])
    def test_unknown_outcome_is_shown_as_failed(self, outcome):
        assert gt.audit_view({'outcome': outcome})['outcome'] == 'failed'

    def test_empty_project_id_is_none(self):
        assert gt.audit_view({'project_id': ''})['project_id'] is None
