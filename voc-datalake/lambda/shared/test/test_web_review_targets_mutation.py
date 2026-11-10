"""Web-review targets, pinned to the exact refusal, boundary and stored value.

The mutation run of ``shared/web_review_targets.py`` found what the earlier suite could not see:
every refusal was matched by a prefix only (a reworded message survived), no limit was tested AT
its value (``>`` vs ``>=`` on the name, URL, page and frequency bounds), only one frequency option
was ever accepted, ``enabled: false`` and mixed-case strings were never stored, a ``True`` passed
as text was never refused, and the hashed long source id was only checked for validity, never for
its exact spelling (prefix length, hash length, the 48-character cut-over).
"""
from unittest.mock import MagicMock, patch

import pytest

from shared.web_review_targets import TargetError, validated_target, web_review_source_id

URL = 'https://www.trustpilot.com/review/example.com'


@pytest.fixture
def public_dns():
    with patch('shared.web_review_targets.validate_url', return_value=(True, '')) as check:
        yield check


def _refusal(target: object) -> str:
    with pytest.raises(TargetError) as caught:
        validated_target(target)
    return str(caught.value)


@pytest.mark.usefixtures('public_dns')
class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('change', 'message'), [
        ({'app_name': ''}, 'app_name is required'),
        ({'app_name': True}, 'app_name must be text'),
        ({'app_name': ['T']}, 'app_name must be text'),
        ({'app_name': 'x' * 101}, 'app_name must be 1-100 letters, digits, spaces, ".", "_" or "-"'),
        ({'app_name': '-T'}, 'app_name must be 1-100 letters, digits, spaces, ".", "_" or "-"'),
        ({'url': ''}, 'url is required'),
        ({'url': 'https://x.example/' + 'a' * 2031}, 'url must be at most 2048 characters'),
        ({'url': 'http://www.trustpilot.com/r'}, 'Only https URLs are allowed'),
        ({'max_pages': 'many'}, 'max_pages must be a whole number'),
        ({'max_pages': '-1'}, 'max_pages must be between 0 and 100'),
        ({'max_pages': '101'}, 'max_pages must be between 0 and 100'),
        ({'max_reviews': 'all'}, 'max_reviews must be a whole number'),
        ({'max_reviews': True}, 'max_reviews must be text'),
        ({'max_reviews': '-1'}, 'max_reviews must be between 0 and 5000'),
        ({'max_reviews': '5001'}, 'max_reviews must be between 0 and 5000'),
        ({'frequency_minutes': '45'}, 'frequency_minutes must be one of 0, 15, 30, 60, 180, 360, 720, 1440'),
        ({'frequency_minutes': '1441'}, 'frequency_minutes must be between 0 and 1440'),
        ({'enabled': 'maybe'}, 'enabled must be true or false'),
        ({'enabled': 1}, 'enabled must be true or false'),
        ({'id': '../x'}, 'id must be 1-64 letters, digits, "_" or "-"'),
        ({'id': 'a' * 65}, 'id must be 1-64 letters, digits, "_" or "-"'),
    ])
    def test_refusal(self, change: dict[str, object], message: str):
        assert _refusal({'app_name': 'T', 'url': URL, **change}) == message

    def test_a_non_object(self):
        assert _refusal(['not', 'a', 'target']) == 'No target provided'


def test_the_url_policy_reason_is_passed_through():
    check = MagicMock(return_value=(False, 'Blocked host'))
    with patch('shared.web_review_targets.validate_url', check):
        assert _refusal({'app_name': 'T', 'url': URL}) == 'URL rejected: Blocked host'
    check.assert_called_once_with(URL)


@pytest.mark.usefixtures('public_dns')
class TestEveryLimitIsInclusive:
    def test_a_name_of_exactly_100_characters(self):
        assert validated_target({'app_name': 'x' * 100, 'url': URL})['app_name'] == 'x' * 100

    def test_a_url_of_exactly_2048_characters(self):
        url = 'https://x.example/' + 'a' * 2030
        assert len(url) == 2048
        assert validated_target({'app_name': 'T', 'url': url})['url'] == url

    @pytest.mark.parametrize('pages', ['0', '1', '100'])
    def test_page_bounds(self, pages: str):
        assert validated_target({'app_name': 'T', 'url': URL, 'max_pages': pages})['max_pages'] == pages

    @pytest.mark.parametrize('reviews', ['0', '1', '5000'])
    def test_review_bounds(self, reviews: str):
        assert validated_target({'app_name': 'T', 'url': URL, 'max_reviews': reviews})['max_reviews'] == reviews

    def test_an_integer_review_limit_is_stored_as_text(self):
        assert validated_target({'app_name': 'T', 'url': URL, 'max_reviews': 200})['max_reviews'] == '200'

    @pytest.mark.parametrize('minutes', ['0', '15', '30', '60', '180', '360', '720', '1440'])
    def test_every_frequency_option(self, minutes: str):
        target = {'app_name': 'T', 'url': URL, 'frequency_minutes': minutes}
        assert validated_target(target)['frequency_minutes'] == minutes


@pytest.mark.usefixtures('public_dns')
@pytest.mark.parametrize(('enabled', 'stored'), [
    (True, 'true'), (False, 'false'), (' TRUE ', 'true'), ('False', 'false'),
])
def test_enabled_is_stored_lower_case(enabled: object, stored: str):
    assert validated_target({'app_name': 'T', 'url': URL, 'enabled': enabled})['enabled'] == stored


class TestSourceIdSpelling:
    def test_a_trailing_dot_and_underscore_are_dropped(self):
        assert web_review_source_id('www.trustpilot.com.', 'Example Air_') == 'web_trustpilot_example_air'

    def test_exactly_48_characters_is_kept_whole(self):
        assert web_review_source_id('www.trustpilot.com', 'a' * 33) == 'web_trustpilot_' + 'a' * 33

    def test_49_characters_keeps_39_plus_an_8_character_hash(self):
        assert web_review_source_id('www.trustpilot.com', 'a' * 33 + 'b') == 'web_trustpilot_' + 'a' * 24 + '_678464b3'
