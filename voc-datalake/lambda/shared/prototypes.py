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
from __future__ import annotations

import os
from typing import TYPE_CHECKING

from shared.scoped_keys import scoped_object_key

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

# `shared.cloudfront_signing` is imported LAZILY inside _signed_prototype_path,
# not here. It pulls in `cryptography`, and the document-generator job imports
# this module only for `prototype_s3_key` — a writer that never signs anything.
# A module-scope import would make that job fail at COLD START if the layer
# carrying `cryptography` were ever detached, taking prototype generation down
# for a dependency it does not use. (Verified 2026-08-03 that every current
# importer does have the layer; this keeps that from being load-bearing.)


def prototype_s3_key(project_id: str, doc_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    """S3 key for a generated prototype's HTML, under the `/prototypes/*` prefix
    that the frontend distribution's cache behavior serves. In a workspace (since
    7.37.00; no caller passes one yet) the same key under `ws/{ws}/`, which that
    behavior does not serve yet: the switch (3h) decides how a workspace's
    prototype is shown."""
    return scoped_object_key(workspace, f"prototypes/{project_id}/{doc_id}.html")


def prototype_draft_s3_key(project_id: str, draft_id: str, *, workspace: WorkspaceScope | None = None) -> str:
    """S3 key of a prototype draft's HTML (docs/prototype-builder.md, part 2).

    Inside the project's own prototype prefix, so every guard on prototype objects
    (the job and projects grants, the Data Explorer deny, the project delete's sweep
    of ``prototypes/{project_id}/``) already covers it; under ``drafts/``, which the
    distribution serves with the narrower draft policy (``/prototypes/*/drafts/*``,
    lib/stacks/core-cdn.ts) and the project export skips. ``draft_id`` is the draft
    job's id, never a document id, so a draft never takes a saved version's key.
    In a workspace the same key under `ws/{ws}/`, as for ``prototype_s3_key``.
    """
    return scoped_object_key(workspace, f"prototypes/{project_id}/drafts/{draft_id}.html")


def prototype_signed_url(project_id: str, doc_id: str, cdn_url: str | None = None, *,
                         workspace: WorkspaceScope | None = None) -> str | None:
    """Signed CloudFront URL for a generated prototype, or None.

    None means the prototype cannot be shown: either PROTOTYPES_CDN_URL is not
    configured (local/mock development has no CloudFront) or signing is
    unavailable. An UNSIGNED url is never returned — `/prototypes/*` is
    restricted by a trusted key group, so it would 403, and prototype HTML is
    derived from PRDs and PR-FAQs, which is exactly the content that must not
    be reachable without a signature.

    A workspace's prototype (its key under `ws/{ws}/`, 3e) is never signed
    yet: None until the switch (3h) decides how a workspace's prototype is
    served, so no URL ever names the deployment's `/prototypes/` path for it.
    """
    if workspace is not None or not doc_id:
        return None
    return _signed_prototype_path(project_id, f'{doc_id}.html', cdn_url)


def prototype_draft_signed_url(project_id: str, draft_id: str, cdn_url: str | None = None, *,
                               workspace: WorkspaceScope | None = None) -> str | None:
    """Signed CloudFront URL of a draft (``prototype_draft_s3_key``), or None as for ``prototype_signed_url``; a
    workspace's draft is never signed yet either (None until 3h)."""
    if workspace is not None or not draft_id:
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
