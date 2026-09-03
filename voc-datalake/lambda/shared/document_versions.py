"""Stable version identities and titles for managed project documents.

Managed documents may be generated repeatedly with the same user-supplied title.
Their version is therefore a stored identity, not a frontend position derived from
whatever documents still exist.  This module owns both sides of that contract:

* legacy rows are deterministically assigned versions for reads and bootstrap;
* new rows atomically commit the series counter, document, and project count.

Version counters live in a separate partition in the projects table so they do
not consume the bounded project-document queries used by generation and scoring.
"""

from __future__ import annotations

import hashlib
import re
import time
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.exceptions import ServiceError, ValidationError
from shared.logging import logger
from shared.project_writes import (
    PROJECT_WRITABLE_ATTRIBUTE_NAMES,
    PROJECT_WRITABLE_ATTRIBUTE_VALUES,
    PROJECT_WRITABLE_CONDITION,
    is_project_tombstone,
)
from shared.project_writes import project_meta_key as _project_meta_key
from shared.project_writes import (
    project_writable_condition as _project_writable_condition,
)

VERSIONED_DOCUMENT_TYPES = frozenset({'prd', 'prfaq', 'prototype', 'research'})

#: Sort-key prefix that identifies each managed type on a legacy row that never
#: stored ``document_type``. Single-sourced here so a new managed type cannot be
#: recognised by one half of the contract and not the other.
MANAGED_SORT_KEY_PREFIXES: dict[str, str] = {
    'PRD#': 'prd',
    'PRFAQ#': 'prfaq',
    'PROTOTYPE#': 'prototype',
    'RESEARCH#': 'research',
}
VERSION_COUNTER_PREFIX = 'DOCUMENT_VERSIONS#PROJECT#'
LEGACY_ASSIGNMENT_PREFIX = 'LEGACY_ASSIGNMENT#'
ALLOCATION_PREFIX = 'ALLOCATION#'
VERSION_SUFFIX_RE = re.compile(r'\s+\(v([1-9]\d*)\)$', re.IGNORECASE)
VERSION_WRITE_ATTEMPTS = 4
VERSION_WRITE_BACKOFF_SECONDS = 0.025
LEGACY_MIGRATION_LEASE_SECONDS = 5
LEGACY_MIGRATION_WAIT_SECONDS = 15
LEGACY_MIGRATION_POLL_MAX_SECONDS = 0.25

_TRANSIENT_TRANSACTION_REASONS = frozenset({
    'TransactionConflict',
    'ThrottlingError',
    'ProvisionedThroughputExceeded',
})
_PERMANENT_TRANSACTION_REASONS = frozenset({
    'ConditionalCheckFailed',
    'ItemCollectionSizeLimitExceeded',
    'ValidationError',
})
_TRANSIENT_ERROR_CODES = frozenset({
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'TransactionConflictException',
})


def version_partition_key(project_id: str) -> str:
    """Partition containing only *project_id*'s document-version counters."""
    return f'{VERSION_COUNTER_PREFIX}{project_id}'


def _project_accepts_writes(table, project_id: str) -> bool:
    meta = _get_item(table, _project_meta_key(project_id))
    return bool(meta) and not is_project_tombstone(meta)


def split_versioned_title(title: object) -> tuple[str, int | None]:
    """Return a clean base title and an optional terminal ``(vN)`` suffix.

    User input may include a suffix copied from a displayed title.  New writes
    ignore that requested number and allocate the next one; legacy reads use it
    as historical evidence.  Internal ``v2`` text is never stripped.
    """
    if not isinstance(title, str):
        raise ValidationError('Document title must be a string')
    clean = ' '.join(unicodedata.normalize('NFKC', title).split())
    match = VERSION_SUFFIX_RE.search(clean)
    version = int(match.group(1)) if match else None
    base_title = clean[:match.start()].rstrip() if match else clean
    if not base_title:
        raise ValidationError('Document title is required')
    return base_title, version


def normalized_base_title(title: object) -> str:
    """Stable series key for a base or already-versioned title."""
    base_title, _ = split_versioned_title(title)
    return base_title.casefold()


def canonical_document_title(base_title: str, version: int) -> str:
    """The one display title every surface consumes, including version one."""
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError('Document version must be a positive integer')
    clean_base, _ = split_versioned_title(base_title)
    return f'{clean_base} (v{version})'


#: How much of a research question a generated fallback title may quote.
RESEARCH_TITLE_QUESTION_CHARS = 50


def research_base_title(requested_title: object, question: object) -> str:
    """The series title a research report belongs to.

    Both live research writers (the Step Functions save step and the synchronous
    fallback) must derive the SAME base title from the same request, or one
    project would carry two series for one question and the ``(vN)`` numbering
    would restart. Kept here beside :func:`split_versioned_title` because the
    result is a version-series key, not display text.

    Stripped, so the value this returns is already the key it claims to be.
    ``'Churn drivers '`` and ``'Churn drivers'`` do in fact land in one series
    today — :func:`persist_versioned_document` runs both through
    :func:`split_versioned_title`, which collapses interior whitespace and trims —
    but that makes the guarantee a property of the caller rather than of this
    return value, and a reader who takes the docstring at its word would be wrong.
    The question fallback needs no strip: it is composed from a slice of an
    already-non-blank string behind a literal prefix.
    """
    if isinstance(requested_title, str) and requested_title.strip():
        return requested_title.strip()
    text = question if isinstance(question, str) and question.strip() else 'Research'
    return f'Research: {text[:RESEARCH_TITLE_QUESTION_CHARS]}'


def managed_document_type(document: dict[str, Any]) -> str | None:
    """The managed type this stored row belongs to, or ``None``.

    The one predicate every caller shares, so widening
    :data:`VERSIONED_DOCUMENT_TYPES` cannot leave a route treating a managed row
    as an unmanaged one. Reads ``document_type`` first and falls back to the sort
    key for legacy rows that never stored it.
    """
    return _managed_document_type(document)


def normalize_document_versions(documents: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return document copies with deterministic managed version metadata.

    Persisted versions win.  Unique legacy ``(vN)`` suffixes are reserved next;
    remaining rows receive the lowest unused positive versions in stable
    ``created_at``/``document_id``/``sk`` order.  Input order is preserved.
    """
    output = [dict(document) for document in documents]
    groups: dict[tuple[str, str], list[_VersionCandidate]] = {}

    for index, document in enumerate(output):
        document_type = _managed_document_type(document)
        if document_type is None:
            continue
        raw_base = document.get('base_title') or document.get('title') or 'Untitled'
        try:
            base_title, suffix_version = split_versioned_title(raw_base)
        except ValidationError:
            base_title, suffix_version = 'Untitled', None
        normalized = normalized_base_title(base_title)
        persisted_version = _positive_int(document.get('version'))
        candidate = _VersionCandidate(
            index=index,
            base_title=base_title,
            normalized_base=normalized,
            claimed_version=persisted_version or suffix_version,
            rank=(
                str(document.get('created_at') or ''),
                str(document.get('document_id') or ''),
                str(document.get('sk') or ''),
            ),
        )
        groups.setdefault((document_type, normalized), []).append(candidate)

    for candidates in groups.values():
        ordered = sorted(candidates, key=lambda candidate: candidate.rank)
        display_base = ordered[0].base_title
        used: set[int] = set()
        assigned: dict[int, int] = {}

        for candidate in ordered:
            claim = candidate.claimed_version
            if claim is not None and claim not in used:
                assigned[candidate.index] = claim
                used.add(claim)

        next_free = 1
        for candidate in ordered:
            if candidate.index in assigned:
                continue
            while next_free in used:
                next_free += 1
            assigned[candidate.index] = next_free
            used.add(next_free)

        for candidate in candidates:
            version = assigned[candidate.index]
            output[candidate.index].update({
                'base_title': display_base,
                'version': version,
                'title': canonical_document_title(display_base, version),
            })

    return output


def persist_legacy_document_versions(
    table,
    project_id: str,
    documents: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Persist deterministic identity for legacy managed documents once.

    A short per-series lease serializes concurrent migrations.  Assignment rows
    are written before document rows, so a retry after partial failure recovers
    the same version even if an older sibling was deleted in the meantime.
    The series counter is raised before any canonical document is exposed.
    """
    source = [dict(document) for document in documents]
    output = normalize_document_versions(source)
    groups: dict[tuple[str, str], list[int]] = {}

    for index, document in enumerate(source):
        document_type = _managed_document_type(document)
        if document_type is None:
            continue
        raw_base = document.get('base_title') or document.get('title') or 'Untitled'
        try:
            normalized = normalized_base_title(raw_base)
        except ValidationError:
            normalized = normalized_base_title('Untitled')
        groups.setdefault((document_type, normalized), []).append(index)

    for (document_type, normalized), indices in groups.items():
        originals = [source[index] for index in indices]
        if not any(_requires_legacy_persistence(document) for document in originals):
            continue
        planned = _persist_legacy_series(
            table, project_id, document_type, normalized, originals,
        )
        for index, document in zip(indices, planned, strict=True):
            output[index] = document

    return output


def _persist_legacy_series(
    table,
    project_id: str,
    document_type: str,
    normalized: str,
    documents: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    counter_key = _counter_key(project_id, document_type, normalized)
    assignments = _query_legacy_assignments(table, counter_key)
    counter = _get_item(table, counter_key)
    counter_floor = _positive_int(counter.get('last_version')) or 0
    planned = _plan_legacy_series(
        documents, assignments, counter.get('base_title'), counter_floor,
    )
    high_water = max(_positive_int(document.get('version')) or 0 for document in planned)
    owner = uuid4().hex

    acquired_floor = _acquire_legacy_migration(
        table,
        project_id,
        counter_key,
        document_type,
        normalized,
        str(planned[0]['base_title']),
        high_water,
        owner,
    )
    try:
        # A previous worker may have completed assignments while this worker
        # waited for the lease. Re-plan from those durable claims before writes.
        assignments = _query_legacy_assignments(table, counter_key)
        counter = _get_item(table, counter_key)
        planned = _plan_legacy_series(
            documents, assignments, counter.get('base_title'), acquired_floor,
        )
        high_water = max(_positive_int(document.get('version')) or 0 for document in planned)
        _raise_locked_high_water(table, counter_key, high_water, owner)

        assignment_by_document = {
            str(item.get('source_document_sk') or ''): item
            for item in assignments
        }
        for original, canonical in zip(documents, planned, strict=True):
            identity = str(original.get('sk') or '')
            if not identity:
                raise ServiceError('Legacy managed document has no sort key')
            existing = assignment_by_document.get(identity)
            if (
                existing is not None
                and _positive_int(existing.get('version')) != canonical['version']
            ):
                raise ServiceError('Conflicting legacy document version assignment')
            _persist_legacy_identity(
                table,
                project_id,
                counter_key,
                document_type,
                normalized,
                owner,
                original,
                canonical,
                existing,
            )
        return planned
    finally:
        _release_legacy_migration(table, counter_key, owner)


def _plan_legacy_series(
    documents: list[dict[str, Any]],
    assignments: list[dict[str, Any]],
    counter_base: object,
    counter_floor: int,
) -> list[dict[str, Any]]:
    ordered = sorted(
        documents,
        key=lambda document: (
            str(document.get('created_at') or ''),
            str(document.get('document_id') or ''),
            str(document.get('sk') or ''),
        ),
    )
    first_base = ordered[0].get('base_title') or ordered[0].get('title') or 'Untitled'
    try:
        display_base, _ = split_versioned_title(counter_base or first_base)
    except ValidationError:
        display_base = 'Untitled'

    historical: dict[str, int] = {}
    used_by: dict[int, str] = {}
    for assignment in assignments:
        identity = str(assignment.get('source_document_sk') or '')
        version = _positive_int(assignment.get('version'))
        if not identity or version is None:
            continue
        claimed_by = used_by.get(version)
        if claimed_by is not None and claimed_by != identity:
            raise ServiceError('Duplicate persisted legacy document versions detected')
        historical[identity] = version
        used_by[version] = identity

    assigned: dict[str, int] = {}
    for document in ordered:
        identity = str(document.get('sk') or '')
        mapped = historical.get(identity)
        persisted = _positive_int(document.get('version'))
        if mapped is not None:
            if persisted is not None and persisted != mapped:
                raise ServiceError('Legacy document version conflicts with its assignment')
            assigned[identity] = mapped
            continue
        if persisted is None:
            continue
        claimed_by = used_by.get(persisted)
        if claimed_by is not None and claimed_by != identity:
            raise ServiceError('Duplicate persisted document versions detected')
        assigned[identity] = persisted
        used_by[persisted] = identity

    for document in ordered:
        identity = str(document.get('sk') or '')
        if identity in assigned:
            continue
        raw_title = document.get('title') or document.get('base_title') or 'Untitled'
        try:
            _, suffix_version = split_versioned_title(raw_title)
        except ValidationError:
            suffix_version = None
        if (
            suffix_version is not None
            and suffix_version > counter_floor
            and suffix_version not in used_by
        ):
            assigned[identity] = suffix_version
            used_by[suffix_version] = identity

    next_free = counter_floor + 1
    for document in ordered:
        identity = str(document.get('sk') or '')
        if identity in assigned:
            continue
        while next_free in used_by:
            next_free += 1
        assigned[identity] = next_free
        used_by[next_free] = identity

    planned = []
    for document in documents:
        canonical = dict(document)
        version = assigned[str(document.get('sk') or '')]
        canonical.update({
            'base_title': display_base,
            'version': version,
            'title': canonical_document_title(display_base, version),
        })
        planned.append(canonical)
    return planned


def _requires_legacy_persistence(document: dict[str, Any]) -> bool:
    version = _positive_int(document.get('version'))
    base_title = document.get('base_title')
    if version is None or not isinstance(base_title, str) or not base_title.strip():
        return True
    try:
        return document.get('title') != canonical_document_title(base_title, version)
    except ValidationError:
        return True


def _legacy_assignment_prefix(counter_key: dict[str, str]) -> str:
    return f"{LEGACY_ASSIGNMENT_PREFIX}{counter_key['sk']}#"


def _legacy_assignment_key(
    counter_key: dict[str, str], source_document_sk: str,
) -> dict[str, str]:
    identity_digest = hashlib.sha256(source_document_sk.encode()).hexdigest()
    return {
        'pk': counter_key['pk'],
        'sk': f'{_legacy_assignment_prefix(counter_key)}{identity_digest}',
    }


def _query_legacy_assignments(
    table, counter_key: dict[str, str],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    query: dict[str, Any] = {
        'KeyConditionExpression': (
            Key('pk').eq(counter_key['pk'])
            & Key('sk').begins_with(_legacy_assignment_prefix(counter_key))
        ),
        'ConsistentRead': True,
    }
    while True:
        response = table.query(**query)
        if not isinstance(response, dict):
            return items
        page_items = response.get('Items')
        if isinstance(page_items, list):
            items.extend(item for item in page_items if isinstance(item, dict))
        cursor = response.get('LastEvaluatedKey')
        if not isinstance(cursor, dict) or not cursor:
            return items
        query['ExclusiveStartKey'] = cursor


def _migration_backoff_seconds(attempt: int) -> float:
    return min(
        VERSION_WRITE_BACKOFF_SECONDS * (2 ** min(attempt, 4)),
        LEGACY_MIGRATION_POLL_MAX_SECONDS,
    )


def _legacy_migration_active(counter: dict[str, Any]) -> bool:
    owner = counter.get('migration_owner')
    expires_at = counter.get('migration_expires_at')
    return (
        isinstance(owner, str)
        and bool(owner)
        and isinstance(expires_at, (int, Decimal))
        and not isinstance(expires_at, bool)
        and int(expires_at) >= int(time.time())
    )


def _wait_for_legacy_migration(
    table, counter_key: dict[str, str],
) -> dict[str, Any]:
    deadline = time.monotonic() + LEGACY_MIGRATION_WAIT_SECONDS
    attempt = 0
    while True:
        counter = _get_item(table, counter_key)
        if not _legacy_migration_active(counter):
            return counter
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ServiceError(
                'Document versions are being initialized. Please retry.'
            )
        time.sleep(min(_migration_backoff_seconds(attempt), remaining))
        attempt += 1


def _acquire_legacy_migration(
    table,
    project_id: str,
    counter_key: dict[str, str],
    document_type: str,
    normalized: str,
    display_base: str,
    high_water: int,
    owner: str,
) -> int:
    table_name = getattr(table, 'name', None)
    if not isinstance(table_name, str) or not table_name:
        raise ValueError('Projects table name is required for legacy migration')

    deadline = time.monotonic() + LEGACY_MIGRATION_WAIT_SECONDS
    attempt = 0
    while True:
        try:
            counter = _get_item(table, counter_key)
            now_epoch = int(time.time())
            expires_at = now_epoch + LEGACY_MIGRATION_LEASE_SECONDS
            now = datetime.now(timezone.utc).isoformat()
            observed = _positive_int(counter.get('last_version')) if counter else None
            stored_normalized = counter.get('normalized_base_title') if counter else None
            if stored_normalized not in (None, normalized):
                raise ServiceError('Document version counter title mismatch')

            if not counter:
                counter_write = {
                    'Put': {
                        'TableName': table_name,
                        'Item': {
                            **counter_key,
                            'document_type': document_type,
                            'base_title': display_base,
                            'normalized_base_title': normalized,
                            'last_version': high_water,
                            'migration_owner': owner,
                            'migration_expires_at': expires_at,
                            'updated_at': now,
                        },
                        'ConditionExpression': (
                            'attribute_not_exists(pk) AND attribute_not_exists(sk)'
                        ),
                    },
                }
            else:
                expression_values: dict[str, Any] = {
                    ':last': max(observed or 0, high_water),
                    ':base': str(counter.get('base_title') or display_base),
                    ':normalized': normalized,
                    ':owner': owner,
                    ':expires': expires_at,
                    ':now_epoch': now_epoch,
                    ':now': now,
                }
                last_condition = 'attribute_not_exists(#last)'
                if observed is not None:
                    last_condition = '#last = :observed'
                    expression_values[':observed'] = observed
                counter_write = {
                    'Update': {
                        'TableName': table_name,
                        'Key': counter_key,
                        'UpdateExpression': (
                            'SET #last = :last, base_title = :base, '
                            'normalized_base_title = :normalized, #owner = :owner, '
                            '#expires = :expires, updated_at = :now'
                        ),
                        'ConditionExpression': (
                            f'{last_condition} AND '
                            '(attribute_not_exists(#owner) OR '
                            'attribute_not_exists(#expires) OR #expires < :now_epoch)'
                        ),
                        'ExpressionAttributeNames': {
                            '#last': 'last_version',
                            '#owner': 'migration_owner',
                            '#expires': 'migration_expires_at',
                        },
                        'ExpressionAttributeValues': expression_values,
                    },
                }

            table.meta.client.transact_write_items(TransactItems=[
                _project_writable_condition(table_name, project_id),
                counter_write,
            ])
            return observed or 0
        except ClientError as error:
            code = error.response.get('Error', {}).get('Code')
            if code == 'TransactionCanceledException' and not _project_accepts_writes(
                table, project_id,
            ):
                raise ServiceError(
                    'Project deletion has started; document versions cannot change.'
                ) from error
            retryable = (
                _conditional_failure(error)
                or code == 'TransactionCanceledException'
                or _transient(error)
            )
            if not retryable:
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ServiceError(
                    'Document versions are being initialized. Please retry.'
                ) from error
            time.sleep(min(_migration_backoff_seconds(attempt), remaining))
            attempt += 1


def _raise_locked_high_water(
    table, counter_key: dict[str, str], high_water: int, owner: str,
) -> None:
    for attempt in range(VERSION_WRITE_ATTEMPTS):
        try:
            counter = _get_item(table, counter_key)
            observed = _positive_int(counter.get('last_version')) or 0
            now_epoch = int(time.time())
            if (
                counter.get('migration_owner') != owner
                or int(counter.get('migration_expires_at') or 0) < now_epoch
            ):
                raise ServiceError(
                    'Document version migration lease was lost. Please retry.'
                )
            if observed >= high_water:
                return
            table.update_item(
                Key=counter_key,
                UpdateExpression='SET #last = :last, updated_at = :now',
                ConditionExpression=(
                    '#owner = :owner AND #expires >= :now_epoch '
                    'AND #last = :observed'
                ),
                ExpressionAttributeNames={
                    '#last': 'last_version',
                    '#owner': 'migration_owner',
                    '#expires': 'migration_expires_at',
                },
                ExpressionAttributeValues={
                    ':last': high_water,
                    ':observed': observed,
                    ':owner': owner,
                    ':now_epoch': now_epoch,
                    ':now': datetime.now(timezone.utc).isoformat(),
                },
            )
            return
        except ClientError as error:
            retryable = _conditional_failure(error) or _transient(error)
            if retryable and attempt + 1 < VERSION_WRITE_ATTEMPTS:
                time.sleep(_migration_backoff_seconds(attempt))
                continue
            if retryable:
                raise ServiceError(
                    'Could not reserve legacy document versions. Please retry.'
                ) from error
            raise


def _renew_legacy_migration(
    table, counter_key: dict[str, str], owner: str,
) -> None:
    for attempt in range(VERSION_WRITE_ATTEMPTS):
        now_epoch = int(time.time())
        try:
            table.update_item(
                Key=counter_key,
                UpdateExpression='SET #expires = :expires, updated_at = :now',
                ConditionExpression='#owner = :owner AND #expires >= :now_epoch',
                ExpressionAttributeNames={
                    '#owner': 'migration_owner',
                    '#expires': 'migration_expires_at',
                },
                ExpressionAttributeValues={
                    ':owner': owner,
                    ':now_epoch': now_epoch,
                    ':expires': now_epoch + LEGACY_MIGRATION_LEASE_SECONDS,
                    ':now': datetime.now(timezone.utc).isoformat(),
                },
            )
            return
        except ClientError as error:
            if _conditional_failure(error):
                raise ServiceError(
                    'Document version migration lease was lost. Please retry.'
                ) from error
            transient = _transient(error)
            if transient and attempt + 1 < VERSION_WRITE_ATTEMPTS:
                time.sleep(_migration_backoff_seconds(attempt))
                continue
            if transient:
                raise ServiceError(
                    'Could not renew document version migration. Please retry.'
                ) from error
            raise


def _legacy_assignment_item(
    counter_key: dict[str, str],
    document_type: str,
    normalized: str,
    original: dict[str, Any],
    canonical: dict[str, Any],
) -> dict[str, Any]:
    source_sk = str(original.get('sk') or '')
    return {
        **_legacy_assignment_key(counter_key, source_sk),
        'source_document_sk': source_sk,
        'document_id': str(original.get('document_id') or ''),
        'document_type': document_type,
        'normalized_base_title': normalized,
        'base_title': canonical['base_title'],
        'version': canonical['version'],
        'title': canonical['title'],
    }


def _legacy_document_update(
    table_name: str,
    original: dict[str, Any],
    canonical: dict[str, Any],
) -> dict[str, Any] | None:
    expected = {
        'base_title': canonical['base_title'],
        'version': canonical['version'],
        'title': canonical['title'],
    }
    if all(original.get(key) == value for key, value in expected.items()):
        return None

    names = {
        '#base': 'base_title',
        '#version': 'version',
        '#title': 'title',
    }
    values: dict[str, Any] = {
        ':base': expected['base_title'],
        ':version': expected['version'],
        ':title': expected['title'],
    }
    conditions = ['attribute_exists(pk)', 'attribute_exists(sk)']
    for alias, attribute in (
        ('#base', 'base_title'), ('#version', 'version'), ('#title', 'title'),
    ):
        if attribute in original:
            observed_key = f':observed_{attribute}'
            conditions.append(f'{alias} = {observed_key}')
            values[observed_key] = original[attribute]
        else:
            conditions.append(f'attribute_not_exists({alias})')

    return {
        'Update': {
            'TableName': table_name,
            'Key': {'pk': original['pk'], 'sk': original['sk']},
            'UpdateExpression': 'SET #base = :base, #version = :version, #title = :title',
            'ConditionExpression': ' AND '.join(conditions),
            'ExpressionAttributeNames': names,
            'ExpressionAttributeValues': values,
        },
    }


def _persist_legacy_identity(
    table,
    project_id: str,
    counter_key: dict[str, str],
    document_type: str,
    normalized: str,
    owner: str,
    original: dict[str, Any],
    canonical: dict[str, Any],
    existing_assignment: dict[str, Any] | None,
) -> None:
    table_name = getattr(table, 'name', None)
    if not isinstance(table_name, str) or not table_name:
        raise ValueError('Projects table name is required for legacy migration')

    assignment_required = (
        not original.get('version_allocation_id') and existing_assignment is None
    )
    document_update = _legacy_document_update(table_name, original, canonical)
    if not assignment_required and document_update is None:
        return

    _renew_legacy_migration(table, counter_key, owner)
    now_epoch = int(time.time())
    transaction: list[dict[str, Any]] = [
        _project_writable_condition(table_name, project_id),
        {
            'ConditionCheck': {
                'TableName': table_name,
                'Key': counter_key,
                'ConditionExpression': '#owner = :owner AND #expires >= :now_epoch',
                'ExpressionAttributeNames': {
                    '#owner': 'migration_owner',
                    '#expires': 'migration_expires_at',
                },
                'ExpressionAttributeValues': {
                    ':owner': owner,
                    ':now_epoch': now_epoch,
                },
            },
        },
    ]
    if assignment_required:
        transaction.append({
            'Put': {
                'TableName': table_name,
                'Item': _legacy_assignment_item(
                    counter_key, document_type, normalized, original, canonical,
                ),
                'ConditionExpression': (
                    'attribute_not_exists(pk) AND attribute_not_exists(sk)'
                ),
            },
        })
    if document_update is not None:
        transaction.append(document_update)

    for attempt in range(VERSION_WRITE_ATTEMPTS):
        try:
            table.meta.client.transact_write_items(TransactItems=transaction)
            return
        except ClientError as error:
            source_key = {'pk': original['pk'], 'sk': original['sk']}
            current = _get_item(table, source_key)
            if not current:
                return
            identity_matches = all(
                current.get(key) == canonical[key]
                for key in ('base_title', 'version', 'title')
            )
            assignment_matches = not assignment_required
            if assignment_required:
                assignment = _get_item(
                    table,
                    _legacy_assignment_key(
                        counter_key, str(original.get('sk') or '')
                    ),
                )
                assignment_matches = (
                    assignment.get('source_document_sk') == original.get('sk')
                    and _positive_int(assignment.get('version')) == canonical['version']
                )
            if identity_matches and assignment_matches:
                return
            transient = _transient(error)
            if transient and attempt + 1 < VERSION_WRITE_ATTEMPTS:
                time.sleep(_migration_backoff_seconds(attempt))
                continue
            if transient:
                raise ServiceError(
                    'Could not persist legacy document versions. Please retry.'
                ) from error
            if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
                raise ServiceError(
                    'Legacy document changed or its migration lease was lost. '
                    'Please retry.'
                ) from error
            raise


def _release_legacy_migration(
    table, counter_key: dict[str, str], owner: str,
) -> None:
    try:
        table.update_item(
            Key=counter_key,
            UpdateExpression=(
                'SET updated_at = :now REMOVE #owner, #expires'
            ),
            ConditionExpression='#owner = :owner',
            ExpressionAttributeNames={
                '#owner': 'migration_owner',
                '#expires': 'migration_expires_at',
            },
            ExpressionAttributeValues={
                ':owner': owner,
                ':now': datetime.now(timezone.utc).isoformat(),
            },
        )
    except ClientError as error:
        if _conditional_failure(error):
            return
        logger.warning(
            'Document version migration lease release failed; lease will expire',
            extra={
                'error_code': error.response.get('Error', {}).get('Code', 'Unknown'),
            },
        )


def _conditional_failure(error: ClientError) -> bool:
    return error.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException'


def versioned_document_id(
    project_id: str,
    document_type: str,
    allocation_id: str,
) -> str:
    """Return the validated deterministic id for one allocation.

    The stable allocation id is the authority for retries: every attempt for the
    same project, managed type, and allocation resolves to the same document key.
    """
    if not isinstance(project_id, str) or not project_id.strip():
        raise ValueError('A project id is required for document persistence')
    if not isinstance(document_type, str) or document_type not in VERSIONED_DOCUMENT_TYPES:
        raise ValueError(f'{document_type!r} is not a version-managed document type')
    if not isinstance(allocation_id, str) or not allocation_id.strip():
        raise ValueError('A stable document allocation id is required')

    digest = hashlib.sha256(
        f'{project_id}|{document_type}|{allocation_id}'.encode()
    ).hexdigest()[:20]
    return f'{document_type}_{digest}'


def _allocation_key(
    project_id: str,
    document_type: str,
    allocation_id: str,
) -> dict[str, str]:
    allocation_digest = hashlib.sha256(allocation_id.encode()).hexdigest()
    return {
        'pk': version_partition_key(project_id),
        'sk': f'{ALLOCATION_PREFIX}{document_type.upper()}#{allocation_digest}',
    }


def _document_key(
    project_id: str,
    document_type: str,
    allocation_id: str,
) -> dict[str, str]:
    document_id = versioned_document_id(project_id, document_type, allocation_id)
    return {
        'pk': f'PROJECT#{project_id}',
        'sk': f'{document_type.upper()}#{document_id}',
    }


def _allocation_item(
    project_id: str,
    document_type: str,
    allocation_id: str,
    document: dict[str, Any],
) -> dict[str, Any]:
    document_key = _document_key(project_id, document_type, allocation_id)
    document_id = versioned_document_id(project_id, document_type, allocation_id)
    version = _positive_int(document.get('version'))
    base_title = document.get('base_title')
    title = document.get('title')
    created_at = document.get('created_at')
    if (
        document.get('pk') != document_key['pk']
        or document.get('sk') != document_key['sk']
        or document.get('document_id') != document_id
        or version is None
        or not isinstance(base_title, str)
        or not base_title
        or not isinstance(title, str)
        or not title
        or not isinstance(created_at, str)
        or not created_at
    ):
        raise ServiceError('Stored generated document allocation is incomplete')
    return {
        **_allocation_key(project_id, document_type, allocation_id),
        'allocation_id': allocation_id,
        'document_id': document_id,
        'document_pk': document_key['pk'],
        'document_sk': document_key['sk'],
        'document_type': document_type,
        'base_title': base_title,
        'version': version,
        'title': title,
        'created_at': created_at,
    }


def _assert_allocation_reference(
    allocation: dict[str, Any],
    project_id: str,
    document_type: str,
    allocation_id: str,
) -> None:
    document_key = _document_key(project_id, document_type, allocation_id)
    expected = {
        **_allocation_key(project_id, document_type, allocation_id),
        'allocation_id': allocation_id,
        'document_id': versioned_document_id(
            project_id, document_type, allocation_id,
        ),
        'document_pk': document_key['pk'],
        'document_sk': document_key['sk'],
        'document_type': document_type,
    }
    if any(allocation.get(key) != value for key, value in expected.items()):
        raise ServiceError('Document allocation history conflict detected')


def _assert_allocation_item(
    allocation: dict[str, Any], expected: dict[str, Any],
) -> None:
    if any(allocation.get(key) != value for key, value in expected.items()):
        raise ServiceError('Document allocation history conflict detected')


def _ensure_allocation_history(
    table,
    project_id: str,
    document_type: str,
    allocation_id: str,
    document: dict[str, Any],
) -> None:
    expected = _allocation_item(
        project_id, document_type, allocation_id, document,
    )
    allocation_key = {
        'pk': expected['pk'],
        'sk': expected['sk'],
    }
    existing = _get_item(table, allocation_key)
    if existing:
        _assert_allocation_item(existing, expected)
        return

    table_name = getattr(table, 'name', None)
    if not isinstance(table_name, str) or not table_name:
        raise ValueError('Projects table name is required for allocation history')
    try:
        table.meta.client.transact_write_items(TransactItems=[
            _project_writable_condition(table_name, project_id),
            {
                'Put': {
                    'TableName': table_name,
                    'Item': expected,
                    'ConditionExpression': (
                        'attribute_not_exists(pk) AND attribute_not_exists(sk)'
                    ),
                },
            },
        ])
    except ClientError as error:
        winner = _get_item(table, allocation_key)
        if winner:
            _assert_allocation_item(winner, expected)
            return
        if not _project_accepts_writes(table, project_id):
            raise ServiceError(
                'Project deletion has started; allocation history cannot change.'
            ) from error
        code = error.response.get('Error', {}).get('Code')
        if _conditional_failure(error) or code == 'TransactionCanceledException':
            raise ServiceError(
                'Could not identify the stored document allocation history'
            ) from error
        raise


def get_versioned_document_by_allocation(
    table,
    project_id: str,
    document_type: str,
    allocation_id: str,
) -> dict[str, Any] | None:
    """Return a committed allocation and reject replay after its deletion."""
    document_key = _document_key(project_id, document_type, allocation_id)
    allocation = _get_item(
        table, _allocation_key(project_id, document_type, allocation_id),
    )
    if allocation:
        _assert_allocation_reference(
            allocation, project_id, document_type, allocation_id,
        )
        document = _existing_document(table, document_key, allocation_id)
        if document is None:
            raise ServiceError(
                'Document allocation was previously deleted and cannot be replayed'
            )
        _assert_allocation_item(
            allocation,
            _allocation_item(
                project_id, document_type, allocation_id, document,
            ),
        )
        return document

    document = _existing_document(table, document_key, allocation_id)
    if document is None:
        return None
    _ensure_allocation_history(
        table, project_id, document_type, allocation_id, document,
    )
    return document


def preserve_versioned_document_allocation(
    table,
    project_id: str,
    document: dict[str, Any],
) -> None:
    """Durably preserve a generated managed document's allocation before delete."""
    document_type = _managed_document_type(document)
    allocation_id = document.get('version_allocation_id')
    if document_type is None or not isinstance(allocation_id, str) or not allocation_id:
        raise ServiceError('Stored document has no generated allocation to preserve')

    document_key = _document_key(project_id, document_type, allocation_id)
    if (
        document.get('pk') != document_key['pk']
        or document.get('sk') != document_key['sk']
        or document.get('document_id')
        != versioned_document_id(project_id, document_type, allocation_id)
    ):
        raise ServiceError('Stored generated document allocation is inconsistent')

    current = _existing_document(table, document_key, allocation_id)
    if current is None:
        raise ServiceError(
            'Document disappeared before its allocation history was preserved'
        )
    _ensure_allocation_history(
        table, project_id, document_type, allocation_id, current,
    )


def persist_versioned_document(
    table,
    project_id: str,
    document_type: str,
    requested_title: object,
    allocation_id: str,
    item_fields: dict[str, Any],
) -> dict[str, Any]:
    """Atomically persist one version-managed document and return its item.

    ``allocation_id`` must be stable across retries (job id for generated and
    merged documents). It produces a deterministic document key, while the
    allocation record remains after deletion so delayed retries cannot recreate
    a generated document at a later version.
    """
    document_id = versioned_document_id(project_id, document_type, allocation_id)
    requested_base, _ = split_versioned_title(requested_title)
    requested_normalized = normalized_base_title(requested_base)
    table_name = getattr(table, 'name', None)
    if not isinstance(table_name, str) or not table_name:
        raise ValueError('Projects table name is required for document persistence')

    document_key = _document_key(project_id, document_type, allocation_id)
    existing = get_versioned_document_by_allocation(
        table, project_id, document_type, allocation_id,
    )
    if existing is not None:
        return existing

    counter_key = _counter_key(project_id, document_type, requested_normalized)
    # Always discover legacy managed rows before a fresh allocation. During a
    # rolling deployment, an old writer can add an unversioned sibling after the
    # counter already exists; persisting it first keeps its visible version
    # stable and advances the counter before this allocation chooses its number.
    # Replay already returned above, so committed retries avoid this full query.
    legacy_documents = _query_project_documents(table, project_id)
    if any(
        _managed_document_type(document) is not None
        and _requires_legacy_persistence(document)
        for document in legacy_documents
    ):
        persist_legacy_document_versions(table, project_id, legacy_documents)

    for attempt in range(VERSION_WRITE_ATTEMPTS):
        counter = _wait_for_legacy_migration(table, counter_key)
        observed_version = _positive_int(counter.get('last_version')) if counter else None

        if observed_version is None:
            display_base, high_water = _series_state(
                legacy_documents, document_type, requested_normalized, requested_base,
            )
            candidate_version = high_water + 1
            counter_write = {
                'Put': {
                    'TableName': table_name,
                    'Item': {
                        **counter_key,
                        'document_type': document_type,
                        'base_title': display_base,
                        'normalized_base_title': requested_normalized,
                        'last_version': candidate_version,
                        'updated_at': item_fields['created_at'],
                    },
                    'ConditionExpression': 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
                },
            }
        else:
            display_base = str(counter.get('base_title') or requested_base)
            candidate_version = observed_version + 1
            counter_write = {
                'Update': {
                    'TableName': table_name,
                    'Key': counter_key,
                    'UpdateExpression': 'SET #last = :next, updated_at = :now',
                    'ConditionExpression': (
                        '#last = :observed '
                        'AND normalized_base_title = :normalized '
                        'AND (attribute_not_exists(#owner) '
                        'OR attribute_not_exists(#expires) '
                        'OR #expires < :now_epoch)'
                    ),
                    'ExpressionAttributeNames': {
                        '#last': 'last_version',
                        '#owner': 'migration_owner',
                        '#expires': 'migration_expires_at',
                    },
                    'ExpressionAttributeValues': {
                        ':next': candidate_version,
                        ':observed': observed_version,
                        ':normalized': requested_normalized,
                        ':now_epoch': int(time.time()),
                        ':now': item_fields['created_at'],
                    },
                },
            }

        item = {
            **item_fields,
            **document_key,
            'document_id': document_id,
            'document_type': document_type,
            'base_title': display_base,
            'version': candidate_version,
            'title': canonical_document_title(display_base, candidate_version),
            'version_allocation_id': allocation_id,
        }
        allocation = _allocation_item(
            project_id, document_type, allocation_id, item,
        )
        transaction = [
            counter_write,
            {
                'Put': {
                    'TableName': table_name,
                    'Item': allocation,
                    'ConditionExpression': (
                        'attribute_not_exists(pk) AND attribute_not_exists(sk)'
                    ),
                },
            },
            {
                'Put': {
                    'TableName': table_name,
                    'Item': item,
                    'ConditionExpression': 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
                },
            },
            {
                'Update': {
                    'TableName': table_name,
                    'Key': {'pk': f'PROJECT#{project_id}', 'sk': 'META'},
                    'UpdateExpression': (
                        'SET document_count = if_not_exists(document_count, :zero) + :one, '
                        'updated_at = :now'
                    ),
                    'ConditionExpression': PROJECT_WRITABLE_CONDITION,
                    'ExpressionAttributeNames': dict(
                        PROJECT_WRITABLE_ATTRIBUTE_NAMES,
                    ),
                    'ExpressionAttributeValues': {
                        **PROJECT_WRITABLE_ATTRIBUTE_VALUES,
                        ':one': 1,
                        ':zero': 0,
                        ':now': item_fields['created_at'],
                    },
                },
            },
        ]

        try:
            table.meta.client.transact_write_items(TransactItems=transaction)
            return item
        except ClientError as error:
            replay = get_versioned_document_by_allocation(
                table, project_id, document_type, allocation_id,
            )
            if replay is not None:
                return replay
            if (
                error.response.get('Error', {}).get('Code')
                == 'TransactionCanceledException'
                and not _project_accepts_writes(table, project_id)
            ):
                raise ServiceError(
                    'Project deletion has started; documents cannot be created.'
                ) from error
            migration_active = _legacy_migration_active(
                _get_item(table, counter_key),
            )
            retryable = (
                _counter_moved(table, counter_key, observed_version)
                or migration_active
                or _transient(error)
            )
            if retryable and attempt + 1 < VERSION_WRITE_ATTEMPTS:
                time.sleep(VERSION_WRITE_BACKOFF_SECONDS * (2 ** attempt))
                continue
            if retryable:
                logger.error(
                    'Document version allocation exhausted retries',
                    extra={'project_id': project_id, 'document_type': document_type},
                )
                raise ServiceError('Could not allocate a document version. Please retry.') from error
            raise

    raise ServiceError('Could not allocate a document version. Please retry.')


@dataclass(frozen=True, slots=True)
class _VersionCandidate:
    """One managed document reduced to deterministic versioning inputs."""

    index: int
    base_title: str
    normalized_base: str
    claimed_version: int | None
    rank: tuple[str, str, str]


def _managed_document_type(document: dict[str, Any]) -> str | None:
    document_type = document.get('document_type')
    if document_type in VERSIONED_DOCUMENT_TYPES:
        return str(document_type)
    sk = str(document.get('sk') or '')
    for prefix, managed_type in MANAGED_SORT_KEY_PREFIXES.items():
        if sk.startswith(prefix):
            return managed_type
    return None


def _positive_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, Decimal):
        if value != value.to_integral_value():
            return None
        parsed = int(value)
        return parsed if parsed > 0 else None
    if isinstance(value, str) and value.isdigit():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None


def _counter_key(project_id: str, document_type: str, normalized: str) -> dict[str, str]:
    title_digest = hashlib.sha256(normalized.encode()).hexdigest()
    return {
        'pk': version_partition_key(project_id),
        'sk': f'{document_type.upper()}#{title_digest}',
    }


def _get_item(table, key: dict[str, str]) -> dict[str, Any]:
    response = table.get_item(Key=key, ConsistentRead=True)
    item = response.get('Item') if isinstance(response, dict) else None
    return item if isinstance(item, dict) else {}


def _existing_document(
    table, key: dict[str, str], allocation_id: str,
) -> dict[str, Any] | None:
    item = _get_item(table, key)
    if not item:
        return None
    if item.get('version_allocation_id') != allocation_id:
        raise ServiceError('Document id collision detected')
    return item


def _query_project_documents(table, project_id: str) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    query: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        'ConsistentRead': True,
        'ProjectionExpression': (
            'pk, sk, document_id, #type, #title, base_title, #version, created_at'
        ),
        'ExpressionAttributeNames': {
            '#type': 'document_type',
            '#title': 'title',
            '#version': 'version',
        },
    }
    while True:
        response = table.query(**query)
        if not isinstance(response, dict):
            return documents
        page_items = response.get('Items')
        if isinstance(page_items, list):
            for item in page_items:
                if isinstance(item, dict) and _managed_document_type(item) is not None:
                    documents.append(item)
        cursor = response.get('LastEvaluatedKey')
        if not isinstance(cursor, dict) or not cursor:
            return documents
        query['ExclusiveStartKey'] = cursor


def _series_state(
    documents: list[dict[str, Any]],
    document_type: str,
    normalized: str,
    fallback_base: str,
) -> tuple[str, int]:
    normalized_documents = normalize_document_versions(documents)
    matching = [
        document for document in normalized_documents
        if _managed_document_type(document) == document_type
        and normalized_base_title(document.get('base_title') or document.get('title')) == normalized
    ]
    if not matching:
        return fallback_base, 0
    display_base = str(matching[0].get('base_title') or fallback_base)
    return display_base, max(_positive_int(document.get('version')) or 0 for document in matching)


def _counter_moved(table, key: dict[str, str], observed: int | None) -> bool:
    current = _get_item(table, key)
    current_version = _positive_int(current.get('last_version')) if current else None
    return current_version != observed


def _transient(error: ClientError) -> bool:
    code = error.response.get('Error', {}).get('Code')
    if code in _TRANSIENT_ERROR_CODES:
        return True
    if code != 'TransactionCanceledException':
        return False
    reasons = error.response.get('CancellationReasons')
    if not isinstance(reasons, list):
        # Python DynamoDB responses may omit cancellation reasons. The retry
        # budget is bounded and each attempt first checks for a committed replay.
        return True
    reason_codes = {
        str(reason.get('Code'))
        for reason in reasons
        if isinstance(reason, dict) and reason.get('Code') not in (None, 'None')
    }
    if reason_codes & _PERMANENT_TRANSACTION_REASONS:
        return False
    return not reason_codes or bool(reason_codes & _TRANSIENT_TRANSACTION_REASONS)
