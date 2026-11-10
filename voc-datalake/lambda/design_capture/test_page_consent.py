"""The consent-banner check shared by the two page scripts (page_consent.py)."""
import page_inline_logo as pil
import page_styles as ps
import pytest
from page_consent import CONSENT_PLACEHOLDER, IN_CONSENT_JS, with_consent_check


@pytest.mark.parametrize('script', [ps.STYLES_JS, pil.INLINE_LOGO_JS], ids=['styles', 'inline logo'])
def test_each_page_script_carries_the_check_once_and_no_placeholder(script):
    assert CONSENT_PLACEHOLDER not in script
    assert script.count(IN_CONSENT_JS.strip()) == 1


def test_the_check_replaces_the_placeholder():
    assert with_consent_check(f'(() => {{ {CONSENT_PLACEHOLDER} return inConsent; }})') == (
        f'(() => {{ {IN_CONSENT_JS.strip()} return inConsent; }})')


@pytest.mark.parametrize('script', ['() => 1', f'{CONSENT_PLACEHOLDER}{CONSENT_PLACEHOLDER}'], ids=['none', 'two'])
def test_a_script_without_exactly_one_placeholder_is_refused(script):
    with pytest.raises(ValueError, match='exactly one consent placeholder'):
        with_consent_check(script)
