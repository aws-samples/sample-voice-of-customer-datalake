"""Mutation hardening for `shared/plugin_identity.py`.

`test_integrations_security.py` and `test_plugin_secret_isolation.py` pin that
both sides of the Secrets Manager namespace import THIS predicate and that every
deployed plugin id and manifest key passes it. A mutation run on the module
itself found three things those tests cannot see:

* the WORDING of `PLUGIN_IDENTIFIER_RULES` survived every mutant. Both consumers
  embed it verbatim — the write path in a 400 body (``source must …``), the read
  path in the ConfigurationError that fails a plugin Lambda at construction — so
  a drifted sentence reaches an admin and an operator unchanged. It is pinned as
  one literal, and the numbers in it are checked against the pattern they
  describe.
* the character class was asserted only from the inside (real ids pass). Nothing
  refused a 65th character, accepted the 64th, or refused an underscore at either
  end — the bounds the module docstring states. Each is pinned on both sides.
* a non-string answers ``False`` instead of letting `re.fullmatch` raise. The
  ``and`` → ``or`` mutant turns that into a TypeError at the read path's call
  site; the control below shows the isinstance guard is what prevents it.
"""
import re
from typing import Any

import pytest

from shared.plugin_identity import (
    PLUGIN_IDENTIFIER_RE,
    PLUGIN_IDENTIFIER_RULES,
    is_valid_plugin_identifier,
)


class TestTheRulesSentenceIsTheOneBothPathsPrint:
    def test_the_sentence_is_pinned_verbatim(self):
        assert PLUGIN_IDENTIFIER_RULES == (
            'must contain only lowercase letters, digits, and underscores, must start '
            'and end with a letter or digit, and must be 1 to 64 characters long'
        )

    def test_the_length_the_sentence_names_is_the_length_the_pattern_enforces(self):
        """The sentence and the regex are two statements of one rule; a bound that
        moves in one and not the other is the drift the module exists to end."""
        bounds = re.search(r'must be (\d+) to (\d+) characters long', PLUGIN_IDENTIFIER_RULES)
        assert bounds is not None, PLUGIN_IDENTIFIER_RULES
        shortest, longest = int(bounds.group(1)), int(bounds.group(2))

        assert shortest == 1
        assert longest == 64
        assert is_valid_plugin_identifier('a' * shortest) is True
        assert is_valid_plugin_identifier('a' * (shortest - 1)) is False
        assert is_valid_plugin_identifier('a' * longest) is True
        assert is_valid_plugin_identifier('a' * (longest + 1)) is False


class TestTheLengthBoundOnBothSides:
    @pytest.mark.parametrize(('value', 'accepted'), [
        ('', False),
        ('a', True),
        ('7', True),
        ('a' * 63, True),
        ('a' * 64, True),
        ('a' * 65, False),
        # 62 is the inner body's cap: initial + 62 underscores + final is 64.
        ('a' + '_' * 62 + 'a', True),
        ('a' + '_' * 63 + 'a', False),
    ])
    def test_the_bound_is_inclusive_at_64_and_exclusive_at_65(self, value, accepted):
        assert is_valid_plugin_identifier(value) is accepted


class TestUnderscoreIsAnInteriorCharacterOnly:
    """`_` is the namespace separator, so a name may not blur into it at either end."""

    @pytest.mark.parametrize(('value', 'accepted'), [
        ('_', False),
        ('__', False),
        ('a_', False),
        ('_a', False),
        ('_a_', False),
        ('aa', True),
        ('a_b', True),
        ('a__b', True),
        ('app_reviews_ios', True),
        ('a_1_b_2', True),
    ])
    def test_a_leading_or_trailing_underscore_is_refused(self, value, accepted):
        assert is_valid_plugin_identifier(value) is accepted


class TestEveryOtherCharacterIsRefused:
    @pytest.mark.parametrize('value', [
        'Webscraper',
        'WEBSCRAPER',
        'web-scraper',
        'web.scraper',
        'web/scraper',
        'webscraper/../other',
        'web scraper',
        ' webscraper',
        'webscraper ',
        'webscraper\n',   # a `$`-anchored match would accept this; fullmatch must not
        '\nwebscraper',
        'webscraper\x00',
        'w\u00e9bscraper',  # 'é': [a-z] is ASCII-only
        '\u0661',           # Arabic-Indic one: a Unicode digit, not [0-9]
    ])
    def test_a_character_that_could_escape_or_reenter_a_namespace_is_refused(self, value):
        assert is_valid_plugin_identifier(value) is False


class TestNonStringsAreRefusedNotRaised:
    @pytest.mark.parametrize('value', [
        None,
        123,
        1.5,
        True,
        b'webscraper',
        ['webscraper'],
        ('webscraper',),
        {'id': 'webscraper'},
        object(),
    ])
    def test_a_non_string_answers_false(self, value):
        assert is_valid_plugin_identifier(value) is False

    def test_the_control_the_pattern_alone_would_raise_on_bytes(self):
        """The isinstance guard is load-bearing: without it the read path, which
        hands this an environment variable that may be unset, would get a
        TypeError instead of its own ConfigurationError."""
        # Typed `Any` on purpose: the point is a value the signature forbids.
        not_a_str: Any = b'webscraper'
        with pytest.raises(TypeError):
            PLUGIN_IDENTIFIER_RE.fullmatch(not_a_str)
