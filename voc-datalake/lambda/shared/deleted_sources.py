"""Documents that cited a deleted persona, document or product doc say so (docs/project-workspace.md).

A document records what it was written from (``shared.derivation``: ``persona_ids``,
``sources[].document_id``, ``visual_document_ids``, and the legacy ``source_documents``
/ ``source_prd_id`` / ``source_prfaq_id``). When one of those is deleted, the ids stay
in the derivation (lineage), and each citing document of the SAME project gains a
``deleted_sources`` entry ``{kind, id, deleted_at}`` (+ ``name`` for a persona: a
persona name is a fictional archetype, never personal data). The projects API returns
it with the document and the SPA shows a short notice.

Bounded: one Query of the project partition (documents only), one UpdateItem per citing
document, at most ``MAX_DELETED_SOURCES`` entries kept per document. Best effort: a
failure is logged, never raised (the delete it follows has already happened).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.derivation import DERIVATION_FIELD
from shared.dynamo_paging import iter_query
from shared.logging import logger

__all__ = ['DOCUMENT_SORT_KEY_PREFIXES', 'DeletedSource', 'mark_citing_documents']

DELETED_SOURCES_FIELD: Final = 'deleted_sources'
MAX_DELETED_SOURCES: Final = 50
_MAX_NAME_CHARS: Final = 200
#: The project-partition sort keys that hold documents (api/projects.py reads them from here).
DOCUMENT_SORT_KEY_PREFIXES: Final = ('PRD#', 'PRFAQ#', 'RESEARCH#', 'DOC#', 'PRODUCT_REPORT#', 'PROTOTYPE#')
_PROJECTION: Final = ', '.join((
    'pk', 'sk', 'document_id', DERIVATION_FIELD, DELETED_SOURCES_FIELD,
    'source_documents', 'source_prd_id', 'source_prfaq_id',
))

SourceKind = Literal['persona', 'document', 'product_doc']


@dataclass(frozen=True)
class DeletedSource:
    """One deleted artifact a document may cite; ``name`` only for a persona."""

    kind: SourceKind
    id: str
    name: str | None = None

    def entry(self, deleted_at: str) -> dict[str, str]:
        entry = {'kind': self.kind, 'id': self.id, 'deleted_at': deleted_at}
        if self.kind == 'persona' and self.name:
            entry['name'] = self.name[:_MAX_NAME_CHARS]
        return entry


def _ids(value: object) -> set[str]:
    if isinstance(value, str):
        return {value} if value else set()
    if isinstance(value, Iterable) and not isinstance(value, Mapping):
        return {v for v in value if isinstance(v, str) and v}
    return set()


def _cited_document_ids(item: Mapping[str, Any], derivation: Mapping[str, Any]) -> set[str]:
    sources = derivation.get('sources')
    cited = {
        source['document_id'] for source in sources if isinstance(source, Mapping)
        and isinstance(source.get('document_id'), str)
    } if isinstance(sources, list) else set()
    for legacy in ('source_documents', 'source_prd_id', 'source_prfaq_id'):
        cited |= _ids(item.get(legacy))
    return cited


def _cited_ids(item: Mapping[str, Any], kind: SourceKind) -> set[str]:
    """The ids of ``kind`` a stored document cites."""
    raw = item.get(DERIVATION_FIELD)
    derivation: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
    if kind == 'persona':
        return _ids(derivation.get('persona_ids'))
    if kind == 'product_doc':
        return _ids(derivation.get('visual_document_ids'))
    return _cited_document_ids(item, derivation)


def _already(existing: object) -> list[dict[str, Any]]:
    return [dict(e) for e in existing if isinstance(e, Mapping)] if isinstance(existing, list) else []


def _merged(existing: list[dict[str, Any]], new: list[dict[str, str]]) -> list[dict[str, Any]]:
    """``existing`` plus the new entries it does not hold yet (by kind + id), newest ``MAX_DELETED_SOURCES``."""
    seen = {(e.get('kind'), e.get('id')) for e in existing}
    merged = existing + [e for e in new if (e['kind'], e['id']) not in seen]
    return merged[-MAX_DELETED_SOURCES:]


def _mark(table: Any, item: Mapping[str, Any], entries: list[dict[str, str]]) -> bool:
    existing = _already(item.get(DELETED_SOURCES_FIELD))
    merged = _merged(existing, entries)
    if merged == existing:
        return False
    try:
        table.update_item(
            Key={'pk': item['pk'], 'sk': item['sk']},
            UpdateExpression='SET #deleted = :deleted',
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeNames={'#deleted': DELETED_SOURCES_FIELD},
            ExpressionAttributeValues={':deleted': merged},
        )
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False  # the document itself was deleted meanwhile
        raise
    return True


def _documents(table: Any, project_id: str) -> Iterable[Mapping[str, Any]]:
    query: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        'ProjectionExpression': _PROJECTION,
    }
    for item in iter_query(table, query):
        sk = item.get('sk')
        if isinstance(sk, str) and sk.startswith(DOCUMENT_SORT_KEY_PREFIXES):
            yield item


def mark_citing_documents(
    table: Any, project_id: str, deleted: Sequence[DeletedSource], *, deleted_at: str,
) -> int:
    """Mark every document of the project that cites one of ``deleted``; how many were marked."""
    if not deleted or table is None:
        return 0
    marked = 0
    try:
        for item in _documents(table, project_id):
            entries = [s.entry(deleted_at) for s in deleted
                       if s.id in _cited_ids(item, s.kind) and s.id != item.get('document_id')]
            if entries and _mark(table, item, entries):
                marked += 1
    except Exception as exc:  # noqa: BLE001 - best effort: the delete it follows has already happened
        logger.warning('Could not mark the documents that cited a deleted source',
                       extra={'project_id': project_id, 'error_type': type(exc).__name__})
    return marked
