"""``source_permits_raw_copy(..., require_profile=True)``: an opt-in copy needs an admin-saved profile, and fails closed."""
from __future__ import annotations

import pytest

from shared.raw_copy import source_permits_raw_copy
from shared.test.source_profile_fixtures import seeded_source_profiles, unreadable_source_profiles

SOURCE = 'feature_requests'


def test_without_a_saved_profile_an_opt_in_copy_is_refused() -> None:
    with seeded_source_profiles():
        assert source_permits_raw_copy(SOURCE, require_profile=True) is False
        # The default (allow) still permits a copy when no profile is required.
        assert source_permits_raw_copy(SOURCE) is True


def test_a_saved_allow_profile_permits_an_opt_in_copy() -> None:
    with seeded_source_profiles([{'id': SOURCE, 'label': 'Boards', 'pii': 'allow'}]):
        assert source_permits_raw_copy(SOURCE, require_profile=True) is True


@pytest.mark.parametrize('pii', ['redact', 'summary_only'])
def test_a_saved_privacy_profile_still_refuses(pii: str) -> None:
    with seeded_source_profiles([{'id': SOURCE, 'label': 'Boards', 'pii': pii}]):
        assert source_permits_raw_copy(SOURCE, require_profile=True) is False


@pytest.mark.parametrize('require_profile', [True, False])
def test_an_unreadable_profile_refuses_and_never_raises(require_profile: bool) -> None:
    with unreadable_source_profiles():
        assert source_permits_raw_copy(SOURCE, require_profile=require_profile) is False
