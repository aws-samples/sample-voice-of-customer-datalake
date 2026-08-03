"""
Tests for the shared prototype S3 layout and signed-URL minting (issue #229).

The key format is shared between the document-generator job (which writes the
object) and the projects API (which mints the URL). If those two ever disagree,
prototypes 404 — so the format is asserted literally here rather than derived,
so a change has to be deliberate.
"""
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse


class TestPrototypeS3Key:
    def test_key_layout(self):
        from shared.prototypes import prototype_s3_key
        assert prototype_s3_key('proj_1', 'prototype_2') == 'prototypes/proj_1/prototype_2.html'

    def test_key_sits_under_the_prototypes_prefix(self):
        """The /prototypes/* cache behavior maps 1:1 onto this prefix; a key
        outside it would be served by the SPA's default behavior instead, with
        the wrong CSP and no key-group restriction."""
        from shared.prototypes import prototype_s3_key
        assert prototype_s3_key('p', 'd').startswith('prototypes/')


class TestPrototypeSignedUrl:
    CDN = 'https://d111.cloudfront.net/prototypes'

    def test_returns_a_signed_url_for_the_derived_key(self, cdn_signing_configured):
        from shared.prototypes import prototype_signed_url

        url = prototype_signed_url('proj_1', 'prototype_2', cdn_url=self.CDN)

        assert url.startswith(f'{self.CDN}/proj_1/prototype_2.html?')
        assert set(parse_qs(urlparse(url).query)) == {'Expires', 'Signature', 'Key-Pair-Id'}

    def test_url_path_matches_the_s3_key(self, cdn_signing_configured):
        """Guard against the two helpers drifting apart."""
        from shared.prototypes import prototype_s3_key, prototype_signed_url

        url = prototype_signed_url('proj_9', 'prototype_9', cdn_url=self.CDN)

        assert urlparse(url).path == f'/{prototype_s3_key("proj_9", "prototype_9")}'

    def test_strips_a_trailing_slash_on_the_cdn_base(self, cdn_signing_configured):
        from shared.prototypes import prototype_signed_url

        url = prototype_signed_url('p', 'd', cdn_url=f'{self.CDN}/')

        assert url.startswith(f'{self.CDN}/p/d.html?')

    def test_reads_the_cdn_base_from_env(self, cdn_signing_configured):
        from shared.prototypes import prototype_signed_url

        with patch.dict('os.environ', {'PROTOTYPES_CDN_URL': self.CDN}):
            url = prototype_signed_url('p', 'd')

        assert url.startswith(f'{self.CDN}/p/d.html?')

    def test_returns_none_without_a_cdn_base(self, cdn_signing_configured):
        from shared.prototypes import prototype_signed_url
        with patch.dict('os.environ', {'PROTOTYPES_CDN_URL': ''}):
            assert prototype_signed_url('p', 'd') is None

    def test_returns_none_when_signing_is_unavailable(self):
        """Fail closed: prototype HTML is PRD/PR-FAQ-derived, so this is the
        higher-sensitivity of the two protected paths."""
        from shared.prototypes import prototype_signed_url
        assert prototype_signed_url('p', 'd', cdn_url=self.CDN) is None

    def test_returns_none_for_missing_ids(self, cdn_signing_configured):
        from shared.prototypes import prototype_signed_url
        assert prototype_signed_url('', 'd', cdn_url=self.CDN) is None
        assert prototype_signed_url('p', '', cdn_url=self.CDN) is None


class TestNoCryptoDependencyForWriters:
    """The document-generator job imports this module only for
    `prototype_s3_key` — it writes prototype HTML and never signs anything.

    A module-scope `from shared.cloudfront_signing import sign_url` made that
    writer depend on `cryptography` at COLD START, so detaching the layer that
    carries it would have taken prototype generation down for a dependency the
    job does not use. The import is now inside `prototype_signed_url`; this test
    is what stops someone hoisting it back to the top of the file.
    """

    def test_importing_the_module_does_not_pull_in_cryptography(self):
        import subprocess
        import sys

        # A subprocess, because `cryptography` is almost certainly already in
        # this test session's sys.modules (the signing tests and the
        # cdn_signing_keypair fixture both use it), so an in-process check would
        # pass no matter what the import graph looks like.
        code = (
            'import sys; import shared.prototypes; '
            "print('cryptography' in sys.modules)"
        )
        result = subprocess.run(
            [sys.executable, '-c', code],
            capture_output=True, text=True, check=True, cwd='lambda',
        )

        assert result.stdout.strip() == 'False', (
            'Importing shared.prototypes pulled in cryptography. Keep the '
            'shared.cloudfront_signing import inside prototype_signed_url.'
        )

    def test_prototype_s3_key_works_without_touching_the_signer(self):
        """The writer-only entry point stays usable with no signing config."""
        from shared.prototypes import prototype_s3_key

        assert prototype_s3_key('p', 'd') == 'prototypes/p/d.html'
