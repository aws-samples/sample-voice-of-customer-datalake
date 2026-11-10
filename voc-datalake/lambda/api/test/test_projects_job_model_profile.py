"""Every project job's config carries the starter's model profile, never a client-sent one
(projects_handler._started_job, shared/model_profile.py)."""
from unittest.mock import MagicMock, patch

from shared.model_profile import E2E_PROFILE, PAYLOAD_KEY, model_profile_scope


def _start(config: dict) -> dict:
    """Runs _started_job with ``config``; returns the config create_job stored."""
    import projects_handler
    with patch.object(projects_handler, '_require_project_exists'), \
            patch.object(projects_handler, '_request_caller', return_value=MagicMock(subject='user-1')), \
            patch.object(projects_handler, 'create_job', return_value=('job_1', {})) as create:
        projects_handler._started_job('p1', 'generate_prd', 'doc_config', config)
    return create.call_args.args[3]


def test_a_forged_profile_in_a_spread_body_is_dropped():
    assert PAYLOAD_KEY not in _start({'doc_type': 'prd', PAYLOAD_KEY: E2E_PROFILE})


def test_an_e2e_starter_stamps_the_config_the_job_payload_reuses():
    config = {'doc_type': 'prd'}
    with model_profile_scope(E2E_PROFILE):
        stored = _start(config)
    assert stored[PAYLOAD_KEY] == E2E_PROFILE
    assert config[PAYLOAD_KEY] == E2E_PROFILE  # the same dict goes into the async invoke / execution input
