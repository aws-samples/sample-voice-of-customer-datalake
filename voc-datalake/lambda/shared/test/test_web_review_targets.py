"""Web-review targets: what may be saved (https, public, bounded) and the per-connector source id."""
from unittest.mock import patch

import pytest

from shared.source_profiles import SOURCE_ID_RE
from shared.web_review_targets import TargetError, target_source_id, validated_target, web_review_source_id

URL = 'https://www.trustpilot.com/review/example.com'


@pytest.fixture
def public_dns():
    with patch('shared.web_review_targets.validate_url', return_value=(True, '')) as check:
        yield check


def test_a_valid_target_is_stored_as_strings(public_dns):
    assert validated_target({'id': 'abc', 'app_name': 'Trustpilot', 'url': URL, 'max_pages': 7, 'extra': 'x'}) == {
        'id': 'abc', 'app_name': 'Trustpilot', 'url': URL, 'max_pages': '7', 'max_reviews': '0', 'frequency_minutes': '0',
        'enabled': 'true',
    }
    public_dns.assert_called_once_with(URL)


@pytest.mark.usefixtures('public_dns')
def test_defaults_to_ten_pages_and_no_review_limit():
    stored = validated_target({'app_name': 'T', 'url': URL})
    assert (stored['max_pages'], stored['max_reviews']) == ('10', '0')


@pytest.mark.usefixtures('public_dns')
@pytest.mark.parametrize(('pages', 'reviews'), [
    ('10', '0'),   # the latest 10 pages
    ('0', '200'),  # the latest 200 reviews
    ('0', '0'),    # everything (up to the 100-page cap)
])
def test_the_three_reading_modes_are_stored_as_given(pages, reviews):
    stored = validated_target({'app_name': 'T', 'url': URL, 'max_pages': pages, 'max_reviews': reviews})
    assert (stored['max_pages'], stored['max_reviews']) == (pages, reviews)


@pytest.mark.parametrize('url', ['https://127.0.0.1/r', 'https://localhost/r', 'https://user@example.com/r'])
def test_rejects_internal_destinations(url):
    with pytest.raises(TargetError, match='URL rejected'):
        validated_target({'app_name': 'T', 'url': url})


def test_rejects_a_name_that_resolves_to_a_private_address():
    with patch('shared.url_policy.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.5', 443))]), \
            pytest.raises(TargetError, match='internal/private'):
        validated_target({'app_name': 'T', 'url': 'https://reviews.internal.example/r'})


@pytest.mark.parametrize(('host', 'app_name', 'expected'), [
    ('www.trustpilot.com', 'Example Air', 'web_trustpilot_example_air'),
    ('www.trustpilot.com', 'Example Air main', 'web_trustpilot_example_air_main'),
    ('uk.trustpilot.com', 'Example Air', 'web_trustpilot_example_air'),
    ('WWW.TripAdvisor.co.uk.', 'Example Air', 'web_tripadvisor_example_air'),
    ('m.tripadvisor.com', 'Example-Air  (UK)', 'web_tripadvisor_example_air_uk'),
    ('airlines-inform.com', 'Example Air', 'web_airlines-inform_example_air'),
    ('reviews', 'Example Air', 'web_reviews_example_air'),
    ('www.trustpilot.com', '  --  ', 'web_trustpilot_reviews'),
])
def test_source_id_per_connector(host, app_name, expected):
    assert web_review_source_id(host, app_name) == expected
    assert SOURCE_ID_RE.match(expected)


def test_two_brands_on_one_site_get_their_own_sources():
    assert web_review_source_id('www.trustpilot.com', 'Example Air') != web_review_source_id('www.trustpilot.com', 'Example Rail')


def test_a_long_name_keeps_a_valid_unique_id():
    first = web_review_source_id('www.trustpilot.com', 'Example Air ' + 'a' * 60 + ' one')
    second = web_review_source_id('www.trustpilot.com', 'Example Air ' + 'a' * 60 + ' two')
    assert SOURCE_ID_RE.match(first)
    assert (len(first), len(second)) == (48, 48)
    assert first != second


@pytest.mark.usefixtures('public_dns')
def test_a_stored_source_id_is_kept():
    stored = validated_target({'app_name': 'T', 'url': URL, 'source_id': 'web_trustpilot_example_air'})
    assert stored['source_id'] == 'web_trustpilot_example_air'


@pytest.mark.usefixtures('public_dns')
@pytest.mark.parametrize('source_id', ['webscraper', 'web_', 'web_Example', 'web_a.b', 'web_' + 'a' * 45, 7])
def test_a_source_id_that_is_not_a_web_review_one_is_refused(source_id: object):
    with pytest.raises(TargetError) as refused:
        validated_target({'app_name': 'T', 'url': URL, 'source_id': source_id})
    assert str(refused.value) == 'source_id must be a web review source id'


@pytest.mark.parametrize(('target', 'expected'), [
    ({'source_id': 'web_trustpilot_example_air', 'url': URL, 'app_name': 'Renamed'}, 'web_trustpilot_example_air'),
    ({'url': URL, 'app_name': 'Example Air'}, 'web_trustpilot_example_air'),
    ({'source_id': 'not valid', 'url': URL, 'app_name': 'Example Air'}, 'web_trustpilot_example_air'),
])
def test_target_source_id_is_the_stored_one_or_minted(target, expected):
    assert target_source_id(target) == expected
