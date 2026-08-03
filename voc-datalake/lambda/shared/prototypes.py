"""
Shared location of the generated-prototype S3 layout and URL minting.

Two Lambdas care about the same key format and they must not drift: the
document-generator job WRITES `prototypes/{project_id}/{doc_id}.html`, and the
projects API mints a signed URL for that same key at read time. When the format
lived only in the generator, the reader had to trust a `prototype_url` string
persisted in DynamoDB; now that the URL must carry a fresh signature (issue
#229), the reader derives it instead — so the format is shared code rather than
a convention repeated in two files.
"""
import os

# `shared.cloudfront_signing` is imported LAZILY inside prototype_signed_url,
# not here. It pulls in `cryptography`, and the document-generator job imports
# this module only for `prototype_s3_key` — a writer that never signs anything.
# A module-scope import would make that job fail at COLD START if the layer
# carrying `cryptography` were ever detached, taking prototype generation down
# for a dependency it does not use. (Verified 2026-08-03 that every current
# importer does have the layer; this keeps that from being load-bearing.)


def prototype_s3_key(project_id: str, doc_id: str) -> str:
    """S3 key for a generated prototype's HTML, under the `/prototypes/*` prefix
    that the frontend distribution's cache behavior serves."""
    return f"prototypes/{project_id}/{doc_id}.html"


def prototype_signed_url(project_id: str, doc_id: str, cdn_url: str | None = None) -> str | None:
    """Signed CloudFront URL for a generated prototype, or None.

    None means the prototype cannot be shown: either PROTOTYPES_CDN_URL is not
    configured (local/mock development has no CloudFront) or signing is
    unavailable. An UNSIGNED url is never returned — `/prototypes/*` is
    restricted by a trusted key group, so it would 403, and prototype HTML is
    derived from PRDs and PR-FAQs, which is exactly the content that must not
    be reachable without a signature.
    """
    prototypes_cdn_url = cdn_url or os.environ.get('PROTOTYPES_CDN_URL', '')
    if not prototypes_cdn_url or not project_id or not doc_id:
        return None

    # Lazy on purpose — see the module docstring note about `cryptography`.
    from shared.cloudfront_signing import sign_url

    # PROTOTYPES_CDN_URL already ends in /prototypes; the cache behavior's path
    # prefix maps 1:1 onto the S3 key prefix.
    return sign_url(f"{prototypes_cdn_url.rstrip('/')}/{project_id}/{doc_id}.html")
