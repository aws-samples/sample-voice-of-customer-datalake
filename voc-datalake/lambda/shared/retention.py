"""What the retention / erasure worker deletes, and how (``jobs/retention/handler.py``).

The ONLY code path in the platform that deletes customer feedback. It runs in
two opt-in modes and nothing else may call it:

- ``retention``: items of a source whose profile sets ``retention_days`` and
  whose ``date`` is older than that many days.
- ``erase``: items whose ``author`` / ``source_id`` / ``csv_row_id`` equals a
  value, or whose ``metadata.email`` / ``metadata.submitter_email`` does —
  optionally within one source. ``field = 'source'`` is the whole-source
  erasure: every item whose ``source_platform`` is the value, then every
  remaining object under ``raw/{source}/`` (``raw_source_prefix``,
  ``delete_raw_prefix_page``), so orphaned archives go too.

A whole-source erasure matches on ``source_platform``, never on the partition
key: an item's ``pk`` is ``SOURCE#{brand_name or source_platform}``
(``processor/handler.py``), so a deployment with a brand name keeps every
plugin's items in ONE brand partition, and a feedback form keeps its own
brand's. Querying ``pk = SOURCE#{source}`` would miss those items, and the
partition alone cannot tell sources apart, so the worker scans with the
``source_platform`` filter exactly like the retention mode does.

An item is removed with DeleteItem (the aggregator's stream REMOVE path moves
its counters) and its per-item raw archive is removed with it, in BOTH layouts
(``shared/raw_versions.py``): every version of the legacy object
``raw/{source}/{y}/{m}/{d}/{stem}.json`` and every object (all versions, all
delete markers) under the item's folder ``raw/{source}/{y}/{m}/{d}/{stem}/``,
whichever of the two its ``s3_raw_uri`` names. A raw object is deleted only
when it is that item's OWN archive: under ``raw/``, in the configured bucket,
outside the whole-upload archives (``csv_upload/``, ``json_upload/``, ``feedback_form/import/`` under its root),
and named after the item's ``source_id`` the way every per-item archive is
(``plugins/_shared/raw_archive``, ``shared/ingest_archive``). An API-side item
received again on a later day (a new ingest-date folder) leaves its older folder
to the whole-source erasure; a correction (CSV dataset update) writes into the
stored item's own folder, so it goes with the item. A whole-file archive shared by many items
(a CSV / JSON upload, ``csv_upload/`` / ``json_upload/``, a form import's original,
``feedback_form/import/{form_id}/{run}.{ext}``, or a paste's ``manual_import/{y}/{m}/{d}/{job_id}.json``, in either
scope: ``whole_upload_key``) is never an item's own archive. Every row of one deployment CSV / JSON upload is filed
under the one source its upload named, so a whole-source erasure deletes the file (every version,
``delete_whole_upload``), and a deployment paste file or form import original goes with that erasure's sweep of
``raw/manual_import/`` or ``raw/feedback_form/``; any other erasure or retention run leaves a whole file and lists it on its
job / audit row as a file needing review (keys only), because rewriting it without the erased rows would mean
re-parsing a CSV whose column mapping is not stored.

Every kept Silver version of a deleted item (``silver/{source}/{feedback_id}/``, the
item's earlier states, ``shared/silver_provenance.py``) goes with it, every object
version (``delete_silver_versions``); a whole-source erasure also sweeps what is left
under ``silver/{source}/`` (``silver_source_prefix``).

A workspace's items (``WS#{ws}#SOURCE#…``, docs/multi-workspace.md) are reached by an erasure by email
(``reaches_workspaces``: the deployment's erasure, made by a deployment admin, erases a person's data wherever it
is; an author, a display name, is not one person everywhere) and by a retention window (the windows are the deployment's: a workspace's profile sets none, and at ingestion
it carries the deployment's window for its source, shared/source_profiles.py ``cached_source_profile_strict``). Such an item's own copies are its workspace's: raw objects under
``ws/{ws}/raw/`` (``raw_root`` of its scope: a key under any other root is never deleted as its own) and Silver
versions under ``ws/{ws}/silver/``. A whole-source erasure, a request about the deployment's own source, leaves them,
and so does an erasure by ``author``, ``source_id`` or ``csv_row_id`` (a display name, or an id unique only within
one source account or upload).

An erasure job that NAMES a workspace (its row's ``workspace_id``, written only by the server from the request's
resolved membership, shared/erasure_scope.py) reaches that workspace's items only (``WS#{ws}#…``, with their copies
under ``ws/{ws}/``), by any field of ``WORKSPACE_ERASE_FIELDS``: inside one workspace an author, a source id and a CSV
row are that team's own values. Never the deployment's items nor another workspace's, an email included: the
workspace's admin answers for their workspace's data only (the deployment's erasure by email still reaches every
workspace). A whole-source erasure never names a workspace (its source list, lock and prefix sweep are the
deployment's).

An S3 import's original file (``{raw root}s3_import/…``, ``plugins/_shared/raw_original.py``, in either scope) is
linked from no row, so no run can tell which file an item came from: a run that deletes an S3 import's item
(``source_platform`` ``S3 - …``) lists that scope's originals folder for review when it holds any object
(``import_originals_prefix``), as it lists a whole-file upload it keeps.

The same filters and deletes reach Radar (``voc-radar``: other brands' reviews,
``STORE_RADAR``): a review, its dedupe marker and its own raw archive.

The erased value is never stored or logged: jobs and audit rows carry its
SHA-256 (``value_hash``, ``shared.digests.sha256_hex``).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Final
from urllib.parse import urlparse

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.archive_keys import archive_key_stem
from shared.logging import logger
from shared.radar_store import marker_key
from shared.raw_versions import RAW_PREFIX, ItemArchive, parse_item_key, raw_root
from shared.silver_provenance import SILVER_PREFIX, silver_item_prefix
from shared.ws_repo import WORKSPACE_KEY_PREFIX, WorkspaceScope, partition_scope, ws_table

__all__ = [
    'ERASURE_JOB_COUNTERS',
    'FEEDBACK_SK_PREFIX',
    'STORE_FEEDBACK',
    'STORE_RADAR',
    'UNKNOWN_SOURCE',
    'delete_item',
    'delete_radar_item',
    'delete_raw_prefix_page',
    'delete_whole_upload',
    'erase_filter',
    'erase_matches',
    'holds_files',
    'import_originals_prefix',
    'is_deletable_upload',
    'item_feedback_id',
    'item_scope',
    'item_source',
    'raw_source_prefix',
    'retention_cutoffs',
    'retention_filter',
    'silver_source_prefix',
    'whole_upload_key',
]

# The whole-source erasure's field: the value IS a source id (``source_platform``).
SOURCE_FIELD: Final = 'source'
ERASE_FIELDS: Final = ('author', 'source_id', 'csv_row_id', 'email', SOURCE_FIELD)
# The erasure fields that name one person the same wherever their data is: the ones that reach every workspace.
# An email only: an author is a display name, not unique even within one source.
PERSON_FIELDS: Final = ('email',)
# The fields an erasure job that names one workspace may erase by (shared/erasure_scope.py): every field but the
# whole source. Inside one workspace an author, a source id and a CSV row are that workspace's own values.
WORKSPACE_ERASE_FIELDS: Final = ('author', 'source_id', 'csv_row_id', 'email')
# The partition of erasure job rows in voc-aggregates (Settings starts them, voc-retention runs them).
ERASURE_JOB_PK: Final = 'JOB#erasure'
# Every job row's ``sk`` (and ``job_id``) starts with this; the partition's lock rows do not.
ERASURE_JOB_PREFIX: Final = 'er_'
_EMAIL_PATHS: Final = ('metadata.email', 'metadata.submitter_email')
FEEDBACK_SK_PREFIX: Final = 'FEEDBACK#'
# The counters an erasure job's row records (voc-retention writes them, Settings lists them; 0 when absent).
ERASURE_JOB_COUNTERS: Final = ('deleted_items', 'deleted_objects', 'deleted_radar_items', 'artifacts_marked')
# Rows an erasure by email de-identified rather than deleted: board requests and +1s (jobs/retention/boards.py),
# workspace memberships (jobs/retention/members.py). On the job and audit rows only once above 0.
BOARD_COUNTER: Final = 'board_items_deidentified'
MEMBER_COUNTER: Final = 'member_rows_deidentified'
# Of ``deleted_items``, how many were a workspace's (``WS#{ws}#SOURCE#…``): an erasure of a person reaches them.
WORKSPACE_ITEM_COUNTER: Final = 'deleted_workspace_items'
# Rows a retention run skipped because their partition starts `WS#` but names no workspace (an erasure fails on one).
UNSCOPED_ROW_COUNTER: Final = 'unscoped_rows_skipped'
# The export objects (zips and work objects, every version) an erasure deleted under the workspaces it reached:
# an export is a derived copy (jobs/retention/exports.py).
EXPORT_OBJECT_COUNTER: Final = 'deleted_export_objects'
# The rows of a workspace's projects an erasure by email de-identified (7.43.00: a reviewer's comment threads, a
# review link's audience, a project META's owner and member addresses; jobs/retention/project_people.py).
PROJECT_COUNTER: Final = 'project_rows_deidentified'
# The registry, link and series ids the workspace walks skipped because they are not shaped like one (counted, never
# a partition: jobs/retention/lineage.py, project_people.py), as the hard delete counts its own.
MALFORMED_ID_COUNTER: Final = 'project_ids_malformed'
# The product documents an erasure by email could not judge (an image, a kind it does not read, text it could not
# read or not extracted yet), each listed under ``files_not_checked`` (jobs/retention/project_people.py).
DOCS_NOT_CHECKED_COUNTER: Final = 'product_docs_not_checked'
# A feedback form's test responses a run deleted (the deployment's and the workspaces' forms partitions, never feedback
# items: jobs/retention/form_tests.py, since 7.55.00's AI review).
FORM_TEST_COUNTER: Final = 'form_test_responses_deleted'
# The participants an erasure by email erased in voc-participants (7.72.00, projects 3g2: each person the address's
# guard named, in the deployment and in each walked workspace; jobs/retention/participants.py).
PARTICIPANT_COUNTER: Final = 'participants_erased'
# The participants the participant erasure refused (kept saved for a later erasure), the guard or people-index rows
# naming no person id, and the workspace guards' index rows left holding the address (kept after every try conflicted,
# no guard back: the entry stays saved and the next erasure unlists them).
NOT_ERASED_COUNTER: Final = 'participants_not_erased'
GUARD_MALFORMED_COUNTER: Final = 'participant_guards_malformed'
INDEX_KEPT_COUNTER: Final = 'participant_index_rows_kept'
# With -c engineeringAgents=true (7.84.00, projects 3g3-b): the engineering runs' META rows and the issues' run claims
# whose erased review ids a run removed (jobs/retention/engineering_lineage.py); the people an erasure by email erased
# from the agents' memory (rows of theirs deleted), those it only refused (a tombstone, the memory holding none of
# their rows), and the accounts holding the address it did not take for that person (an unverified address:
# jobs/retention/agent_memory.py).
ENGINEERING_MARK_COUNTER: Final = 'engineering_rows_marked'
AGENT_MEMORY_COUNTER: Final = 'agent_memory_people_erased'
AGENT_MEMORY_REFUSED_COUNTER: Final = 'agent_memory_people_refused'
AGENT_MEMORY_NOT_ERASED_COUNTER: Final = 'agent_memory_accounts_not_erased'
# (7.96.00) A workspace's erasure that fell back to a Scan of voc-feedback because its workspace's META names no
# created_at, so its day walk has no first day (jobs/retention/item_walk.py): 1 on such a job's rows.
WORKSPACE_SCAN_COUNTER: Final = 'workspace_item_scans'
# (7.98.00, projects 3g-pin) The prototype pins whose replies an erasure by email de-identified: a reply's name that was
# the address, written before 7.48.00, now "Team member" (jobs/retention/pins.py).
PIN_COUNTER: Final = 'pin_replies_deidentified'
# The counters on the job and audit rows only once above 0 (a run that touched none reads as before).
ERASURE_OPTIONAL_COUNTERS: Final = (BOARD_COUNTER, MEMBER_COUNTER, WORKSPACE_ITEM_COUNTER, UNSCOPED_ROW_COUNTER,
                                    EXPORT_OBJECT_COUNTER, PROJECT_COUNTER, PIN_COUNTER, MALFORMED_ID_COUNTER,
                                    DOCS_NOT_CHECKED_COUNTER, FORM_TEST_COUNTER, PARTICIPANT_COUNTER,
                                    NOT_ERASED_COUNTER, GUARD_MALFORMED_COUNTER, INDEX_KEPT_COUNTER,
                                    ENGINEERING_MARK_COUNTER, AGENT_MEMORY_COUNTER, AGENT_MEMORY_REFUSED_COUNTER,
                                    AGENT_MEMORY_NOT_ERASED_COUNTER, WORKSPACE_SCAN_COUNTER)
# Where a matched item lives: voc-feedback, or voc-radar (another brand's review, docs/radar.md).
STORE_FEEDBACK: Final = 'feedback'
STORE_RADAR: Final = 'radar'
#: The source an item without one is tombstoned under (``AUDIT#tombstone#unknown``): voc-retention's and a
#: workspace's hard delete's (jobs/retention/copies.py, jobs/workspace_delete/sweeps.py).
UNKNOWN_SOURCE: Final = 'unknown'


def item_source(item: Mapping[str, Any]) -> str:
    """The source an item was ingested from (its ``source_platform``), ``UNKNOWN_SOURCE`` for none: the partition of
    its tombstone (voc-retention's and the hard delete's)."""
    source = item.get('source_platform')
    return source if isinstance(source, str) and source else UNKNOWN_SOURCE


def item_feedback_id(item: Mapping[str, Any]) -> str:
    """An item's id: its ``feedback_id``, else its sort key without ``FEEDBACK#`` (its tombstone's id)."""
    feedback_id = item.get('feedback_id')
    if isinstance(feedback_id, str) and feedback_id:
        return feedback_id
    return str(item['sk']).removeprefix(FEEDBACK_SK_PREFIX)
_RADAR_PK_PREFIX: Final = 'RADAR#'
_RADAR_ITEMS_MARK: Final = '#ITEMS#'
_WHOLE_UPLOAD_PREFIXES: Final = ('raw/csv_upload/', 'raw/json_upload/')
# The whole-file folders below either scope's raw root (``raw/``, ``ws/{ws}/raw/``), each holding only whole files:
# the CSV / JSON uploads' (``api/manual_import_handler.py``) and the form imports' originals
# (``shared/forms_v2_import.py`` ``file_key_of``: ``feedback_form/import/{form_id}/{run}.{ext}``, beside the dated
# per-item folders of source ``feedback_form``, whose first segment is a year). The source profiles reserve the
# first two as source ids (shared/source_profiles.py ``RESERVED_SOURCE_IDS``).
_WHOLE_UPLOAD_FOLDERS: Final = ('csv_upload/', 'json_upload/', 'feedback_form/import/')
# The paste confirm's folder: its whole files beside the per-item archives of source ``manual_import``
# (whole_upload_key tells them apart).
_PASTE_FOLDER: Final = 'manual_import/'
# The s3_import plugin's label for an imported file's items (plugins/s3_import/ingestor/handler.py
# `_get_source_from_key`) and the folder it keeps the files' originals in under a bronze root
# (shared/plugin_identity.py `S3_IMPORT_SOURCE`, which plugins/_shared/raw_original.py files them under).
S3_IMPORT_LABEL_PREFIX: Final = 'S3 - '
_IMPORT_ORIGINALS_FOLDER: Final = 's3_import/'
_MAX_VERSIONS_PER_DELETE: Final = 1000


def retention_cutoffs(profiles: list[dict[str, Any]], today: date) -> dict[str, str]:
    """``{source_id: first kept 'YYYY-MM-DD'}`` for every profile with a retention period."""
    cutoffs: dict[str, str] = {}
    for profile in profiles:
        days = profile.get('retention_days')
        if isinstance(days, int) and not isinstance(days, bool) and days > 0:
            cutoffs[str(profile['id'])] = (today - timedelta(days=days)).isoformat()
    return cutoffs


def _store_items(store: str, *, workspaces: bool) -> ConditionBase:
    """The rows of ``store`` that are reviews: ``FEEDBACK#`` items, or Radar's month-partitioned reviews.

    A Radar review row (``shared/radar_store.py``) is ``RADAR#{brand}#ITEMS#{month}`` and carries
    ``feedback_id`` and ``radar_brand``; its counters and dedupe markers carry neither, so a
    category named ``ITEMS`` in a counter's key can never match.

    ``workspaces``: whether a workspace's item (``WS#{ws}#SOURCE#…``, docs/multi-workspace.md) is in reach (with its
    raw objects and Silver versions under ``ws/{ws}/``, ``delete_item``): an erasure of a person and a retention
    window reach one; a whole-source erasure, a request about the deployment's own source, leaves it.
    """
    if store == STORE_RADAR:
        return (Attr('pk').begins_with(_RADAR_PK_PREFIX) & Attr('pk').contains(_RADAR_ITEMS_MARK)
                & Attr('feedback_id').exists() & Attr('radar_brand').exists())
    if store != STORE_FEEDBACK:
        raise ValueError(f'Unknown item store "{store}"')
    feedback = Attr('sk').begins_with(FEEDBACK_SK_PREFIX)
    return feedback if workspaces else feedback & ~Attr('pk').begins_with(WORKSPACE_KEY_PREFIX)


def retention_filter(cutoffs: Mapping[str, str], store: str = STORE_FEEDBACK) -> ConditionBase:
    """Scan filter: items of ``store`` of a retained source dated before its cutoff.

    A workspace's item too: the windows are the deployment's. A workspace's profile sets none (the settings API
    refuses one), and at ingestion a workspace's source carries the deployment's window
    (shared/source_profiles.py ``cached_source_profile_strict``), so ``plugins/_shared/raw_original.py`` keeps no
    whole file for a source with a window there either, because the window deletes item by item.
    """
    clauses = [Attr('source_platform').eq(source) & Attr('date').lt(cutoff) for source, cutoff in cutoffs.items()]
    if not clauses:
        raise ValueError('retention_filter needs at least one source')
    combined = clauses[0]
    for clause in clauses[1:]:
        combined = combined | clause
    return _store_items(store, workspaces=True) & combined


def reaches_workspaces(field: str) -> bool:
    """Whether an erasure by ``field`` reaches the workspaces' items: an erasure by ``email`` does, wherever a copy
    is (one address is one person). An erasure by ``author`` does not: a display name is not unique even within one
    source, so the deployment's Jane Doe is not every workspace's Jane Doe. Nor by ``source_id`` or ``csv_row_id``:
    such an id is unique only within one source account or upload, and each workspace has its own. Those stay the
    deployment's on a job that names no workspace (a job that names one reaches that workspace only, by any
    ``WORKSPACE_ERASE_FIELDS`` field: ``erase_filter``'s ``scope``). Nor does a whole-source erasure
    (``SOURCE_FIELD``), a request about the deployment's own source."""
    return field in PERSON_FIELDS


def _workspace_items(scope: WorkspaceScope, field: str, store: str) -> ConditionBase:
    """The rows a job that names ``scope`` may erase: that workspace's ``FEEDBACK#`` items only (``WS#{ws}#…``)."""
    if store != STORE_FEEDBACK:
        raise ValueError('An erasure in a workspace reaches its feedback items only')
    if field not in WORKSPACE_ERASE_FIELDS:
        raise ValueError(f'An erasure in a workspace cannot erase by "{field}"')
    return Attr('sk').begins_with(FEEDBACK_SK_PREFIX) & Attr('pk').begins_with(scope.prefix)


def erase_filter(field: str, value: str, source: str | None, store: str = STORE_FEEDBACK,
                 scope: WorkspaceScope | None = None) -> ConditionBase:
    """Scan filter: items of ``store`` whose ``field`` equals ``value`` (optionally in one source).

    ``scope`` None (a job that names no workspace): in every workspace too only for an erasure by email
    (``reaches_workspaces``), else the deployment's items only. A ``scope`` (a job that names one workspace): that
    workspace's feedback items only, by any ``WORKSPACE_ERASE_FIELDS`` field (ValueError for another field or store).
    """
    if field not in ERASE_FIELDS:
        raise ValueError(f'Unknown erasure field "{field}"')
    if field == 'email':
        # Case-insensitive: ingestion stores these lower-cased; the value as typed
        # also matches an item stored before that normalisation.
        spellings = list(dict.fromkeys([value.strip().lower(), value]))
        match = Attr(_EMAIL_PATHS[0]).is_in(spellings) | Attr(_EMAIL_PATHS[1]).is_in(spellings)
    elif field == SOURCE_FIELD:
        match = Attr('source_platform').eq(value)
    else:
        match = Attr(field).eq(value)
    items = (_store_items(store, workspaces=reaches_workspaces(field)) if scope is None
             else _workspace_items(scope, field, store))
    condition = items & match
    return condition & Attr('source_platform').eq(source) if source and field != SOURCE_FIELD else condition


def erase_matches(item: Mapping[str, Any], field: str, value: str, source: str | None,
                  scope: WorkspaceScope | None = None) -> bool:
    """Whether one stored voc-feedback row matches ``erase_filter(field, value, source, STORE_FEEDBACK, scope)``: the
    same rule, evaluated in Python as DynamoDB evaluates the filter (an attribute matches only as a string; a nested
    email only inside a ``metadata`` map; ``begins_with`` only on a string key). A workspace's erasure reads its
    candidates from an index and acts only on a row this accepts once read again from the table
    (jobs/retention/item_walk.py); lambda/shared/test/test_erase_matches.py holds it equal to the Scan's filter on
    moto. ValueError where ``erase_filter`` raises one."""
    if field not in ERASE_FIELDS:
        raise ValueError(f'Unknown erasure field "{field}"')
    if scope is not None and field not in WORKSPACE_ERASE_FIELDS:
        raise ValueError(f'An erasure in a workspace cannot erase by "{field}"')
    if not _starts(item.get('sk'), FEEDBACK_SK_PREFIX):
        return False
    pk = item.get('pk')
    if scope is not None:
        if not _starts(pk, scope.prefix):
            return False
    elif not reaches_workspaces(field) and _starts(pk, WORKSPACE_KEY_PREFIX):
        return False
    if field == 'email':
        spellings = {value.strip().lower(), value}
        metadata = item.get('metadata')
        names = [path.split('.', 1)[1] for path in _EMAIL_PATHS]
        found = isinstance(metadata, Mapping) and any(_string_in(metadata.get(name), spellings) for name in names)
    else:
        found = _string_in(item.get('source_platform' if field == SOURCE_FIELD else field), {value})
    if not found:
        return False
    return _string_in(item.get('source_platform'), {source}) if source and field != SOURCE_FIELD else True


def _starts(value: object, prefix: str) -> bool:
    return isinstance(value, str) and value.startswith(prefix)


def _string_in(value: object, allowed: set[str]) -> bool:
    return isinstance(value, str) and value in allowed


@dataclass(frozen=True)
class ItemRawObjects:
    """One item's own raw objects: an exact key (its legacy archive) and, in the versioned layout, its folder."""

    key: str
    folder: str | None


def item_scope(item: Mapping[str, Any]) -> WorkspaceScope | None:
    """The workspace ``item`` is stored in (its ``pk``), None for a deployment item; ValueError for a ``WS#`` key
    that names no workspace (never deleted as if it were the deployment's: the run fails and says so)."""
    return partition_scope(item.get('pk'))


def _own_raw_key(item: Mapping[str, Any], bucket: str) -> tuple[str, str] | None:
    """``(key, source_id)`` of ``item``'s ``s3_raw_uri`` when it may be its own archive (see module doc).

    The key must be under the bronze root of the item's own scope (``raw_root``): ``raw/`` for a deployment item,
    ``ws/{ws}/raw/`` for a workspace's, so no item ever reaches another scope's objects.
    """
    uri = item.get('s3_raw_uri')
    source_id = item.get('source_id')
    if not isinstance(uri, str) or not bucket or not isinstance(source_id, str) or not source_id:
        return None
    parsed = urlparse(uri)
    key = parsed.path.lstrip('/')
    scope = item_scope(item)
    root = raw_root(scope)
    if parsed.scheme != 's3' or parsed.netloc != bucket or not key.startswith(root):
        return None
    if '..' in key.split('/'):
        return None
    if _in_whole_folder(key, root) and (scope is None or _versioned_archive(key) is None):
        # A CSV / JSON upload or a form import's original holds every row of its upload: never one item's own. In a
        # workspace only, a versioned per-item copy ({stem}/{sha16}.{ext}, a shape no whole file has, and the only
        # layout a workspace ever wrote) of a source stored under a reserved id may be one there
        # (shared/source_profiles.py ``RESERVED_SOURCE_IDS``); the deployment's rule is unchanged: kept and listed.
        return None
    return key, source_id


def _in_whole_folder(key: str, root: str) -> bool:
    """Whether ``key`` is in one of the whole-file folders below ``root`` (``_WHOLE_UPLOAD_FOLDERS``)."""
    return key.startswith(root) and key.removeprefix(root).startswith(_WHOLE_UPLOAD_FOLDERS)


def _versioned_archive(key: str) -> ItemArchive | None:
    """The per-item archive ``key`` is a VERSION of (``{folder}{sha16}.{ext}``), or None: its legacy key too."""
    archive = parse_item_key(key)
    return archive if archive is not None and key != archive.legacy_key else None


def item_raw_objects(item: Mapping[str, Any], bucket: str) -> ItemRawObjects | None:
    """``item``'s own raw objects in ``bucket`` in BOTH layouts, or None (see module doc).

    A per-item archive key (``shared.raw_versions.parse_item_key``), legacy
    ``.../{stem}.json`` or versioned ``.../{stem}/{sha16}.json``, names the legacy key
    AND the folder holding every version, whichever of the two the item references.
    Any other key under ``raw/`` whose file stem is the item's is that exact key only,
    as before. The stem must be the writers' collision-free one (``shared/archive_keys.py``). In a whole-file folder
    (a versioned copy only, ``_own_raw_key``) the legacy key is never named: ``{stem}.json`` there is a whole file's
    shape, so only the item's folder and its own key go.
    """
    own = _own_raw_key(item, bucket)
    if own is None:
        return None
    key, source_id = own
    stem = archive_key_stem(source_id)
    archive = parse_item_key(key)
    if archive is not None and archive.stem != stem:
        return None
    if archive is not None:
        whole_folder = _in_whole_folder(key, raw_root(item_scope(item)))
        return ItemRawObjects(key=key if whole_folder else archive.legacy_key, folder=archive.folder)
    return ItemRawObjects(key=key, folder=None) if key.rpartition('/')[2].removesuffix('.json') == stem else None


def _delete_versions(s3: Any, bucket: str, prefix: str, matches: Callable[[str], bool]) -> int:
    """Delete every version and delete marker under ``prefix`` whose key ``matches``; the files deleted.

    The count is of distinct keys that still had a version holding data (a delete
    marker alone is no file).
    """
    files: set[str] = set()
    paginator = s3.get_paginator('list_object_versions')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        data = [entry for entry in page.get('Versions', []) if _selected(entry, matches)]
        markers = [entry for entry in page.get('DeleteMarkers', []) if _selected(entry, matches)]
        versions = [{'Key': entry['Key'], 'VersionId': entry['VersionId']} for entry in [*data, *markers]]
        for start in range(0, len(versions), _MAX_VERSIONS_PER_DELETE):
            response = s3.delete_objects(
                Bucket=bucket, Delete={'Objects': versions[start:start + _MAX_VERSIONS_PER_DELETE], 'Quiet': True})
            if response.get('Errors'):
                raise RuntimeError(f'{len(response["Errors"])} raw object versions could not be deleted')
        files.update(str(entry['Key']) for entry in data)
    return len(files)


def _selected(entry: Mapping[str, Any], matches: Callable[[str], bool]) -> bool:
    return matches(str(entry.get('Key', ''))) and bool(entry.get('VersionId'))


def _delete_own_raw_objects(s3: Any, bucket: str, item: Mapping[str, Any]) -> int:
    """Every version of ``item``'s own raw archive, in both layouts; the files deleted."""
    targets = item_raw_objects(item, bucket)
    if targets is None:
        return 0
    legacy = targets.key
    objects = _delete_versions(s3, bucket, legacy, lambda key: key == legacy)
    folder = targets.folder
    if folder is not None:
        objects += _delete_versions(s3, bucket, folder, lambda key: key.startswith(folder))
    return objects


def delete_item(feedback_table: Any, s3: Any, bucket: str, item: Mapping[str, Any]) -> tuple[int, int]:
    """Delete one feedback item and its own raw objects; ``(items deleted, raw files deleted)``.

    Every version of the legacy key and every object (all versions) under the item's
    folder go, and every kept Silver version of the item (``delete_silver_versions``).
    The S3 copies go first: if that fails the item stays, so a retry finds
    it again (deleting the item first would orphan the objects for good).

    A workspace's item (``WS#{ws}#SOURCE#…``) takes its own copies under ``ws/{ws}/``: its raw objects under
    ``ws/{ws}/raw/`` and its Silver versions under ``ws/{ws}/silver/``, and the item is deleted through the
    workspace layer (``ws_table``, which refuses a key outside the workspace).
    """
    scope = item_scope(item)
    objects = delete_silver_versions(s3, bucket, item) + _delete_own_raw_objects(s3, bucket, item)
    key = {'pk': item['pk'], 'sk': item['sk']}
    if scope is None:
        feedback_table.delete_item(Key=key)
    else:
        ws_table(scope, feedback_table).delete_item(key)
    logger.debug('Deleted one feedback item under its retention / erasure rule')
    return 1, objects


def delete_silver_versions(s3: Any, bucket: str, item: Mapping[str, Any]) -> int:
    """Every kept Silver version of ``item`` (``silver/{source}/{feedback_id}/``, all object versions; a workspace
    item's ``ws/{ws}/silver/{source}/{feedback_id}/``).

    The item's earlier states (``shared/silver_provenance.py``) are copies of it, so an erasure
    reaches them too (TENETS.md D5). Returns the files deleted; 0 for an item without an id.
    """
    prefix = silver_item_prefix(item, item_scope(item))
    if prefix is None:
        return 0
    return _delete_versions(s3, bucket, prefix, lambda key: key.startswith(prefix))


def delete_radar_item(radar_table: Any, s3: Any, bucket: str, item: Mapping[str, Any]) -> tuple[int, int]:
    """Delete one Radar review, its dedupe marker and its own raw objects; ``(reviews, raw files)``.

    Same order as ``delete_item``: raw first, then the marker, then the review row, so
    a crash leaves the review findable by the next scan (a marker left without its row
    would only keep that review from being stored again). The brand's daily counters
    are left as they are: they hold counts, no content, and are rebuilt from the
    reviews (docs/radar.md).
    """
    objects = _delete_own_raw_objects(s3, bucket, item)
    radar_table.delete_item(Key=marker_key(str(item['radar_brand']), str(item['feedback_id'])))
    radar_table.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
    logger.debug('Deleted one Radar review under its retention / erasure rule')
    return 1, objects


def whole_upload_key(item: Mapping[str, Any], bucket: str) -> str | None:
    """The key of the whole file ``item`` came from (its ``s3_raw_uri``), or None: a file to list for review.

    A whole file holds every row of one upload, below the raw root of the item's own scope (``raw_root``: ``raw/`` or
    ``ws/{ws}/raw/``): a CSV / JSON upload (``csv_upload/``, ``json_upload/``, ``api/manual_import_handler.py``), a
    form import's original (``feedback_form/import/{form_id}/{run}.{ext}``, ``api/feedback_form_handler.py``) and the
    paste confirm's ``manual_import/{y}/{m}/{d}/{job_id}.json``. A paste file has the shape of a legacy per-item key,
    so a key under ``manual_import/`` is told apart by the item: its own per-item archive (``item_raw_objects``: named
    after its ``source_id``) is not a whole file. Any other key there is: its paste's file (a pasted review's
    ``source_id`` is ``manual-{job_id}-{n}``, never the file's ``{job_id}``, on every paste item since the first
    release; the file's body holds ``job_id`` and ``final_reviews``, which an operator can check, and which this
    run does not read, since the key is listed either way), or a key the run cannot place, listed all the same. In a
    workspace's CSV / JSON or form import folder only a versioned per-item copy (``{stem}/{sha16}.{ext}``, a shape no whole file
    has) named after the item is its own: a source stored under a reserved id before 7.109.00 wrote those.

    A key outside the item's own root (another workspace's, the deployment's for a workspace item, or under no
    workspace at all) is never a whole file of this scope, and no per-item delete follows it: it is returned too, an
    unknown copy (fail closed). Every key returned is only listed, never deleted, unless it is the deployment's CSV /
    JSON upload and the run is its source's whole-source erasure (``delete_whole_upload``, ``is_deletable_upload``).
    The item's ``s3_raw_uri`` is the link (``stamp_file_archive`` writes the file's URI on every item of the upload),
    so items stored before 7.109.00 are covered too. None for no URI, another bucket, a folder or a ``..`` key.
    """
    key = _raw_uri_key(item, bucket)
    if key is None:
        return None
    root = raw_root(item_scope(item))
    if not key.startswith(root):
        return key
    if not key.removeprefix(root).startswith((*_WHOLE_UPLOAD_FOLDERS, _PASTE_FOLDER)):
        return None
    # The item's own per-item copy there (in a whole-file folder a versioned one only: ``_own_raw_key``) goes with it.
    return None if item_raw_objects(item, bucket) is not None else key


def is_deletable_upload(key: str) -> bool:
    """Whether ``key`` is a whole file a whole-source erasure deletes itself: the deployment's CSV / JSON upload."""
    return key.startswith(_WHOLE_UPLOAD_PREFIXES)


def _raw_uri_key(item: Mapping[str, Any], bucket: str) -> str | None:
    """The object key of ``item``'s ``s3_raw_uri`` in ``bucket`` (an object, never a folder), or None."""
    uri = item.get('s3_raw_uri')
    if not isinstance(uri, str) or not bucket:
        return None
    parsed = urlparse(uri)
    key = parsed.path.lstrip('/')
    if parsed.scheme != 's3' or parsed.netloc != bucket or '..' in key.split('/') or key.endswith('/'):
        return None
    return key


def import_originals_prefix(item: Mapping[str, Any]) -> str | None:
    """The folder of the S3 import originals of ``item``'s scope (``raw/s3_import/`` or ``ws/{ws}/raw/s3_import/``)
    when ``item`` is an S3 import's (``source_platform`` ``S3 - …``), else None (see the module docstring)."""
    source = item.get('source_platform')
    if not isinstance(source, str) or not source.startswith(S3_IMPORT_LABEL_PREFIX):
        return None
    return raw_root(item_scope(item)) + _IMPORT_ORIGINALS_FOLDER


def holds_files(s3: Any, bucket: str, prefix: str) -> bool:
    """Whether any object version holding data is under ``prefix`` (a delete marker is no file). Pages until a
    version appears or the listing ends, so a folder whose first entries are delete markers still counts."""
    paginator = s3.get_paginator('list_object_versions')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        if any(_under(entry, prefix) for entry in page.get('Versions', [])):
            return True
    return False


def delete_whole_upload(s3: Any, bucket: str, key: str) -> int:
    """Every version of the whole-file upload at exactly ``key``; the files deleted (0 or 1)."""
    if not key.startswith(_WHOLE_UPLOAD_PREFIXES):
        raise ValueError('Not a whole-file upload archive')
    return _delete_versions(s3, bucket, key, lambda listed: listed == key)


def silver_source_prefix(source: str) -> str | None:
    """``silver/{source}/``: every kept Silver version of ``source``'s items (same rules as ``raw_source_prefix``)."""
    if not source or '/' in source or source in ('.', '..'):
        return None
    return f'{SILVER_PREFIX}{archive_key_stem(source)}/'


def raw_source_prefix(source: str) -> str | None:
    """``raw/{source}/``: every per-item archive of ``source``; None for a whole-upload archive folder.

    The trailing ``/`` keeps source ``web`` from matching the folder of ``web_shop``. A
    source id never contains ``/`` (``SOURCE_ID_RE``), so no other folder can
    be reached from it.
    """
    if not source or '/' in source or source in ('.', '..'):
        return None
    prefix = f'{RAW_PREFIX}{source}/'
    return None if prefix.startswith(_WHOLE_UPLOAD_PREFIXES) else prefix


def delete_raw_prefix_page(s3: Any, bucket: str, prefix: str) -> tuple[int, bool]:
    """Delete the first listing page (≤ 1,000 versions) under ``prefix``: ``(objects deleted, more left)``.

    Every version and delete marker goes, as for one item's archive. The count
    is of files: the distinct keys in the page that still had a version holding
    data (a delete marker alone is no file, so it never counts). No
    listing cursor is kept: what was listed is deleted, so the next call lists
    from the start of the prefix again and sees only what is left (a marker
    naming a version just deleted is not a reliable place to resume from).
    """
    page = s3.list_object_versions(Bucket=bucket, Prefix=prefix, MaxKeys=_MAX_VERSIONS_PER_DELETE)
    versions = [entry for entry in page.get('Versions', []) if _under(entry, prefix)]
    entries = [*versions, *(entry for entry in page.get('DeleteMarkers', []) if _under(entry, prefix))]
    if entries:
        response = s3.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': entry['Key'], 'VersionId': entry['VersionId']} for entry in entries], 'Quiet': True})
        if response.get('Errors'):
            raise RuntimeError(f'{len(response["Errors"])} raw object versions could not be deleted')
    objects = len({entry['Key'] for entry in versions})
    return objects, bool(entries) and bool(page.get('IsTruncated'))


def _under(entry: Mapping[str, Any], prefix: str) -> bool:
    """A listed version / marker under ``prefix`` that names a version id (what DeleteObjects needs)."""
    return str(entry.get('Key', '')).startswith(prefix) and bool(entry.get('VersionId'))
