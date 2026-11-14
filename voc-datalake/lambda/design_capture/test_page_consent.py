"""The consent-banner check (page_consent.py): written once, carried by the logo-candidate collector only."""
import page_styles as ps
import pytest
from page_consent import CONSENT_PLACEHOLDER, IN_CONSENT_JS, with_consent_check
from page_logo_candidates import CANDIDATES_JS


def test_the_candidate_collector_carries_the_check_once_and_no_placeholder():
    assert CONSENT_PLACEHOLDER not in CANDIDATES_JS
    assert CANDIDATES_JS.count(IN_CONSENT_JS.strip()) == 1
    assert 'in_consent: inConsent(el)' in CANDIDATES_JS


def test_the_styles_script_no_longer_carries_the_check():
    assert CONSENT_PLACEHOLDER not in ps.STYLES_JS
    assert IN_CONSENT_JS.strip() not in ps.STYLES_JS


def test_the_check_replaces_the_placeholder():
    assert with_consent_check(f'(() => {{ {CONSENT_PLACEHOLDER} return inConsent; }})') == (
        f'(() => {{ {IN_CONSENT_JS.strip()} return inConsent; }})')


@pytest.mark.parametrize('script', ['() => 1', f'{CONSENT_PLACEHOLDER}{CONSENT_PLACEHOLDER}'], ids=['none', 'two'])
def test_a_script_without_exactly_one_placeholder_is_refused(script):
    with pytest.raises(ValueError, match='exactly one consent placeholder'):
        with_consent_check(script)
