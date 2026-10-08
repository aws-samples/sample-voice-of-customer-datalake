"""Tests for the MCP credential format (shared/mcp_tokens.py).

No AWS: everything here is pure, which is the reason the module exists
separately from the two handlers that consume it.
"""

import pytest

from shared.mcp_tokens import (
    TOKEN_ID_PREFIX,
    TOKEN_PREFIX,
    hash_secret,
    mint_token,
    parse_token,
    secret_matches,
)

# ===========================================================================
# Format: mint → parse round trip
# ===========================================================================

class TestMintAndParse:
    def test_minted_token_parses_back_to_its_own_id(self):
        """The whole point of the format: the id is recoverable from the token.

        This is what replaces "Query the project's token rows and hash each
        one" with a single keyed read, and therefore what removes the
        X-Project-Id header requirement.
        """
        minted = mint_token()
        parsed = parse_token(minted.raw)
        assert parsed is not None, f'freshly minted token did not parse: {minted.raw!r}'
        token_id, secret = parsed
        assert token_id == minted.token_id
        assert secret_matches(presented_secret=secret, stored_hash=minted.secret_hash)

    def test_raw_token_never_contains_the_stored_hash(self):
        """Only the secret half is hashed, and the hash is not in the credential."""
        minted = mint_token()
        assert minted.secret_hash not in minted.raw

    def test_token_id_is_in_the_credential_so_it_can_be_logged(self):
        minted = mint_token()
        assert minted.token_id in minted.raw
        assert minted.token_id.startswith(TOKEN_ID_PREFIX)
        assert minted.raw.startswith(TOKEN_PREFIX)

    def test_each_mint_is_unique(self):
        assert len({mint_token().raw for _ in range(50)}) == 50

    def test_secret_hash_is_stable_for_the_same_secret(self):
        assert hash_secret('abc') == hash_secret('abc')
        assert hash_secret('abc') != hash_secret('abd')


class TestParseRejectsMalformed:
    """A lenient parse would turn caller text into a DynamoDB key lookup.

    Revert story: loosening `parse_token` to split on the LAST underscore and
    accept whatever precedes it fails test_legacy_token_is_refused and
    test_wrong_part_count.
    """

    @pytest.mark.parametrize('raw', [
        '',
        'voc_',
        'voc',
        'nope_tok_' + 'a' * 16 + '_' + 'b' * 64,
        'voc_bad_' + 'a' * 16 + '_' + 'b' * 64,          # wrong id prefix
        'voc_tok_' + 'a' * 15 + '_' + 'b' * 64,          # id too short
        'voc_tok_' + 'a' * 17 + '_' + 'b' * 64,          # id too long
        'voc_tok_' + 'a' * 16 + '_' + 'b' * 63,          # secret too short
        'voc_tok_' + 'a' * 16 + '_' + 'b' * 65,          # secret too long
        'voc_tok_' + 'g' * 16 + '_' + 'b' * 64,          # id not hex
        'voc_tok_' + 'a' * 16 + '_' + 'g' * 64,          # secret not hex
        'voc_tok_' + 'A' * 16 + '_' + 'b' * 64,          # uppercase is not our format
        'voc_tok_' + 'a' * 16 + '_' + 'b' * 64 + '_x',   # extra part
    ])
    def test_wrong_part_count_or_alphabet_is_refused(self, raw):
        assert parse_token(raw) is None, f'{raw!r} must not parse'

    def test_legacy_token_is_refused(self):
        """`voc_<64 hex>` was the old format; it is deliberately not accepted.

        Owner decision 2026-08-18: no legacy tokens were in production use, and
        a stray one fails closed with a 401 that re-minting fixes. If this test
        ever needs deleting, that is a policy change, not a cleanup.
        """
        assert parse_token('voc_' + 'a' * 64) is None

    @pytest.mark.parametrize('raw', [None, 12345, b'voc_tok_x', ['voc_'], {}])
    def test_non_string_is_refused_not_raised(self, raw):
        """A non-string arrives from a header that something else mangled;
        it must be a refusal, not an AttributeError turning into a 500."""
        assert parse_token(raw) is None


class TestSecretMatches:
    def test_correct_secret_matches(self):
        assert secret_matches(presented_secret='s3cret', stored_hash=hash_secret('s3cret'))

    def test_wrong_secret_does_not_match(self):
        assert not secret_matches(presented_secret='s3cret', stored_hash=hash_secret('other'))

    def test_empty_stored_hash_does_not_match(self):
        assert not secret_matches(presented_secret='s3cret', stored_hash='')


# ===========================================================================
# Storage keys
# ===========================================================================
