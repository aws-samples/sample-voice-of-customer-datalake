"""Mutation hardening for `shared/prototypes.py`.

`test_prototypes.py` pins the key layout, the signed-URL shape and the
fail-closed cases, but a mutation run (11 mutants, 2 survivors) found two
things it cannot see:

* the DEFAULT when `PROTOTYPES_CDN_URL` is ABSENT from the environment. The
  earlier test set the variable to ``''``, so a mutant that changed the
  fallback from ``''`` to a non-empty string still returned None there — yet
  for every deployment that never sets the variable (local and mock
  development) it would have minted a signed URL under a garbage host
  (``XXXX/p/d.html?Expires=…``) instead of returning None.
* WHICH trailing characters the CDN base loses. ``rstrip('/')`` must strip
  every trailing slash and nothing else; a mutant that widened the strip set
  to other characters survived because every CDN base in the earlier tests
  ended in ``prototypes``.
"""
import os
from unittest.mock import patch

import pytest

from shared.prototypes import prototype_signed_url


@pytest.mark.usefixtures("cdn_signing_configured")
class TestAbsentCdnEnvFailsClosed:
    def test_unset_env_var_returns_none_even_with_signing_configured(self):
        with patch.dict('os.environ'):
            os.environ.pop('PROTOTYPES_CDN_URL', None)
            assert prototype_signed_url('p', 'd') is None

    def test_explicit_cdn_url_wins_over_an_unset_env_var(self):
        with patch.dict('os.environ'):
            os.environ.pop('PROTOTYPES_CDN_URL', None)
            url = prototype_signed_url('p', 'd', cdn_url='https://d111.cloudfront.net/prototypes')
        assert url is not None
        assert url.split('?')[0] == 'https://d111.cloudfront.net/prototypes/p/d.html'


@pytest.mark.usefixtures("cdn_signing_configured")
class TestOnlyTrailingSlashesAreStrippedFromTheCdnBase:
    @pytest.mark.parametrize(('cdn_url', 'unsigned'), [
        ('https://d111.cloudfront.net/prototypes', 'https://d111.cloudfront.net/prototypes/p/d.html'),
        ('https://d111.cloudfront.net/prototypes/', 'https://d111.cloudfront.net/prototypes/p/d.html'),
        ('https://d111.cloudfront.net/prototypes///', 'https://d111.cloudfront.net/prototypes/p/d.html'),
        # A base ending in a non-slash character keeps it: only '/' is stripped.
        ('https://d111.cloudfront.net/protoX', 'https://d111.cloudfront.net/protoX/p/d.html'),
        ('https://d111.cloudfront.net/prototypes-vX/', 'https://d111.cloudfront.net/prototypes-vX/p/d.html'),
        ('https://dXXX.cloudfront.net/prototypes.', 'https://dXXX.cloudfront.net/prototypes./p/d.html'),
    ])
    def test_url_before_the_signature(self, cdn_url, unsigned):
        url = prototype_signed_url('p', 'd', cdn_url=cdn_url)
        assert url is not None
        assert url.split('?')[0] == unsigned
