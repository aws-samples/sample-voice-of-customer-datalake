"""The four sections a project's documents are listed in (docs/prototype-builder.md, part 4).

A section is a pure function of ``document_type``, computed on read and never stored. The
project read (``GET /projects/{id}``: each document's ``section``), the export manifest's
per-section counts and the MCP ``projects_get`` listing all use this one table, so every
client and the bundle agree. The SPA and the stream Lambda hold the same table and order;
``shared/test/test_document_sections.py`` keeps the SPA's ``KnownProjectDocumentType`` union
and :data:`SECTION_BY_TYPE` in step.

Standard library only: the project export (``scripts/project_bundle/exporter.py``) imports it
without the Lambda layer's packages.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Final

#: The sections, in the one order every listing uses.
SECTION_ORDER: Final[tuple[str, ...]] = ('prd', 'prfaq', 'prototypes', 'documents')
#: Everything not named in :data:`SECTION_BY_TYPE`, including a type added later.
FALLBACK_SECTION: Final[str] = 'documents'
#: Every ``document_type`` the platform writes, with its section.
SECTION_BY_TYPE: Final[dict[str, str]] = {
    'prd': 'prd',
    'prfaq': 'prfaq',
    'prototype': 'prototypes',
    'research': FALLBACK_SECTION,
    'custom': FALLBACK_SECTION,
    'product_report': FALLBACK_SECTION,
    'decision': FALLBACK_SECTION,
}


#: The managed types a legacy row with no ``document_type`` is read as, by its sort key's prefix: the same
#: fallback as ``shared/document_versions.py`` ``_managed_document_type`` (the metadata backfill's).
LEGACY_TYPE_BY_SK_PREFIX: Final[tuple[tuple[str, str], ...]] = (
    ('PRD#', 'prd'),
    ('PRFAQ#', 'prfaq'),
    ('PROTOTYPE#', 'prototype'),
)


def document_section(document_type: object) -> str:
    """The section of a document of ``document_type``; a non-string or unknown type is in Documents."""
    if not isinstance(document_type, str):
        return FALLBACK_SECTION
    return SECTION_BY_TYPE.get(document_type, FALLBACK_SECTION)


def row_section(row: Mapping[str, object]) -> str:
    """The section of one document row: its ``document_type`` when that is a string, else its sort key's.

    A legacy managed row awaiting the metadata backfill has no ``document_type``; its ``PRD#``, ``PRFAQ#``
    or ``PROTOTYPE#`` sort key says what it is, as the backfill reads it. Anything else is in Documents.
    """
    document_type = row.get('document_type')
    if isinstance(document_type, str):
        return document_section(document_type)
    sk = row.get('sk')
    if isinstance(sk, str):
        for prefix, legacy_type in LEGACY_TYPE_BY_SK_PREFIX:
            if sk.startswith(prefix):
                return document_section(legacy_type)
    return FALLBACK_SECTION


def _field(row: Mapping[str, object], key: str) -> str:
    """``row[key]`` when it is a string, else '' (sorts last when reversed, first by id)."""
    value = row.get(key)
    return value if isinstance(value, str) else ''


def newest_edit_first[Row: Mapping[str, object]](rows: Iterable[Row]) -> list[Row]:
    """``rows`` last edit first (``updated_at``, else ``created_at``), ties by ``document_id``: the SPA's ``byNewestEdit``.

    The one order within a section, so the project page, the ``#document`` mentions, MCP ``projects_get`` and the
    assistant's ``get_project`` list a section alike. A row with no date sorts last.
    """
    by_id = sorted(rows, key=lambda row: _field(row, 'document_id'))
    return sorted(by_id, key=lambda row: _field(row, 'updated_at') or _field(row, 'created_at'), reverse=True)
