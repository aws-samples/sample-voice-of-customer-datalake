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
- Key the dedup on the full URL instead of the hostname (which memoizes nothing
  for one site with one path per scraper)
  -> `accepts_a_large_all_public_array`, `resolves_once_per_host_not_once_per_write`.
- Skip the whole policy for a cleared host rather than only its resolution
  -> `still_applies_the_local_checks_to_a_cleared_hosts_other_urls`.
- Apply MAX_SCRAPER_URLS to a list the write only carries forward
  -> `accepts_an_unchanged_over_cap_list_alongside_an_edit`.
- Exempt an unchanged list from the DESTINATION check as well as the count
  -> `still_checks_the_destinations_of_an_exempt_list`.
- Treat any over-cap list as pre-existing -> `refuses_growing_a_list_that_is_already_over_the_cap`,
  `refuses_a_newly_added_over_cap_list_and_names_the_config`.
- Take the LAST entry for a duplicated stored id, so array order decides whether
  the exemption applies -> `grants_no_exemption_for_a_duplicated_stored_id`.
- Make `seen` opt-in again, so a caller passing nothing resolves once per URL
  -> `resolves_once_per_host_without_being_asked_to`.
- Wire the exemption into the array route only, leaving `POST /scrapers` unable to
  re-save a pre-existing over-cap config
  -> `TestSingleConfigWrite::accepts_an_unchanged_over_cap_list`.

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

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_resolves_once_per_host_without_being_asked_to(self, mock_resolve):
        """
        The memo is the DEFAULT, not something a caller has to know to request.

        It was opt-in, and `POST /scrapers` passed nothing — so a config naming
        MAX_SCRAPER_URLS URLs on one host cost that many synchronous lookups
        inside one API Gateway request, while both docs said hosts were resolved
        once per write. The route that did not ask is the route that most needed
        it.
        """
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_destinations

        mock_resolve.return_value = PUBLIC_ADDRINFO

        validate_scraper_destinations({
            'urls': [
                f'https://reviews.example.com/page-{i}'
                for i in range(MAX_SCRAPER_URLS)
            ],
        })

        assert mock_resolve.call_count == 1

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_a_default_memo_does_not_outlive_one_call(self, mock_resolve):
        """
        The other direction, and the reason the default is built per call rather
        than shared: "this host was public a minute ago" is precisely the claim
        this check must not make, so two separate calls must both resolve.
        """
        from shared.scraper_urls import validate_scraper_destinations

        mock_resolve.return_value = PUBLIC_ADDRINFO

        for _ in range(2):
            validate_scraper_destinations({'base_url': 'https://reviews.example.com/'})

        assert mock_resolve.call_count == 2


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

        The paths are DISTINCT on purpose. With all 400 sharing one URL string
        this passed against a full-URL memo that bounded nothing: one site with
        one page per scraper is the realistic large array, and it cost 400
        synchronous resolver calls inside API Gateway's 29 s window.
        """
        from shared.scraper_urls import validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO

        validate_scraper_configs_json(json.dumps([
            {'id': f's{i}', 'base_url': f'https://reviews.example.com/scraper-{i}'}
            for i in range(400)
        ]))

        assert mock_resolve.call_count == 1

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_resolves_once_per_host_not_once_per_write(self, mock_resolve):
        """
        The memo is per HOST, so the call count tracks distinct hosts. Pins the
        direction too: two hosts must not collapse into one lookup.
        """
        from shared.scraper_urls import validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO

        validate_scraper_configs_json(json.dumps([
            {'id': 'a', 'base_url': 'https://a.example.com/one'},
            {'id': 'b', 'base_url': 'https://b.example.com/two'},
        ]))

        assert mock_resolve.call_count == 2

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_still_applies_the_local_checks_to_a_cleared_hosts_other_urls(
        self, mock_resolve
    ):
        """
        Only RESOLUTION is memoized. Skipping the whole policy for a host already
        cleared in this write would let the second URL on that host carry a
        refused scheme — the memo is an optimization, not an exemption.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import validate_scraper_destinations

        mock_resolve.return_value = PUBLIC_ADDRINFO

        with pytest.raises(ValidationError, match='http and https'):
            validate_scraper_destinations(
                {'urls': ['https://h.example.com/a', 'gopher://h.example.com/b']},
                seen=set(),
            )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_accepts_an_unchanged_over_cap_list_alongside_an_edit(
        self, mock_resolve
    ):
        """
        MAX_SCRAPER_URLS must not apply retroactively. This route persists the
        WHOLE array, so enforcing the cap on a list the write merely carries
        forward made one pre-existing over-cap config block saving every other
        config — a rename of `other` was refused, naming a limit on a config the
        user never touched, with no in-app way to trim the offender.
        """
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO
        legacy_urls = [
            f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 10)
        ]
        stored = json.dumps([
            {'id': 'legacy', 'urls': legacy_urls},
            {'id': 'other', 'base_url': 'https://example.com/'},
        ])
        incoming = json.dumps([
            {'id': 'legacy', 'urls': legacy_urls},
            {'id': 'other', 'base_url': 'https://example.com/', 'name': 'renamed'},
        ])

        validate_scraper_configs_json(incoming, stored=stored)

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_growing_a_list_that_is_already_over_the_cap(self, mock_resolve):
        """Carrying an over-cap list forward is exempt; adding to it is not."""
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO
        legacy_urls = [
            f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 10)
        ]
        stored = json.dumps([{'id': 'legacy', 'urls': legacy_urls}])
        grown = json.dumps([
            {'id': 'legacy', 'urls': [*legacy_urls, 'https://example.com/new']},
        ])

        with pytest.raises(ValidationError, match='Too many URLs'):
            validate_scraper_configs_json(grown, stored=stored)

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_newly_added_over_cap_list_and_names_the_config(
        self, mock_resolve
    ):
        """
        The cap still does its job for a list this write creates, and the message
        names WHICH config to trim — the array route refuses the whole write, so
        an unnamed limit leaves the user searching.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO
        incoming = json.dumps([{
            'id': 'fresh',
            'urls': [
                f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 1)
            ],
        }])

        with pytest.raises(ValidationError, match="fresh"):
            validate_scraper_configs_json(incoming, stored='[]')

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_still_checks_the_destinations_of_an_exempt_list(self, mock_resolve):
        """
        The count is exempt for an unchanged list; the DESTINATIONS never are.
        Otherwise an over-cap legacy config would be a place to park an internal
        URL that no later write would look at.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_configs_json

        mock_resolve.return_value = PRIVATE_ADDRINFO
        urls = [
            f'https://internal.example.com/{i}'
            for i in range(MAX_SCRAPER_URLS + 5)
        ]
        same = json.dumps([{'id': 'legacy', 'urls': urls}])

        with pytest.raises(ValidationError, match='internal/private'):
            validate_scraper_configs_json(same, stored=same)


class TestStoredExemptionBaseline:
    """
    `_stored_urls_by_id` decides whether the URL-count cap is a NEW violation, so
    an unreadable stored value must grant no exemption AND not fail the write.
    """

    @pytest.mark.parametrize('order', ['over_cap_last', 'over_cap_first'])
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_grants_no_exemption_for_a_duplicated_stored_id(
        self, mock_resolve, order
    ):
        """
        Keying a dict on `id` kept whichever duplicate came LAST, so the same
        stored content accepted or refused the same write depending on array
        order. Parametrized over both orderings precisely so the assertion cannot
        pass by order — a duplicated id is a stored value nobody should be
        reasoning about, and declining to exempt it is the same fail-closed
        choice the unparseable cases make.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO
        over_cap = [
            f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 10)
        ]
        entries = [{'id': 'dup', 'urls': []}, {'id': 'dup', 'urls': over_cap}]
        if order == 'over_cap_first':
            entries.reverse()

        with pytest.raises(ValidationError, match='Too many URLs'):
            validate_scraper_configs_json(
                json.dumps([{'id': 'dup', 'urls': over_cap}]),
                stored=json.dumps(entries),
            )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_a_unique_id_still_exempts(self, mock_resolve):
        """Positive control: refusing duplicates must not refuse everything."""
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO
        over_cap = [
            f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 10)
        ]
        same = json.dumps([{'id': 'solo', 'urls': over_cap}])

        validate_scraper_configs_json(same, stored=same)

    @pytest.mark.parametrize('stored', [
        'not json at all',
        '',
        None,
        json.dumps({'id': 'legacy'}),   # an object, not an array
        json.dumps([{'urls': []}]),     # no id to match on
    ])
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_an_unreadable_stored_value_grants_no_exemption(
        self, mock_resolve, stored
    ):
        """
        Best-effort in one direction only: it may not weaken the cap, and it may
        not fail the write either.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_configs_json

        mock_resolve.return_value = PUBLIC_ADDRINFO
        incoming = json.dumps([{
            'id': 'legacy',
            'urls': [
                f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 1)
            ],
        }])

        with pytest.raises(ValidationError, match='Too many URLs'):
            validate_scraper_configs_json(incoming, stored=stored)


class TestSingleConfigWrite:
    """
    `validate_scraper_config_write` is what `POST /scrapers` calls, and it must
    reach the same verdict as the array route on the same config.

    The exemption for a `urls` list a write carries forward was wired into the
    array route alone, so a pre-existing over-cap config was refused on EVERY
    save through `POST /scrapers` — including a change to an unrelated field —
    and trimming it needed a save. Deleting the config was the only escape.
    """

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_accepts_an_unchanged_over_cap_list(self, mock_resolve):
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_config_write

        mock_resolve.return_value = PUBLIC_ADDRINFO
        legacy_urls = [
            f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 10)
        ]
        stored = json.dumps([{'id': 'legacy', 'urls': legacy_urls}])

        validate_scraper_config_write(
            {'id': 'legacy', 'name': 'renamed', 'urls': legacy_urls}, stored=stored
        )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_growing_an_over_cap_list(self, mock_resolve):
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_config_write

        mock_resolve.return_value = PUBLIC_ADDRINFO
        legacy_urls = [
            f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 10)
        ]
        stored = json.dumps([{'id': 'legacy', 'urls': legacy_urls}])

        with pytest.raises(ValidationError, match='Too many URLs'):
            validate_scraper_config_write(
                {'id': 'legacy', 'urls': [*legacy_urls, 'https://example.com/new']},
                stored=stored,
            )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_newly_added_over_cap_list(self, mock_resolve):
        """The cap still does its job for a list this write creates."""
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_config_write

        mock_resolve.return_value = PUBLIC_ADDRINFO

        with pytest.raises(ValidationError, match='Too many URLs'):
            validate_scraper_config_write(
                {
                    'id': 'fresh',
                    'urls': [
                        f'https://example.com/{i}'
                        for i in range(MAX_SCRAPER_URLS + 1)
                    ],
                },
                stored='[]',
            )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_still_checks_the_destinations_of_an_exempt_list(self, mock_resolve):
        """
        The count is exempt; the DESTINATIONS never are. Otherwise an over-cap
        legacy config would be a place to park an internal URL that no later
        write would look at.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_config_write

        mock_resolve.return_value = PRIVATE_ADDRINFO
        urls = [
            f'https://internal.example.com/{i}'
            for i in range(MAX_SCRAPER_URLS + 5)
        ]

        with pytest.raises(ValidationError, match='internal/private'):
            validate_scraper_config_write(
                {'id': 'legacy', 'urls': urls},
                stored=json.dumps([{'id': 'legacy', 'urls': urls}]),
            )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_enforces_the_cap_when_no_stored_value_is_available(self, mock_resolve):
        """
        A route that cannot read the secret gets no exemption — the write is still
        checked, it just cannot tell a carried-forward list from a new one.
        """
        from shared.exceptions import ValidationError
        from shared.scraper_urls import MAX_SCRAPER_URLS, validate_scraper_config_write

        mock_resolve.return_value = PUBLIC_ADDRINFO

        with pytest.raises(ValidationError, match='Too many URLs'):
            validate_scraper_config_write({
                'id': 'legacy',
                'urls': [
                    f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 1)
                ],
            })


class TestOnePolicyForEveryWritePath:
    """Both write routes must call THIS function, not their own copy."""

    def test_uses_the_shared_policy_object(self):
        from shared import http_utils, scraper_urls

        assert scraper_urls.assert_outbound_url_allowed is (
            http_utils.assert_outbound_url_allowed
        )

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_both_routes_reach_the_same_verdict_on_the_same_config(self, mock_resolve):
        """
        The two entry points must not disagree about one config.

        They did: the array route exempted an unchanged over-cap list and the
        single-config route refused it, so the same stored config was saveable
        through the Settings card and unsaveable through the scrapers editor.
        """
        from shared.scraper_urls import (
            MAX_SCRAPER_URLS,
            validate_scraper_config_write,
            validate_scraper_configs_json,
        )

        mock_resolve.return_value = PUBLIC_ADDRINFO
        legacy_urls = [
            f'https://example.com/{i}' for i in range(MAX_SCRAPER_URLS + 10)
        ]
        config = {'id': 'legacy', 'urls': legacy_urls}
        stored = json.dumps([config])

        # Neither raises.
        validate_scraper_configs_json(stored, stored=stored)
        validate_scraper_config_write(config, stored=stored)

    def test_the_serialized_form_delegates_to_the_single_config_check(self):
        """
        Asserted by observation rather than by reading the source: the array form
        must not grow its own field list.
        """
        from shared import scraper_urls

        with patch.object(scraper_urls, 'validate_scraper_destinations') as mock_check:
            scraper_urls.validate_scraper_configs_json(json.dumps([{'id': 'a'}, {'id': 'b'}]))

        assert mock_check.call_count == 2
