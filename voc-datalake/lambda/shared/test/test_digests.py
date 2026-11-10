"""``shared.digests.sha256_hex``: the one SHA-256 hex helper (erasure jobs, participant rows, tokens)."""
from shared.digests import sha256_hex


def test_is_the_full_lowercase_hex_digest():
    assert sha256_hex('a') == 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'


def test_hashes_the_utf8_bytes():
    assert sha256_hex('é') == '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'
