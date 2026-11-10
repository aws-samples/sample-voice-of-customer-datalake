"""Mutation hardening for `shared/mcp_tokens.py` (the credential format, since 3.00.00).

`test_mcp_tokens.py` pins the refusals and the round trip through the module's
own constants, so a mutation run found what that cannot see:

* the CREDENTIAL SHAPE. Widening the id or secret entropy moved mint and parse
  together, so the round trip survived; a literal ``voc_tok_<16 hex>_<64 hex>``
  must parse and every minted token must have exactly that shape.
* the hex alphabet (a non-hex letter such as ``X`` must be refused), the SHA-256
  digest itself, and the immutability of a minted credential.

3.00.00 removed the per-project token rows and their reach vocabulary from this
module (the global tokens live in `shared/mcp_global_tokens.py`), so their
wire-value and reach cases went with them.
"""
import dataclasses
import re

import pytest

from shared.mcp_tokens import hash_secret, mint_token, parse_token

_ID_HEX = '0123456789abcdef'
_SECRET_HEX = 'fedcba9876543210' * 4


class TestCredentialShape:
    def test_literal_token_parses_into_id_and_secret(self):
        raw = f'voc_tok_{_ID_HEX}_{_SECRET_HEX}'
        assert parse_token(raw) == (f'tok_{_ID_HEX}', _SECRET_HEX)

    def test_minted_token_has_exactly_16_hex_id_and_64_hex_secret(self):
        minted = mint_token()
        match = re.fullmatch(r'voc_(tok_[0-9a-f]{16})_([0-9a-f]{64})', minted.raw)
        assert match is not None, minted.raw
        assert match.group(1) == minted.token_id
        assert minted.secret_hash == hash_secret(match.group(2))

    @pytest.mark.parametrize('raw', [
        f'voc_tok_{"X" * 16}_{_SECRET_HEX}',
        f'voc_tok_{_ID_HEX}_{"X" * 64}',
    ])
    def test_non_hex_letter_is_refused(self, raw: str):
        assert parse_token(raw) is None


class TestHashAndImmutability:
    def test_hash_is_sha256_hex(self):
        assert hash_secret('abc') == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

    @pytest.mark.parametrize('field', ['raw', 'token_id', 'secret_hash'])
    def test_minted_token_is_frozen(self, field: str):
        minted = mint_token()
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(minted, field, 'tampered')
