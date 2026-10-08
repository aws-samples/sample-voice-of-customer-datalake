"""Mutation-hardening suite for shared/scraper_run_errors.py.

The handler suites (logs privacy, scrapers status/runs) prove one legacy row is
redacted end to end, but they never pin where each allowlist stops: the exact
withheld strings, the 100-character exception-class ceiling, the 2,048-character
URL ceiling, the 200-character policy-reason ceiling and its character set, the
50-entry cap, or that a non-list ``errors`` yields ``[]``. A mutant widening any
of those boundaries leaked stored exception text without failing a test. Every
expectation below is a literal so a widened or narrowed allowlist fails here.
"""

import pytest

from shared.scraper_run_errors import (
    ERROR_TYPE_SHAPE,
    MAX_RETURNED_ERRORS,
    redact_scraper_error,
    redacted_scraper_errors,
)

URL = 'https://shop.example/reviews'
PREFIX = f'Error scraping {URL}: '
WITHHELD = 'Scraper error (details withheld)'
DETAIL_WITHHELD = f'{PREFIX}error details withheld'


class TestPublicConstants:
    def test_the_cap_is_fifty(self):
        assert MAX_RETURNED_ERRORS == 50

    @pytest.mark.parametrize(('name', 'matches'), [
        ('KeyError', True),
        ('_private', True),
        ('a' * 100, True),
        ('a' * 101, False),
        ('', False),
        ('9Error', False),
        ('Key-Error', False),
    ])
    def test_error_type_shape(self, name: str, matches: bool):
        assert (ERROR_TYPE_SHAPE.match(name) is not None) is matches


class TestNonStringEntriesAreWithheld:
    @pytest.mark.parametrize('error', [None, 42, {'msg': 'x'}, ['x'], b'No scraper configuration found'])
    def test_withheld(self, error: object):
        assert redact_scraper_error(error) == WITHHELD


class TestFixedStrings:
    def test_no_configuration_is_returned_as_written(self):
        assert redact_scraper_error('No scraper configuration found') == 'No scraper configuration found'

    @pytest.mark.parametrize('error', [
        'No scraper configuration found.',
        'no scraper configuration found',
        'XXNo scraper configuration foundXX',
        'Traceback: boom at jane.doe@example.com',
        '',
    ])
    def test_anything_else_without_the_prefix_is_withheld(self, error: str):
        assert redact_scraper_error(error) == WITHHELD


class TestPrefixShape:
    @pytest.mark.parametrize('error', [
        'Error scraping : KeyError',  # empty URL
        'Error scraping a b: KeyError',  # whitespace inside the URL
        f'Error scraping {URL}:KeyError',  # no space after the colon
        f'error scraping {URL}: KeyError',
        f' Error scraping {URL}: KeyError',
        f'Error scraping {"u" * 2049}: KeyError',
    ])
    def test_malformed_prefix_is_withheld(self, error: str):
        assert redact_scraper_error(error) == WITHHELD

    def test_url_of_2048_characters_is_kept(self):
        error = f'Error scraping {"u" * 2048}: KeyError'
        assert redact_scraper_error(error) == error

    def test_one_character_url_is_kept(self):
        assert redact_scraper_error('Error scraping u: KeyError') == 'Error scraping u: KeyError'


class TestDetailAllowlist:
    @pytest.mark.parametrize('detail', [
        'KeyError',
        'a' * 100,
        'URL blocked by policy (Access to localhost is not allowed)',
        "URL blocked by policy (a/b, c.d 'e'-9)",
        f'URL blocked by policy ({"r" * 200})',
        'URL blocked by policy (x)',
    ])
    def test_kept_as_written(self, detail: str):
        assert redact_scraper_error(PREFIX + detail) == PREFIX + detail

    @pytest.mark.parametrize('detail', [
        '',
        'a' * 101,
        '500 Server Error for jane.doe@example.com',
        'HTTPError: 403 Forbidden',
        'URL blocked by policy ()',
        f'URL blocked by policy ({"r" * 201})',
        'URL blocked by policy (user@example.com)',
        'URL blocked by policy (x) trailing',
        'XXURL blocked by policy (x)',
        'url blocked by policy (x)',
        'URL blocked by policy x',
    ])
    def test_tail_is_withheld_but_prefix_kept(self, detail: str):
        assert redact_scraper_error(PREFIX + detail) == DETAIL_WITHHELD

    def test_only_the_first_prefix_is_kept(self):
        error = f'{PREFIX}Error scraping b: secret body'
        assert redact_scraper_error(error) == DETAIL_WITHHELD


class TestRedactedList:
    @pytest.mark.parametrize('errors', [None, 'Error scraping u: KeyError', ('KeyError',), {'a': 1}, 3])
    def test_non_list_is_empty(self, errors: object):
        assert redacted_scraper_errors(errors) == []

    def test_each_entry_redacted_in_order(self):
        errors = [PREFIX + 'KeyError', PREFIX + 'boom jane@example.com', None, 'No scraper configuration found']
        assert redacted_scraper_errors(errors) == [
            PREFIX + 'KeyError',
            DETAIL_WITHHELD,
            WITHHELD,
            'No scraper configuration found',
        ]

    def test_empty_list(self):
        assert redacted_scraper_errors([]) == []

    @pytest.mark.parametrize(('count', 'returned'), [(49, 49), (50, 50), (51, 50), (120, 50)])
    def test_capped_at_fifty_keeping_the_first(self, count: int, returned: int):
        errors = [f'Error scraping u{i}: KeyError' for i in range(count)]
        assert redacted_scraper_errors(errors) == [f'Error scraping u{i}: KeyError' for i in range(returned)]
