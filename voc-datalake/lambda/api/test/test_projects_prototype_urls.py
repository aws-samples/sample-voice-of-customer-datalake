"""
Tests for read-time prototype URL minting in the projects API (issue #229).

Prototypes created before this change persisted an UNSIGNED absolute URL in
DynamoDB. Those rows still exist, and that URL now 403s against the restricted
`/prototypes/*` behavior — so the read path must overwrite it rather than trust
it. That is the regression this file exists to pin: passing the stored value
through would render a broken iframe and, worse, would keep an unauthenticated
link in circulation.
"""
from unittest.mock import patch
from urllib.parse import urlparse

import pytest

CDN = 'https://d111.cloudfront.net/prototypes'
STALE_UNSIGNED_URL = 'https://d111.cloudfront.net/prototypes/proj_1/prototype_1.html'


@pytest.fixture
def prototypes_cdn_configured(cdn_signing_configured):
    with patch.dict('os.environ', {'PROTOTYPES_CDN_URL': CDN}):
        yield


class TestWithSignedPrototypeUrl:
    def test_overwrites_a_stale_unsigned_url(self, prototypes_cdn_configured):
        from api.projects import _with_signed_prototype_url

        item = _with_signed_prototype_url(
            {
                'document_type': 'prototype',
                'document_id': 'prototype_1',
                'prototype_url': STALE_UNSIGNED_URL,
            },
            'proj_1',
        )

        assert item['prototype_url'] != STALE_UNSIGNED_URL
        assert item['prototype_url'].startswith(f'{STALE_UNSIGNED_URL}?')
        assert 'Signature=' in item['prototype_url']

    def test_mints_a_url_for_a_row_that_never_had_one(self, prototypes_cdn_configured):
        """New prototypes persist no prototype_url at all — the URL is derived
        from the ids."""
        from api.projects import _with_signed_prototype_url

        item = _with_signed_prototype_url(
            {'document_type': 'prototype', 'document_id': 'prototype_7'},
            'proj_7',
        )

        assert urlparse(item['prototype_url']).path == '/prototypes/proj_7/prototype_7.html'

    def test_drops_the_stale_url_when_signing_is_unavailable(self, cdn_signing_configured):
        """With no CDN configured we cannot sign, so the stale unsigned URL must
        be REMOVED, not left behind. The frontend treats a missing
        prototype_url as "fall back to legacy inline content", which degrades
        cleanly; leaving the old value would emit a dead, unauthenticated link.
        """
        from api.projects import _with_signed_prototype_url

        with patch.dict('os.environ', {'PROTOTYPES_CDN_URL': ''}):
            item = _with_signed_prototype_url(
                {
                    'document_type': 'prototype',
                    'document_id': 'prototype_1',
                    'prototype_url': STALE_UNSIGNED_URL,
                },
                'proj_1',
            )

        assert 'prototype_url' not in item

    def test_leaves_non_prototype_documents_untouched(self, prototypes_cdn_configured):
        from api.projects import _with_signed_prototype_url

        prd = {'document_type': 'prd', 'document_id': 'prd_1', 'content': 'body'}

        assert _with_signed_prototype_url(dict(prd), 'proj_1') == prd

    def test_leaves_a_prototype_without_a_document_id_untouched(self, prototypes_cdn_configured):
        from api.projects import _with_signed_prototype_url

        item = _with_signed_prototype_url({'document_type': 'prototype'}, 'proj_1')

        assert 'prototype_url' not in item
