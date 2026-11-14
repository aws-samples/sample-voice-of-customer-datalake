"""A workspace's source profile at ingestion (7.08.00, docs/multi-workspace.md, "Per-workspace configuration").

The ingestion paths' strict reader (``cached_source_profile_strict``) gives a workspace's source that workspace's own
profile (its PII policy, restriction, defaults), when it saved none the defaults with PII redacted (privacy by
default), never the deployment's; with the
deployment's retention window for the source, which voc-retention applies to every item, so the raw-copy mode follows
the window that will delete the items. A workspace profile sets no window and no Radar brand
(``workspace_profiles_problem``). The source policy (``policy_message``) and the raw-copy checks
(shared/raw_copy.py) read the profile of the scope they are given.
"""
from __future__ import annotations

import pytest

from shared import raw_copy, source_policy
from shared.source_profiles import (
    SourceProfilesUnavailable,
    cached_source_profile_strict,
    source_profile_configured,
    workspace_profiles_problem,
)
from shared.test.source_profile_fixtures import seeded_source_profiles, unreadable_source_profiles
from shared.ws_repo import WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
SCOPE, OTHER_SCOPE = WorkspaceScope(WS), WorkspaceScope(OTHER)

DEPLOYMENT = [
    {'id': 'webscraper', 'label': 'Reviews', 'pii': 'allow', 'retention_days': 90,
     'retention_legal_basis': 'contract: support terms', 'restricted': True},
    {'id': 'feedback_form', 'label': 'Forms', 'pii': 'allow'},
    {'id': 'radar_example', 'label': 'Rival', 'pii': 'allow', 'radar_brand': 'Example Air', 'radar_domains': []},
]
WORKSPACE = [{'id': 'webscraper', 'label': 'Trail reviews', 'pii': 'redact', 'tags': ['trail']}]


@pytest.fixture
def seeded():
    with seeded_source_profiles(DEPLOYMENT, workspaces={WS: WORKSPACE}):
        yield


@pytest.mark.usefixtures('seeded')
class TestTheStrictReader:
    def test_a_workspaces_source_has_its_own_profile_with_the_deployments_window(self):
        profile = cached_source_profile_strict('webscraper', SCOPE)

        assert (profile['label'], profile['pii'], profile['restricted'], profile['tags']) == (
            'Trail reviews', 'redact', False, ['trail'])
        assert (profile['retention_days'], profile['retention_legal_basis']) == (90, 'contract: support terms')

    def test_a_workspace_that_saved_none_gets_the_redacting_default_and_the_deployments_window(self):
        profile = cached_source_profile_strict('webscraper', OTHER_SCOPE)

        # Privacy by default: a workspace's source without a profile redacts, whatever the deployment's says (allow).
        assert (profile['label'], profile['pii'], profile['restricted']) == ('webscraper', 'redact', False)
        assert profile['retention_days'] == 90

    def test_the_deployments_own_default_still_allows(self):
        assert cached_source_profile_strict('unprofiled_source')['pii'] == 'allow'
        assert cached_source_profile_strict('unprofiled_source', OTHER_SCOPE)['pii'] == 'redact'

    def test_a_workspace_profile_never_carries_the_deployments_radar_brand(self):
        assert 'radar_brand' not in cached_source_profile_strict('radar_example', OTHER_SCOPE)
        assert cached_source_profile_strict('radar_example')['radar_brand'] == 'Example Air'

    def test_the_deployment_reads_its_own_profile_as_before(self):
        profile = cached_source_profile_strict('webscraper')

        assert (profile['label'], profile['pii'], profile['restricted']) == ('Reviews', 'allow', True)

    def test_an_opt_in_copy_needs_the_workspaces_own_profile(self):
        assert source_profile_configured('feedback_form') is True
        assert source_profile_configured('feedback_form', SCOPE) is False
        assert raw_copy.source_permits_raw_copy('feedback_form', require_profile=True) is True
        assert raw_copy.source_permits_raw_copy('feedback_form', require_profile=True, scope=SCOPE) is False

    def test_the_archive_mode_follows_the_workspaces_pii_policy_and_the_deployments_window(self):
        assert raw_copy.source_archive_mode('webscraper') == 'item'  # allow, with a window
        assert raw_copy.source_archive_mode('webscraper', SCOPE) == 'none'  # the workspace redacts
        assert raw_copy.source_archive_mode('webscraper', OTHER_SCOPE) == 'none'  # no profile: its default redacts
        assert raw_copy.source_archive_mode('feedback_form', OTHER_SCOPE) == 'none'

    def test_a_workspace_allow_profile_keeps_copies_by_the_deployments_window(self):
        allow = [{'id': 'webscraper', 'pii': 'allow'}, {'id': 'feedback_form', 'pii': 'allow'}]
        with seeded_source_profiles(DEPLOYMENT, workspaces={OTHER: allow}):
            assert raw_copy.source_archive_mode('webscraper', OTHER_SCOPE) == 'item'  # the deployment's window binds
            assert raw_copy.source_archive_mode('feedback_form', OTHER_SCOPE) == 'file'

    def test_the_source_policy_applies_the_scopes_profile(self):
        message = {'id': 'r1', 'source_platform': 'webscraper', 'text': 'Mail me at robin@example.com',
                   'author': 'Robin Example'}

        deployment, _ = source_policy.policy_message(message)
        workspace, profile = source_policy.policy_message(message, SCOPE)

        assert deployment is not None
        assert workspace is not None
        assert (deployment['pii_policy_applied'], deployment['author']) == ('allow', 'Robin Example')
        assert workspace['pii_policy_applied'] == 'redact'
        assert 'author' not in workspace
        assert 'robin@example.com' not in workspace['text']
        assert profile['pii'] == 'redact'


def test_a_workspaces_read_fails_closed_when_the_deployments_window_is_unreadable():
    with unreadable_source_profiles(), pytest.raises(SourceProfilesUnavailable):
        cached_source_profile_strict('webscraper', SCOPE)


@pytest.mark.parametrize(('profiles', 'problem'), [
    ([{'id': 'webscraper', 'retention_days': None, 'retention_legal_basis': ' ', 'radar_domains': []}], None),
    ([{'id': 'webscraper', 'retention_days': 30}], "Source \"webscraper\": retention windows are the deployment's"),
    ([{'id': 'webscraper', 'retention_legal_basis': 'contract'}], "Source \"webscraper\": retention windows"),
    ([{'id': 'radar_example', 'radar_brand': 'Example Air'}], 'Source "radar_example": Radar is not kept'),
    ([{'id': 'radar_example', 'radar_domains': ['example.com']}], 'Source "radar_example": Radar is not kept'),
    ('not a list', None),
], ids=['plain', 'a-window', 'a-legal-basis', 'a-radar-brand', 'radar-domains', 'not-a-list'])
def test_what_a_workspace_profile_cannot_set(profiles, problem):
    found = workspace_profiles_problem(profiles)

    if problem is None:
        assert found is None
    else:
        assert found is not None
        assert found.startswith(problem)
