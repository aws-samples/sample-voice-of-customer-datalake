"""
Write-time destination checking for scraper configs (issue #244).

`shared/http_utils.py` decides whether one URL is a permitted destination, and
`test_outbound_url_policy.py` covers that. This file covers the CONFIG shape:
which keys are checked, what a wrongly-typed field reports, and — the reason this
module exists rather than living in `scrapers_handler` — that the serialized
array form used by `PUT /integrations/webscraper/credentials` is checked too.

There are TWO persistence paths into the same `webscraper_configs` secret key,
in two Lambdas that cannot import each other, so checking one of them is the same
bug in a different route. `test_integrations_security.py` asserts the route-level
half; this file asserts the check itself.

REVERT MAP
----------
- Coerce a non-list `urls` back to `[value]` -> `names_urls_when_it_is_not_a_list`.
- Drop the per-element string check -> `names_the_index_of_a_non_string_url`.
- Drop MAX_SCRAPER_URLS -> `refuses_more_urls_than_one_invocation_can_resolve`.
- Accept a non-dict config -> `refuses_a_config_that_is_not_an_object`.
- Make `validate_scraper_configs_json` ignore unparseable input
  -> `refuses_a_configs_value_that_is_not_json`.
- Stop checking configs inside the array -> `refuses_an_internal_url_inside_the_array`.
- Drop the per-write dedup -> `resolves_a_repeated_url_once_per_write`.

Every "refuses" case has a positive control, so an implementation that refused
everything could not pass this file.

Resolution is patched at `shared.http_utils.socket.getaddrinfo`; no test here
touches the network.
"""

import json
from unittest.mock import patch

import pytest

PUBLIC_ADDRINFO = [(2, 1, 6, '', ('93.184.216.34', 80))]
PRIVATE_ADDRINFO = [(2, 1, 6, '', ('10.1.2.3', 80))]


class TestSingleConfig:

    def test_refuses_a_config_that_is_not_an_object(self):
        """A list sails past `.get()`-based validation as "no URLs to check"."""
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_destinations

        with pytest.raises(ValidationError):
            validate_scraper_destinations(['http://169.254.169.254/'])

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_names_urls_when_it_is_not_a_list(self, mock_resolve):
        """
        A bare string used to validate as ONE url and pass. Refused now with the
        field named, mirroring `integrations_handler`'s per-value type check.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_destinations

        with pytest.raises(ValidationError, match='urls'):
            validate_scraper_destinations({'urls': 'https://example.com/'})

        mock_resolve.assert_not_called()

    def test_names_base_url_when_it_is_not_a_string(self):
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_destinations

        with pytest.raises(ValidationError, match='base_url'):
            validate_scraper_destinations({'base_url': ['https://example.com/']})

    def test_names_the_index_of_a_non_string_url(self):
        """
        A dict inside `urls` reached the policy and came back as the misleading
        'URL is required'; the index is what makes a long list actionable.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_destinations

        with pytest.raises(ValidationError, match=r'urls\[1\]'):
            validate_scraper_destinations(
                {'urls': ['https://example.com/', {'u': 'x'}]}
            )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_more_urls_than_one_invocation_can_resolve(self, mock_resolve):
        """Each URL is a synchronous getaddrinfo inside an API Gateway request."""
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_destinations

        mock_resolve.return_value = PUBLIC_ADDRINFO

        with pytest.raises(ValidationError, match='Too many URLs'):
            validate_scraper_destinations(
                {'urls': [f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 1)]}
            )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_names_the_offending_url_not_just_the_field(self, mock_resolve):
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_destinations

        mock_resolve.return_value = PRIVATE_ADDRINFO

        with pytest.raises(ValidationError, match='sneaky.example'):
            validate_scraper_destinations({'base_url': 'https://sneaky.example/'})

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_accepts_an_all_public_config(self, mock_resolve):
        """The main positive control."""
        from shared.scraper_urls import validate_scraper_destinations

        mock_resolve.return_value = PUBLIC_ADDRINFO

        validate_scraper_destinations({
            'base_url': 'https://reviews.example.com/',
            'urls': ['https://reviews.example.com/page/2'],
        })

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_accepts_an_empty_draft_without_asking_the_resolver(self, mock_resolve):
        """The editor ships base_url: '' and urls: [] for a new scraper."""
        from shared.scraper_urls import validate_scraper_destinations

        validate_scraper_destinations({'id': 's1', 'base_url': '', 'urls': []})

        mock_resolve.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_resolves_a_repeated_url_once_per_write(self, mock_resolve):
        """
        What replaces a cap on the NUMBER of configs: identical URLs within one
        write cost one resolver call. The set is per-request only — nothing is
        cached across invocations, because "this host was public a minute ago" is
        exactly the claim this check must not make.
        """
        from shared.scraper_urls import validate_scraper_destinations

        mock_resolve.return_value = PUBLIC_ADDRINFO
        seen: set = set()

        for _ in range(5):
            validate_scraper_destinations(
                {'base_url': 'https://reviews.example.com/'}, seen=seen
            )

        assert mock_resolve.call_count == 1


class TestSerializedConfigsArray:
    """
    `PUT /integrations/webscraper/credentials` stores the WHOLE array as one
    string, which is how the Settings webscraper card saves. That path wrote
    unchecked, so an internal destination stayed reachable through a different
    route from the one #244 named.
    """

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_an_internal_url_inside_the_array(self, mock_resolve):
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_configs_json

        mock_resolve.return_value = PRIVATE_ADDRINFO

        with pytest.raises(ValidationError, match='base_url'):
            validate_scraper_configs_json(json.dumps([
                {'id': 's1', 'base_url': 'https://sneaky.example/'},
            ]))

    def test_refuses_a_direct_internal_literal_inside_the_array(self):
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_configs_json

        with pytest.raises(ValidationError, match='internal/private'):
            validate_scraper_configs_json(json.dumps([
                {'id': 's1', 'base_url': 'http://169.254.169.254/latest/meta-data/'},
            ]))

    def test_refuses_a_configs_value_that_is_not_json(self):
        """
        The ingestor logs a JSONDecodeError and scrapes nothing, so storing a
        broken array is a silently dead integration.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_configs_json

        with pytest.raises(ValidationError, match='JSON'):
            validate_scraper_configs_json('[{"id": ')

    def test_refuses_a_configs_value_that_is_not_an_array(self):
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_configs_json

        with pytest.raises(ValidationError, match='array'):
            validate_scraper_configs_json(json.dumps({'id': 's1'}))

    def test_refuses_a_non_string_configs_value(self):
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_configs_json

        with pytest.raises(ValidationError, match='configs'):
            validate_scraper_configs_json([{'id': 's1'}])

    @pytest.mark.parametrize('raw', [None, '', '[]'])
    def test_accepts_the_absent_and_empty_forms(self, raw):
        """'[]' is the seeded default for the key; '' means the same thing."""
        from shared.scraper_urls import validate_scraper_configs_json

        validate_scraper_configs_json(raw)

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_accepts_a_large_all_public_array(self, mock_resolve):
        """
        Positive control, and the reason there is no cap on the NUMBER of configs:
        `test_value_larger_than_4kib_is_accepted` in test_integrations_security.py
        exists because an earlier per-value size cap made saving fail at around
        eight scrapers. Dedup, not a count limit, is what bounds the cost.
        """
        from shared.scraper_urls import validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO

        validate_scraper_configs_json(json.dumps([
            {'id': f's{i}', 'base_url': 'https://reviews.example.com/'}
            for i in range(400)
        ]))

        assert mock_resolve.call_count == 1


class TestOnePolicyForEveryWritePath:
    """Both write routes must call THIS function, not their own copy."""

    def test_uses_the_shared_policy_object(self):
        from shared import http_utils, scraper_urls

        assert scraper_urls.assert_outbound_url_allowed is (
            http_utils.assert_outbound_url_allowed
        )

    def test_the_serialized_form_delegates_to_the_single_config_check(self):
        """
        Asserted by observation rather than by reading the source: the array form
        must not grow its own field list.
        """
        from shared import scraper_urls

        with patch.object(scraper_urls, 'validate_scraper_destinations') as mock_check:
            scraper_urls.validate_scraper_configs_json(json.dumps([{'id': 'a'}, {'id': 'b'}]))

        assert mock_check.call_count == 2
