"""An agent run started by an e2e test user keeps the e2e model profile (shared/model_profile.py):
the run row records it, and the agent principal forwards only the `e2e` group (never `admins`)."""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from agents import principal
from shared import agents_store
from shared.model_profile import E2E_PROFILE, PAYLOAD_KEY, model_profile_scope

AGENT = {'agent_id': 'ag_0123456789abcdef', 'owner_sub': 'owner-1'}
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


def _started_run() -> dict:
    table = MagicMock()
    table.name = 'voc-agents'
    request = agents_store.RunStart(trigger='manual', requested_by='admin-sub', workflow_revision=1)
    with patch.object(agents_store, 'new_run_id', return_value='ar_000000000001aaaaaaaa'):
        run = agents_store.start_run(table, AGENT, request, now=NOW)
    assert run is not None
    return run


def test_a_run_started_in_the_e2e_scope_records_the_profile():
    with model_profile_scope(E2E_PROFILE):
        assert _started_run()[PAYLOAD_KEY] == E2E_PROFILE


def test_a_scheduled_or_ordinary_run_records_none():
    assert PAYLOAD_KEY not in _started_run()


def test_the_agent_claims_carry_only_the_e2e_group_for_a_profiled_run():
    assert principal.agent_claims(AGENT)['cognito:groups'] == ''
    assert principal.agent_claims(AGENT, model_profile=E2E_PROFILE)['cognito:groups'] == 'e2e'
    # Anything else (an unknown or tampered value) forwards no group at all.
    assert principal.agent_claims(AGENT, model_profile='admins')['cognito:groups'] == ''
