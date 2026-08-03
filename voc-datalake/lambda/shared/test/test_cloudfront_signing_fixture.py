"""
Guards the cross-language pin between the two CloudFront signers.

`lambda/stream/src/lib/__fixtures__/cloudfront-signing.botocore.json` holds the
canned-policy bytes that botocore's `CloudFrontSigner` produces, and the
TypeScript signer's test asserts its own output matches them byte-for-byte. That
fixture is the ONLY thing stopping the Python and TypeScript signers drifting
into signing different bytes — a drift that would surface as a 403 in a browser
and nowhere else.

So the fixture needs to be reproducible and auditable, which a throwaway script
is not. This test IS the generator: it recomputes the expected values from
botocore and fails if the committed fixture disagrees, which also means a
botocore upgrade that changed the policy serialization would be caught here
rather than in production.

Deliberately holds NO key material — `build_policy` does not sign, so no private
key is needed, and committing one to a public repo is not acceptable. Signature
agreement follows from policy agreement because RSA PKCS#1 v1.5 is
deterministic; the TS test proves its own signature verifies under RSA-SHA1.
"""
import datetime
import json
import pathlib

from botocore.signers import CloudFrontSigner

FIXTURE_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / 'stream' / 'src' / 'lib' / '__fixtures__' / 'cloudfront-signing.botocore.json'
)


def _signer(key_pair_id: str) -> CloudFrontSigner:
    # rsa_signer is never invoked: build_policy does not sign.
    return CloudFrontSigner(key_pair_id, lambda message: b'unused')


def _load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


class TestFixtureIsReproducible:
    def test_fixture_exists(self):
        assert FIXTURE_PATH.is_file(), f'missing cross-language fixture at {FIXTURE_PATH}'

    def test_canned_policy_matches_botocore(self):
        fx = _load_fixture()
        expires = datetime.datetime.fromtimestamp(fx['expiresEpochSeconds'], tz=datetime.timezone.utc)

        expected = _signer(fx['keyPairId']).build_policy(fx['url'], expires)

        assert fx['expectedCannedPolicy'] == expected, (
            'The committed fixture no longer matches botocore.build_policy. Either botocore '
            'changed its policy serialization (in which case the TypeScript signer in '
            'lambda/stream/src/lib/cloudfront-signing.ts must change with it) or the fixture '
            'was hand-edited. Do NOT just update the fixture without changing the TS side.'
        )

    def test_canned_policy_matches_botocore_for_a_url_with_a_query_string(self):
        fx = _load_fixture()
        expires = datetime.datetime.fromtimestamp(fx['expiresEpochSeconds'], tz=datetime.timezone.utc)

        expected = _signer(fx['keyPairId']).build_policy(fx['urlWithQuery'], expires)

        assert fx['expectedCannedPolicyForUrlWithQuery'] == expected

    def test_fixture_carries_no_key_material(self):
        raw = FIXTURE_PATH.read_text()

        assert 'PRIVATE KEY' not in raw
        assert 'privateKeyPem' not in raw

    def test_policy_orders_resource_before_condition(self):
        """Order is significant for a canned policy, per botocore's own comment."""
        policy = _load_fixture()['expectedCannedPolicy']

        assert policy.index('"Resource"') < policy.index('"Condition"')

    def test_policy_has_no_whitespace_padding(self):
        """botocore uses separators=(',', ':'); the TS side relies on JSON.stringify agreeing."""
        assert ' ' not in _load_fixture()['expectedCannedPolicy']
