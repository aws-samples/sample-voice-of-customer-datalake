"""
Shared location of the generated-prototype S3 layout and URL minting.

Two Lambdas care about the same key format and they must not drift: the
document-generator job WRITES `prototypes/{project_id}/{doc_id}.html`, and the
projects API mints a signed URL for that same key at read time. When the format
lived only in the generator, the reader had to trust a `prototype_url` string
persisted in DynamoDB; now that the URL must carry a fresh signature (issue
#229), the reader derives it instead — so the format is shared code rather than
a convention repeated in two files. A draft's key and URL (part 2 of
docs/prototype-builder.md) live here for the same reason.
"""
import os

# `shared.cloudfront_signing` is imported LAZILY inside _signed_prototype_path,
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


def prototype_draft_s3_key(project_id: str, draft_id: str) -> str:
    """S3 key of a prototype draft's HTML (docs/prototype-builder.md, part 2).

    Inside the project's own prototype prefix, so every guard on prototype objects
    (the job and projects grants, the Data Explorer deny, the project delete's sweep
    of ``prototypes/{project_id}/``) already covers it; under ``drafts/``, which the
    distribution serves with the narrower draft policy (``/prototypes/*/drafts/*``,
    lib/stacks/core-cdn.ts) and the project export skips. ``draft_id`` is the draft
    job's id, never a document id, so a draft never takes a saved version's key.
    """
    return f"prototypes/{project_id}/drafts/{draft_id}.html"


def prototype_signed_url(project_id: str, doc_id: str, cdn_url: str | None = None) -> str | None:
    """Signed CloudFront URL for a generated prototype, or None.

    None means the prototype cannot be shown: either PROTOTYPES_CDN_URL is not
    configured (local/mock development has no CloudFront) or signing is
    unavailable. An UNSIGNED url is never returned — `/prototypes/*` is
    restricted by a trusted key group, so it would 403, and prototype HTML is
    derived from PRDs and PR-FAQs, which is exactly the content that must not
    be reachable without a signature.
    """
    if not doc_id:
        return None
    return _signed_prototype_path(project_id, f'{doc_id}.html', cdn_url)


def prototype_draft_signed_url(project_id: str, draft_id: str, cdn_url: str | None = None) -> str | None:
    """Signed CloudFront URL of a draft (``prototype_draft_s3_key``), or None as for ``prototype_signed_url``."""
    if not draft_id:
        return None
    return _signed_prototype_path(project_id, f'drafts/{draft_id}.html', cdn_url)


def _signed_prototype_path(project_id: str, tail: str, cdn_url: str | None) -> str | None:
    prototypes_cdn_url = cdn_url or os.environ.get('PROTOTYPES_CDN_URL', '')
    if not prototypes_cdn_url or not project_id:
        return None

    # Lazy on purpose — see the module docstring note about `cryptography`.
    from shared.cloudfront_signing import sign_url

    # PROTOTYPES_CDN_URL already ends in /prototypes; the cache behavior's path
    # prefix maps 1:1 onto the S3 key prefix.
    return sign_url(f"{prototypes_cdn_url.rstrip('/')}/{project_id}/{tail}")
