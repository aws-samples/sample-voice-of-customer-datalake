"""A new prototype version from HTML (docs/prototype-builder.md, "Version from HTML").

A prototype is HTML in S3 (``prototypes/{project_id}/{doc_id}.html``, write-once) plus
a ``PROTOTYPE#`` row of its version series (the oldest kept their HTML inline in the
row's ``content``; a version made from one is written to S3 like any other). Every way of making a version from HTML
that already exists — Back to vN today; an applied draft and a walkthrough save
later — goes through ``version_from_html`` here, so each new version gets:

* its OWN pin form and widget: the given HTML's widget (which names the form of the
  version it came from) is stripped and the widget is re-injected for the new
  document's form, which is created first. A pin left on a restored version lands on
  that version, never on the one it was copied from (the duplicate route's
  server-side copy keeps the source's widget; this never copies the object);
* the ``pin-submit-url`` metadata the prototype CSP function trusts, written only
  through ``prototype_object_metadata`` for the new document and the configured API
  base, never from a value in a request;
* a write-once object (``IfNoneMatch='*'``) at the new version's key, where a
  conditional conflict means an earlier attempt of the SAME allocation wrote it: the
  key is a pure function of the allocation id, so a retry after the row write failed
  finds its own object and finishes the row (``put_prototype_html``);
* one row through ``persist_versioned_document``, idempotent on the allocation id.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from botocore.exceptions import ClientError

from shared.aws import S3_CONDITIONAL_WRITE_CONFLICTS, is_missing_s3_object
from shared.document_history import (
    EDIT_KIND_RESTORE,
    restore_rows,
    series_base,
    validated_edit_id,
)
from shared.document_versions import (
    get_versioned_document_by_allocation,
    persist_versioned_document,
    versioned_document_id,
)
from shared.exceptions import ConfigurationError, NotFoundError, ValidationError
from shared.prototype_pins import (
    ensure_pin_form,
    inject_pin_widget,
    pin_submit_url,
    prototype_object_metadata,
    strip_pin_widget,
)
from shared.prototypes import prototype_s3_key

PROTOTYPE_TYPE = 'prototype'

# Fields of a stored prototype row that describe THAT version (its object, the job
# that built it, how it was made), never a version made from its HTML. The sources
# and lineage (source_prd_id, derivation, methodology, prototype_format) carry.
_PROTOTYPE_ROW_FIELDS = frozenset({
    'pk', 'sk', 'document_id', 'title', 'base_title', 'version', 'version_allocation_id',
    'gsi1sk', 'created_at', 'updated_at', 'content', 'prototype_url',
    'prototype_etag', 'prototype_version_id', 'job_id',
    'edit_kind', 'edited_from_id', 'edited_by', 'restored_from_id', 'restored_from_version',
    'revised_from_id', 'revision_feedback', 'revise_job_id', 'llm_metadata',
})


def put_prototype_html(s3: Any, bucket: str, project_id: str, doc_id: str, html: str,
                       api_base: str | None) -> dict[str, str]:
    """Create the write-once prototype object and return the winning S3 identity.

    A conditional conflict reads the existing winner instead of assuming the attempted
    content won: the key belongs to one allocation, so the object there is an earlier
    attempt of this same version (a replayed job, a retried request).
    """
    key = prototype_s3_key(project_id, doc_id)
    try:
        response = s3.put_object(
            Bucket=bucket, Key=key, Body=html.encode('utf-8'),
            ContentType='text/html; charset=utf-8', IfNoneMatch='*',
            Metadata=prototype_object_metadata(doc_id, html, api_base),
        )
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') not in S3_CONDITIONAL_WRITE_CONFLICTS:
            raise
        response = s3.head_object(Bucket=bucket, Key=key)
    etag = response.get('ETag')
    if not etag:
        raise RuntimeError('S3 did not identify the winning prototype object.')
    identity = {'prototype_etag': etag}
    version_id = response.get('VersionId')
    if version_id:
        identity['prototype_version_id'] = version_id
    return identity


def read_prototype_html(s3: Any, bucket: str, project_id: str, doc_id: str) -> str:
    """A stored prototype version's HTML."""
    obj = s3.get_object(Bucket=bucket, Key=prototype_s3_key(project_id, doc_id))
    return obj['Body'].read().decode('utf-8')


class PrototypeStore:
    """Where prototype versions live: the projects table, the pins table, the bucket."""

    def __init__(self, *, table: Any, pins_table: Any, s3: Any, bucket: str, api_base: str | None) -> None:
        if not bucket:
            raise ConfigurationError('Prototype storage not configured')
        self.table = table
        self.pins_table = pins_table
        self.s3 = s3
        self.bucket = bucket
        self.api_base = api_base


def version_from_html(store: PrototypeStore, project_id: str, source: Mapping[str, Any], html: str, *,
                      allocation_id: str, now: str, provenance: Mapping[str, Any]) -> dict:
    """``html`` as the next version of ``source``'s series; its row.

    A replay of an allocation that already landed returns that version and writes
    nothing. ``provenance`` (``edit_kind`` and its fields) is the caller's; the row
    keeps ``source``'s sources and lineage.
    """
    existing = get_versioned_document_by_allocation(store.table, project_id, PROTOTYPE_TYPE, allocation_id)
    if existing is not None:
        return existing
    base = series_base(dict(source))
    doc_id = versioned_document_id(project_id, PROTOTYPE_TYPE, allocation_id)
    form_id = ensure_pin_form(store.pins_table, project_id, doc_id, base)
    page = inject_pin_widget(strip_pin_widget(html), form_id, pin_submit_url(form_id, store.api_base))
    identity = put_prototype_html(store.s3, store.bucket, project_id, doc_id, page, store.api_base)
    fields = {key: value for key, value in source.items() if key not in _PROTOTYPE_ROW_FIELDS}
    fields.update({
        **identity, 'content': '', 'prototype_format': 'html',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS', 'gsi1sk': now,
        'created_at': now, 'updated_at': now, **provenance,
    })
    return persist_versioned_document(store.table, project_id, PROTOTYPE_TYPE, base, allocation_id, fields)


def _is_inline_html(row: Mapping[str, Any], content: str) -> bool:
    """Inline ``content`` that is HTML: marked so, or starting like an HTML document.

    The SPA's rule for the same rows (``looksLikeHtmlDocument`` in frontend/src/components/prototypeSpec.ts,
    read by its Back to vN through ``backTarget``), so the button is offered exactly where this accepts.
    """
    head = content.lstrip()[:200].lower()
    return row.get('prototype_format') == 'html' or head.startswith(('<!doctype html', '<html'))


def _version_html(store: PrototypeStore, project_id: str, source: Mapping[str, Any]) -> str:
    """The HTML of a stored version: its object, or the HTML the oldest prototypes kept inline in ``content``.

    The same discriminator as the read path (``_with_signed_prototype_url`` in api/projects.py): a row
    with ``content`` has no object. Inline content that is not HTML (an early JSON screen spec) is a 400;
    an object that is gone is a 404.
    """
    content = source.get('content')
    if isinstance(content, str) and content:
        if not _is_inline_html(source, content):
            raise ValidationError('This prototype is an early screen spec, not HTML, so it cannot be restored. '
                                  'Build a new prototype instead.')
        return content
    try:
        return read_prototype_html(store.s3, store.bucket, project_id, str(source['document_id']))
    except ClientError as error:
        if is_missing_s3_object(error):
            raise NotFoundError("This version's HTML is no longer stored, so it cannot be restored") from error
        raise


def restore_prototype_version(store: PrototypeStore, project_id: str, document: Mapping[str, Any],
                              version_id: str, body: Mapping[str, Any], *, now: str,
                              actor: Mapping[str, str]) -> dict:
    """Back to vN: a NEW version of the series carrying ``version_id``'s HTML.

    The prose restore's no-op check compares ``content``, which is empty on every
    S3-backed prototype row, so a prototype skips it: restoring a version whose HTML
    matches the newest writes one more version (D1 keeps it; nothing is lost).
    ``edit_id`` makes a retried request the same version.
    """
    source, latest = restore_rows(store.table, project_id, dict(document), version_id)
    allocation_id = f"restore:{version_id}:{validated_edit_id(body.get('edit_id'), version_id)}"
    html = _version_html(store, project_id, source)
    item = version_from_html(store, project_id, source, html, allocation_id=allocation_id, now=now, provenance={
        'edit_kind': EDIT_KIND_RESTORE, 'edited_from_id': latest['document_id'], 'edited_by': dict(actor),
        'restored_from_id': version_id, 'restored_from_version': source['version'],
    })
    return {'success': True, 'document': item}
