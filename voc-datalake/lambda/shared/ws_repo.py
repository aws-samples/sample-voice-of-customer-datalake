"""The workspace-scoped repository layer of the data path (docs/multi-workspace.md, "Request flow", step 4).

Every partition key of the data path starts with ``WS#{ws}#`` and every object key with ``ws/{ws}/``, so a team
only ever reads and writes its own rows and objects. This module is the one place those keys are built:

* ``WorkspaceScope``: a verified workspace. Made only from what the server trusts: the request's resolved
  membership (``scope_of``, after shared/workspace.py ``resolve_workspace``), an asynchronous message's
  ``workspace_id`` field (``scope_from_message``: SQS bodies, Lambda async payloads, an erasure job's row, written by
  our own code from a scope), a stored partition key (``scope_from_key``: DynamoDB Stream records; ``partition_scope`` for a
  worker that reads both kinds of row, None for a deployment-wide one), or a stored control-plane routing row
  (``scope_from_lookup``: a public route's ``FORM#{id}``, a webhook's workspace ``META``, read by
  shared/workspace_routing.py). Never from a request field.
* Key builders: ``feedback_key`` and the feedback indexes' partitions (``date_pk``, ``category_pk``,
  ``urgency_pk``, ``feedback_id_pk``, ``channel_pk``), ``metric_pk`` / ``metric_type``, ``watermark_key``,
  ``source_run_pk``, ``scraper_run_pk`` and ``s3_key`` for objects (``s3_prefix`` their common ``ws/{ws}/``), ``plugin_config_key`` (a plugin's config list; ``plugin_config_history_key`` a list it replaced; the
  credentials parameters' names are shared/workspace_ids.py ``credentials_parameter_name``).
* ``ws_table``: a table that refuses any key, item, update or query outside the scope's partitions (every index
  partition of voc-feedback is one of ``PARTITION_ATTRIBUTES``: gsi4 and gsi5 are keyed on ``gsi4pk`` / ``gsi5pk``,
  no longer on the raw ``feedback_id`` and ``source_channel``), also in its multi-item calls on that one table
  (``transact_write_items``, ``batch_get_item``, ``batch_writer``): a caller never names a table, and one entry
  outside the scope refuses the whole call before anything is sent.
* ``control_query``: one read-only Query page of the workspace's two control-plane partitions in voc-workspaces,
  ``WS#{ws}`` (``META`` and the ``MEMBER#`` rows) and ``AUDIT#WS#{ws}``, which the layer builds itself (they are not
  ``WS#{ws}#…`` keys, so ``ws_table`` refuses them). The export job's reader (phase 4).
* ``ExportObjects``: the workspace's export objects, ``ws/{ws}/exports/…`` only (``exports_prefix``): the multipart
  upload of an export's zip, its work objects (each tagged ``voc-export=true``, which the raw bucket's lifecycle
  expires and its policy refuses anywhere else) and a presigned download of the zip. Any key outside the prefix is
  refused before any call reaches S3.
* ``workspace_is_active``: the one status check of every writer of a workspace's data (the scheduled fan-out, an
  ingestor's run, the processor, the aggregator; 4d-1): a GetItem of ``META`` limited to its status, cached per
  container in a ``WorkspaceStatusCache`` (300 s an active answer, 30 s a not-active one; ``WorkspaceStatusCheck``
  binds it to a table). ``watermark_directory_key``: the voc-aggregates row that lists a
  workspace's watermark, so its voc-watermarks rows are found without a Scan.

shared/test/test_ws_raw_access.py counts, per module outside this layer, the raw table and bucket calls and the
unscoped data-path keys, against an allowlist of the modules not moved yet that must match exactly.

The keys (``{ws}`` is ``ws_`` + a ULID, shared/workspace.py ``is_workspace_id``)::

    voc-feedback    pk WS#{ws}#SOURCE#{source}   sk FEEDBACK#{feedback_id}
                    gsi1pk WS#{ws}#DATE#{yyyy-mm-dd}      gsi2pk WS#{ws}#CATEGORY#{category}
                    gsi3pk WS#{ws}#URGENCY#{urgency}
                    gsi4pk WS#{ws}#FEEDBACK#{feedback_id}  gsi5pk WS#{ws}#CHANNEL#{channel}
    voc-aggregates  pk WS#{ws}#METRIC#{name}     metric_type WS#{ws}#{type}
                    pk WS#{ws}#SOURCE_RUN#{source}        pk WS#{ws}#SCRAPER_RUN#{scraper_id}
                    pk WS#{ws}#FAILURES#{plugin}          pk WS#{ws}#CIRCUIT#{plugin} (the plugins' breaker)
                    pk WS#{ws}#JOB#erasure (a workspace's erasure jobs and their lock)
                    pk WS#{ws}#JOB#export (a workspace's export jobs and their lock, shared/export_jobs.py)
                    pk WS#{ws}#PLUGIN_CONFIG  sk {plugin} (a plugin's config list, shared/plugin_configs.py)
                    pk WS#{ws}#PLUGIN_CONFIG#HISTORY  sk {plugin}#{iso}#{random} (a replaced list, kept, no ttl)
                    pk WS#{ws}#WATERMARK_KEYS  sk {plugin}#{key} (lists a watermark, ``watermark_directory_key``)
    voc-watermarks  source WS#{ws}#{plugin}#{key}
    voc-workspaces  pk WS#{ws} (META, MEMBER#{sub}), pk AUDIT#WS#{ws}: read by ``control_query``; META's status by
                    ``workspace_is_active``
    raw bucket      ws/{ws}/raw/{source}/{yyyy}/{mm}/{dd}/{stem}/{sha16}.json, ws/{ws}/silver/..., ws/{ws}/...,
                    ws/{ws}/exports/{export id}/… (``ExportObjects``)
    SSM parameters  {prefix}/{ws}/credentials/{plugin} (prefix /voc/ws, /<deployment prefix>-voc/ws in a prefixed
                    deployment; decision 19)
"""
from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, NoReturn, Protocol, Self

from botocore.exceptions import ClientError

from shared.aws import S3_MISSING_KEY_CODES, consistent_item
from shared.batch_get import BATCH_GET_ATTEMPTS, batch_get_all
from shared.dynamo_paging import iter_query
from shared.workspace_ids import ACTIVE, is_workspace_id, ws_key

__all__ = [
    'FORM_LOOKUP_PREFIX',
    'PARTITION_ATTRIBUTES',
    'STATUS_READ_ATTRIBUTES',
    'WORKSPACE_FIELD',
    'WORKSPACE_KEY_PREFIX',
    'ExportObjects',
    'ListedObject',
    'OutOfScopeError',
    'WorkspaceObjects',
    'WorkspaceScope',
    'WorkspaceStatusCheck',
    'WorkspaceTable',
    'category_pk',
    'channel_pk',
    'control_query',
    'date_pk',
    'erasure_job_pk',
    'export_job_pk',
    'exports_prefix',
    'feedback_id_pk',
    'feedback_key',
    'is_workspace_key',
    'memory_company_pk',
    'memory_cursor_pk',
    'memory_event_pk',
    'memory_import_pk',
    'memory_status_pk',
    'message_scope',
    'metric_pk',
    'metric_type',
    'partition_query',
    'partition_scope',
    'plugin_config_history_key',
    'plugin_config_history_pk',
    'plugin_config_key',
    'plugin_config_pk',
    's3_key',
    's3_prefix',
    'scope_from_key',
    'scope_from_lookup',
    'scope_from_message',
    'scope_of',
    'scraper_run_pk',
    'source_run_pk',
    'urgency_pk',
    'watermark_directory_key',
    'watermark_key',
    'ws_table',
]

#: The field an asynchronous message (SQS body, Lambda async payload) names its workspace in.
WORKSPACE_FIELD: Final = 'workspace_id'
#: How every partition key of a workspace starts (``ws_key``): a deployment-wide reader that pages a whole table
#: (a Scan, a stream) leaves rows whose partition starts with it to the workspace paths.
WORKSPACE_KEY_PREFIX: Final = 'WS#'
#: Item attributes that are partition keys of the table or of one of its indexes: each must be in the scope.
PARTITION_ATTRIBUTES: Final = ('pk', 'source', 'gsi1pk', 'gsi2pk', 'gsi3pk', 'gsi4pk', 'gsi5pk', 'metric_type')
#: voc-watermarks' partition key (its only key), never a ``pk`` table's partition nor an index's.
WATERMARK_PARTITION: Final = 'source'
#: The partition keys of the data-path tables: ``pk`` (voc-feedback, voc-aggregates), ``source`` (voc-watermarks).
TABLE_PARTITION_KEYS: Final = ('pk', WATERMARK_PARTITION)
#: ``= :placeholder`` right after an attribute in an UpdateExpression: the one checked way to set a partition.
_ASSIGNED_PLACEHOLDER: Final = re.compile(r'\s*=\s*(:\w+)(?![\w(])\s*(?:,|\Z|\b(?:SET|REMOVE|ADD|DELETE)\b)',
                                          re.IGNORECASE)
#: DynamoDB's ceiling on the entries of one TransactWriteItems.
MAX_TRANSACT_ITEMS: Final = 100
#: The entries a TransactWriteItems takes, and the options passed on (every other one is refused).
_TRANSACT_ACTIONS: Final = ('Put', 'Update', 'Delete', 'ConditionCheck')
_TRANSACT_WRITE_OPTIONS: Final = frozenset({'ClientRequestToken', 'ReturnConsumedCapacity',
                                            'ReturnItemCollectionMetrics'})
_BATCH_GET_OPTIONS: Final = frozenset({'ProjectionExpression', 'ExpressionAttributeNames', 'ConsistentRead'})
#: Request fields that name a table: the view fills in its own, a caller never names one.
_TABLE_FIELDS: Final = ('TableName', 'RequestItems')


class OutOfScopeError(ValueError):
    """A key, item or query outside the scope's partitions: a programming error, never a client's (500)."""


class UnprocessedKeysError(RuntimeError):
    """BatchGetItem still left keys unprocessed after ``BATCH_GET_ATTEMPTS`` calls (shared/batch_get.py): the read
    fails rather than quietly return fewer items."""



@dataclass(frozen=True)
class WorkspaceScope:
    """A verified workspace id. Build it with ``scope_of``, ``scope_from_message`` or ``scope_from_key``."""

    ws: str

    def __post_init__(self) -> None:
        if not is_workspace_id(self.ws):
            raise ValueError('not a workspace id')

    @property
    def prefix(self) -> str:
        """``WS#{ws}#``: every partition key of the scope starts with it."""
        return f'WS#{self.ws}#'

    def key(self, *parts: str) -> str:
        """``WS#{ws}#a#b``. Refuses an empty part. A ``#`` inside a part can make two part lists give one key,
        but only inside this workspace: the prefix is fixed, so no key of the scope is another workspace's."""
        if not parts or not all(parts):
            raise ValueError('a key needs non-empty parts')
        return ws_key(self.ws, *parts)

    def owns(self, value: object) -> bool:
        """Whether ``value`` is a partition key inside this scope."""
        return isinstance(value, str) and value.startswith(self.prefix) and len(value) > len(self.prefix)


class ResolvedWorkspace(Protocol):
    """What ``scope_of`` reads of a resolved request: shared/workspace.py ``WorkspaceContext``. A Protocol, not an
    import: shared/workspace.py imports the API helpers, which reach this layer through the feedback readers, so
    importing it here (even for typing only) would close an import cycle."""

    @property
    def ws(self) -> str: ...


def scope_of(context: ResolvedWorkspace) -> WorkspaceScope:
    """The scope of a request whose membership shared/workspace.py ``resolve_workspace`` resolved."""
    return WorkspaceScope(context.ws)


def scope_from_message(body: Mapping[str, Any]) -> WorkspaceScope:
    """The scope an asynchronous message names in ``workspace_id`` (written by our own code from a scope).

    ValueError when the field is missing or not a workspace id: such a message belongs to no workspace and is
    never processed under a guessed one.
    """
    value = body.get(WORKSPACE_FIELD)
    if not isinstance(value, str):
        raise ValueError('the message names no workspace')
    return WorkspaceScope(value)


def is_workspace_key(partition_key: object) -> bool:
    """Whether ``partition_key`` is a workspace's (``WS#…``), well formed or not: a deployment-wide reader skips
    it either way (``scope_from_key`` is the one that checks the workspace it names)."""
    return isinstance(partition_key, str) and partition_key.startswith(WORKSPACE_KEY_PREFIX)


def message_scope(body: object) -> tuple[bool, WorkspaceScope | None]:
    """``(refused, scope)`` of an asynchronous message on a path that serves both a workspace and the deployment.

    A message that names a workspace in ``workspace_id`` runs in it; one that names none (no such field) runs
    deployment-wide (``scope`` None); one whose field is there but is not a workspace id (``None`` included) is
    refused, never run deployment-wide instead.
    """
    if not isinstance(body, Mapping) or WORKSPACE_FIELD not in body:
        return False, None
    try:
        return False, scope_from_message(body)
    except ValueError:
        return True, None


def scope_from_key(partition_key: object) -> WorkspaceScope:
    """The scope a stored partition key ``WS#{ws}#…`` belongs to (a DynamoDB Stream record's ``pk``)."""
    if not isinstance(partition_key, str) or not partition_key.startswith('WS#'):
        raise ValueError('not a workspace key')
    ws, separator, rest = partition_key[3:].partition('#')
    if not separator or not rest:
        raise ValueError('not a workspace key')
    return WorkspaceScope(ws)


#: The control-plane routing row of voc-workspaces (sort key ``LOOKUP_SORT_KEY``) whose ``workspace_id`` names the
#: workspace a public entry point belongs to: a feedback form's ``FORM#{id}`` (docs/multi-workspace.md, "Public and
#: non-user entry points"). The workspace's own ``WS#{ws}`` / ``META`` row (a webhook's) names it by its key.
FORM_LOOKUP_PREFIX: Final = 'FORM#'
LOOKUP_SORT_KEY: Final = 'META'


def scope_from_lookup(row: object) -> WorkspaceScope:
    """The scope a STORED control-plane row routes to: a ``FORM#…`` / ``META`` row's ``workspace_id``, or the
    ``WS#{ws}`` of a workspace's own ``META`` row.

    Only shared/workspace_routing.py calls it, on an item its own GetItem returned (shared/test/test_ws_raw_access.py
    pins both): a public route's workspace comes from a server-side record, never from what the caller sent.
    ValueError for any other shape.
    """
    if not isinstance(row, Mapping) or row.get('sk') != LOOKUP_SORT_KEY:
        raise ValueError('not a lookup row')
    pk = row.get('pk')
    if isinstance(pk, str) and pk.startswith(FORM_LOOKUP_PREFIX) and pk.partition('#')[2]:
        return scope_from_message(row)
    if isinstance(pk, str) and pk.startswith(WORKSPACE_KEY_PREFIX) and '#' not in pk[len(WORKSPACE_KEY_PREFIX):]:
        return WorkspaceScope(pk[len(WORKSPACE_KEY_PREFIX):])
    raise ValueError('not a lookup row')


def partition_scope(partition_key: object) -> WorkspaceScope | None:
    """The workspace a stored row belongs to, by its partition key: None for a deployment-wide key, the scope for a
    workspace's (``WS#{ws}#…``). ValueError for a key that starts ``WS#`` but names no workspace: a worker that
    reaches every copy of a row (voc-retention's erasure) never treats such a row as deployment-wide."""
    return scope_from_key(partition_key) if is_workspace_key(partition_key) else None


def feedback_key(scope: WorkspaceScope, source: str, feedback_id: str) -> dict[str, str]:
    """``{pk, sk}`` of a processed feedback item: ``WS#{ws}#SOURCE#{source}`` / ``FEEDBACK#{feedback_id}``."""
    if not feedback_id:
        raise ValueError('a feedback item needs an id')
    return {'pk': scope.key('SOURCE', source), 'sk': f'FEEDBACK#{feedback_id}'}


def date_pk(scope: WorkspaceScope, day: str) -> str:
    """gsi1 (by date): ``WS#{ws}#DATE#{yyyy-mm-dd}``."""
    return scope.key('DATE', day)


def category_pk(scope: WorkspaceScope, category: str) -> str:
    """gsi2 (by category): ``WS#{ws}#CATEGORY#{category}``."""
    return scope.key('CATEGORY', category)


def urgency_pk(scope: WorkspaceScope, urgency: str) -> str:
    """gsi3 (by urgency): ``WS#{ws}#URGENCY#{urgency}``."""
    return scope.key('URGENCY', urgency)


def feedback_id_pk(scope: WorkspaceScope, feedback_id: str) -> str:
    """gsi4 (by feedback id): ``WS#{ws}#FEEDBACK#{feedback_id}``, so an id of another workspace finds nothing."""
    return scope.key('FEEDBACK', feedback_id)


def channel_pk(scope: WorkspaceScope, channel: str) -> str:
    """gsi5 (by channel): ``WS#{ws}#CHANNEL#{channel}``."""
    return scope.key('CHANNEL', channel)


def metric_pk(scope: WorkspaceScope, name: str, *parts: str) -> str:
    """An aggregates counter partition: ``WS#{ws}#METRIC#{name}[#part…]``."""
    return scope.key('METRIC', name, *parts)


def metric_type(scope: WorkspaceScope, kind: str) -> str:
    """The aggregates metric-type index partition: ``WS#{ws}#{kind}``."""
    return scope.key(kind)


def source_run_pk(scope: WorkspaceScope, source: str) -> str:
    """A source's run records (Run now, progress): ``WS#{ws}#SOURCE_RUN#{source}``."""
    return scope.key('SOURCE_RUN', source)


def scraper_run_pk(scope: WorkspaceScope, scraper_id: str) -> str:
    """A web scraper's run records (a Run now's progress): ``WS#{ws}#SCRAPER_RUN#{scraper_id}``."""
    return scope.key('SCRAPER_RUN', scraper_id)


def erasure_job_pk(scope: WorkspaceScope) -> str:
    """A workspace's erasure jobs and their lock (voc-aggregates, shared/erasure_jobs.py): ``WS#{ws}#JOB#erasure``."""
    return scope.key('JOB', 'erasure')


def export_job_pk(scope: WorkspaceScope) -> str:
    """A workspace's export jobs and their lock (voc-aggregates, shared/export_jobs.py): ``WS#{ws}#JOB#export``."""
    return scope.key('JOB', 'export')


def memory_company_pk(scope: WorkspaceScope) -> str:
    """The workspace's company memories in voc-memory (shared/memory_store.py ``COMPANY_PK``):
    ``WS#{ws}#MEM#company``."""
    return scope.key('MEM', 'company')


def memory_status_pk(scope: WorkspaceScope, memory_scope: str, status: str) -> str:
    """One status partition of voc-memory's ``gsi1-by-memory-status`` in the workspace (shared/memory_store.py
    ``status_partition``): ``WS#{ws}#MEMSTATUS#{company|personal}#{status}``."""
    return scope.key('MEMSTATUS', memory_scope, status)


def memory_cursor_pk(scope: WorkspaceScope) -> str:
    """The workspace's memory extraction cursors (``sk SESSION#{id}``): ``WS#{ws}#MEMCURSOR``."""
    return scope.key('MEMCURSOR')


def memory_import_pk(scope: WorkspaceScope) -> str:
    """The workspace's memory imports (``sk {import id}``): ``WS#{ws}#MEMIMPORT``."""
    return scope.key('MEMIMPORT')


def memory_event_pk(scope: WorkspaceScope, memory_id: str) -> str:
    """One memory's audit events (no content, no subs): ``WS#{ws}#MEMEVT#{memory id}``."""
    return scope.key('MEMEVT', memory_id)


def plugin_config_pk(scope: WorkspaceScope) -> str:
    """The partition of every plugin's config list of the workspace in voc-aggregates: ``WS#{ws}#PLUGIN_CONFIG``."""
    return scope.key('PLUGIN_CONFIG')


def plugin_config_key(scope: WorkspaceScope, plugin: str) -> dict[str, str]:
    """A plugin's config list (shared/plugin_configs.py): ``WS#{ws}#PLUGIN_CONFIG`` / ``{plugin}``. Refuses
    (ValueError) an empty plugin id; the callers pass a validated one."""
    if not plugin:
        raise ValueError('a plugin config key needs a plugin id')
    return {'pk': plugin_config_pk(scope), 'sk': plugin}


def plugin_config_history_pk(scope: WorkspaceScope) -> str:
    """The partition of every replaced config list of the workspace in voc-aggregates (kept forever, no ttl):
    ``WS#{ws}#PLUGIN_CONFIG#HISTORY``."""
    return scope.key('PLUGIN_CONFIG', 'HISTORY')


def plugin_config_history_key(scope: WorkspaceScope, plugin: str, superseded_at: str, token: str) -> dict[str, str]:
    """One superseded list of ``plugin`` (shared/plugin_configs.py ``save_configs``): ``WS#{ws}#PLUGIN_CONFIG#HISTORY``
    / ``{plugin}#{superseded_at}#{token}`` (an ISO time and a random token, so a plugin's history sorts by time and
    two saves never share a key). Refuses (ValueError) an empty part."""
    if not (plugin and superseded_at and token):
        raise ValueError('a plugin config history key needs a plugin id, a time and a token')
    return {'pk': plugin_config_history_pk(scope), 'sk': f'{plugin}#{superseded_at}#{token}'}


def watermark_key(scope: WorkspaceScope, plugin: str, key: str) -> str:
    """The ``source`` key of a plugin's watermark in voc-watermarks: ``WS#{ws}#{plugin}#{key}``."""
    return scope.key(plugin, key)


#: The voc-aggregates partition listing a workspace's watermarks (``watermark_directory_key``).
WATERMARK_DIRECTORY: Final = 'WATERMARK_KEYS'


def watermark_directory_key(scope: WorkspaceScope, plugin: str, key: str) -> dict[str, str]:
    """The directory row of one watermark in voc-aggregates: ``WS#{ws}#WATERMARK_KEYS`` / ``{plugin}#{key}``.

    voc-watermarks is keyed on ``source`` alone, so a workspace's watermarks share no partition; plugins/_shared/
    base_ingestor.py ``set_watermark`` puts this row (its key alone, so the put is idempotent) before the watermark, so the hard delete (4d-2)
    finds every one with one Query instead of a Scan: the watermark's key is ``scope.prefix`` + the row's ``sk``
    (``watermark_key``). Written since 4d-1 only: a deployment upgraded with workspace watermarks already written has
    no row for them (no backfill; multi-workspace runs are new). Refuses (ValueError) an empty part."""
    if not (plugin and key):
        raise ValueError('a watermark directory key needs a plugin id and a key')
    return {'pk': scope.key(WATERMARK_DIRECTORY), 'sk': f'{plugin}#{key}'}


def s3_key(scope: WorkspaceScope, *parts: str) -> str:
    """An object key inside the workspace: ``ws/{ws}/a/b``. Refuses empty, ``.`` and ``..`` segments."""
    segments = [segment for part in parts for segment in part.split('/')]
    if not segments or any(segment in ('', '.', '..') for segment in segments):
        raise ValueError('an object key needs non-empty segments')
    return '/'.join(('ws', scope.ws, *segments))


def s3_prefix(scope: WorkspaceScope) -> str:
    """``ws/{ws}/``: every object key of the workspace (``s3_key``) starts with it, and no other workspace's does."""
    return f'ws/{scope.ws}/'


#: The control-plane partitions of voc-workspaces ``control_query`` reads: the workspace's own ``WS#{ws}`` (its
#: ``META`` and ``MEMBER#`` rows) and its audit trail ``AUDIT#WS#{ws}``.
CONTROL_PARTITIONS: Final = ('meta', 'audit')


def control_partition(scope: WorkspaceScope, which: str) -> str:
    """``WS#{ws}`` (``which`` ``'meta'``) or ``AUDIT#WS#{ws}`` (``'audit'``); ValueError for anything else."""
    if which == 'meta':
        return ws_key(scope.ws)
    if which == 'audit':
        return f'AUDIT#{ws_key(scope.ws)}'
    raise ValueError(f'a control partition is one of {", ".join(CONTROL_PARTITIONS)}')


#: What a control-plane Query may pass on: no index (voc-workspaces has none to reach), no key condition (the layer
#: builds it) and no table.
_CONTROL_QUERY_REFUSED: Final = ('IndexName', 'KeyConditionExpression', *_TABLE_FIELDS)


def control_query(scope: WorkspaceScope, table: Any, which: str, *, sort_condition: str | None = None,
                  **kwargs: Any) -> dict:
    """One page of a Query of the workspace's control partition ``which`` (``control_partition``) in voc-workspaces.

    Read-only by construction (it only ever calls ``query``). The key condition is built here (``pk = :p``, then
    ``AND {sort_condition}``, whose names and values go in ``kwargs`` as ``WorkspaceTable.query`` takes them); a
    cursor (``ExclusiveStartKey``) must name that same partition. ``OutOfScopeError`` before any call otherwise.
    """
    partition = control_partition(scope, which)
    refused = [field for field in _CONTROL_QUERY_REFUSED if field in kwargs]
    if refused:
        raise OutOfScopeError(f'a control-plane query does not take {", ".join(refused)}')
    start = kwargs.get('ExclusiveStartKey')
    if start is not None and (not isinstance(start, Mapping) or start.get('pk') != partition):
        raise OutOfScopeError('a cursor outside the workspace')
    return table.query(**partition_query('pk', partition, sort_condition, kwargs))


#: How long a warm container trusts a workspace's status (``workspace_is_active``), by the answer:
#: * ``active``, 300 s: a workspace set to ``deleting`` stops every writer within this, beyond the invocation already
#:   running, so the hard delete's fence waits it out (5 min, plus one 15-minute invocation and a minute's margin: 21
#:   min); a longer one only lengthens that fence, and it is what keeps the hot paths' reads low;
#: * not active, 30 s: a delete cancelled during the fence makes the workspace active again, and its messages are
#:   dropped for at most this after (docs/multi-workspace.md, "Export and delete").
ACTIVE_STATUS_TTL_SECONDS: Final = 300.0
INACTIVE_STATUS_TTL_SECONDS: Final = 30.0
#: A container keeps at most this many statuses; a full cache drops the expired ones, then the soonest to expire.
MAX_CACHED_STATUSES: Final = 1024
#: Exactly what ``workspace_is_active`` (and a webhook's routing, shared/workspace_routing.py) reads of a workspace's
#: ``META``, with its keys: those roles are held to these (lib/utils/workspace-request-grants.ts
#: ``grantWorkspaceStatusRead``, ``dynamodb:Attributes``).
STATUS_READ_ATTRIBUTES: Final = ('pk', 'sk', 'status')


class WorkspaceStatusCache:
    """Whether each workspace is active, as one warm container last read it: an active answer for
    ``ACTIVE_STATUS_TTL_SECONDS``, a not-active one for ``INACTIVE_STATUS_TTL_SECONDS``.

    Both answers are kept, so a deleted workspace's records are not each a read; a failed read never is
    (``workspace_is_active`` puts only what it read). Thread-safe: the processor's records run on worker threads."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[float, bool]] = {}

    def get(self, ws: str) -> bool | None:
        """The cached answer for ``ws``, or None when there is none or it is older than the TTL."""
        with self._lock:
            entry = self._entries.get(ws)
            if entry is None:
                return None
            expires_at, active = entry
            if self._clock() >= expires_at:
                del self._entries[ws]
                return None
            return active

    def put(self, ws: str, active: bool) -> None:
        """Keep ``ws``'s answer for its TTL. A full cache first drops the answers already expired, then the one that
        would expire soonest (with two TTLs the order they were put in is not the order they expire in), never the
        whole cache."""
        with self._lock:
            now = self._clock()
            self._entries.pop(ws, None)
            if len(self._entries) >= MAX_CACHED_STATUSES:
                for expired in [key for key, (expires_at, _active) in self._entries.items() if expires_at <= now]:
                    del self._entries[expired]
                while len(self._entries) >= MAX_CACHED_STATUSES:
                    del self._entries[min(self._entries, key=lambda key: self._entries[key][0])]
            ttl = ACTIVE_STATUS_TTL_SECONDS if active else INACTIVE_STATUS_TTL_SECONDS
            self._entries[ws] = (now + ttl, active)


def workspace_is_active(table: Any, scope: WorkspaceScope, cache: WorkspaceStatusCache) -> bool:
    """Whether the workspace's ``META`` (voc-workspaces ``WS#{ws}`` / ``META``) says ``active``: every writer of a
    workspace's data asks before it writes (the scheduled fan-out, an ingestor's run, the processor, the aggregator),
    so a workspace set to ``deleting`` gets nothing new while its hard delete runs (4d-1).

    One strongly consistent GetItem projected to ``STATUS_READ_ATTRIBUTES``, at most once per workspace per TTL in
    ``cache`` (``WorkspaceStatusCache``: 300 s for active, 30 s for not). A missing ``META`` and any other status
    answer False, and are cached too; a failed read raises and caches nothing, so the caller's record or run fails and
    is retried."""
    cached = cache.get(scope.ws)
    if cached is not None:
        return cached
    found = consistent_item(table, {'pk': control_partition(scope, 'meta'), 'sk': LOOKUP_SORT_KEY},
                            STATUS_READ_ATTRIBUTES)
    active = found is not None and found.get('status') == ACTIVE
    cache.put(scope.ws, active)
    return active


class WorkspaceStatusCheck:
    """A writer's status check (``workspace_is_active``), bound to its voc-workspaces table and a container's own
    cache: ``check(scope)``. The feedback processor and the aggregator each keep one at module level."""

    def __init__(self, table: Any, cache: WorkspaceStatusCache | None = None) -> None:
        self._table = table
        self._cache = cache or WorkspaceStatusCache()

    def __call__(self, scope: WorkspaceScope) -> bool:
        """Whether ``scope``'s workspace is active; a failed read raises (nothing cached)."""
        return workspace_is_active(self._table, scope, self._cache)


#: The folder of a workspace's exports (``ws/{ws}/exports/``) and the tag every object there carries: the raw
#: bucket's lifecycle rule expires an object with that tag (lib/stacks/core-buckets.ts), and its policy refuses the
#: tag on any key outside a workspace's exports, so it never reaches ``raw/`` or ``silver/``.
EXPORTS_FOLDER: Final = 'exports'
EXPORT_TAG_KEY: Final = 'voc-export'
EXPORT_TAGGING: Final = f'{EXPORT_TAG_KEY}=true'
#: S3's code for an upload that is no longer open (aborted, or completed).
_NO_SUCH_UPLOAD: Final = 'NoSuchUpload'
#: A work object's key under the exports: ``{export id}/work/{name}`` (the only objects the export job may delete).
EXPORTS_WORK_SEGMENTS: Final = ('{export id}', 'work', '{name}')
#: S3 lists at most this many parts a page (ListParts).
_LIST_PARTS_PAGE: Final = 1000


def exports_prefix(scope: WorkspaceScope) -> str:
    """``ws/{ws}/exports/``: every export object of the workspace starts with it."""
    return f'{s3_prefix(scope)}{EXPORTS_FOLDER}/'


class ExportObjects:
    """The workspace's export objects in one bucket, through one S3 client: every key under ``exports_prefix`` with
    no empty, ``.`` or ``..`` segment, checked before the call (``OutOfScopeError``). Every object it creates
    carries ``EXPORT_TAGGING``."""

    def __init__(self, scope: WorkspaceScope, s3: Any, bucket: str) -> None:
        if not bucket:
            raise ValueError('an export needs its bucket')
        self.scope = scope
        self._s3 = s3
        self._bucket = bucket

    def key(self, *parts: str) -> str:
        """``ws/{ws}/exports/a/b`` (``s3_key``'s segment rules)."""
        return s3_key(self.scope, EXPORTS_FOLDER, *parts)

    def _checked(self, key: object) -> str:
        prefix = exports_prefix(self.scope)
        if not isinstance(key, str) or not key.startswith(prefix):
            raise OutOfScopeError("a key outside the workspace's exports")
        if any(segment in ('', '.', '..') for segment in key[len(prefix):].split('/')):
            raise OutOfScopeError("a key outside the workspace's exports")
        return key

    def create_multipart_upload(self, key: str, content_type: str) -> str:
        """A new multipart upload of ``key`` (tagged); its upload id."""
        response = self._s3.create_multipart_upload(Bucket=self._bucket, Key=self._checked(key),
                                                    ContentType=content_type, Tagging=EXPORT_TAGGING)
        return str(response['UploadId'])

    def upload_part(self, key: str, upload_id: str, number: int, body: bytes) -> str:
        """Part ``number`` of the upload; its ETag."""
        response = self._s3.upload_part(Bucket=self._bucket, Key=self._checked(key), UploadId=upload_id,
                                        PartNumber=number, Body=body)
        return str(response['ETag'])

    def list_parts(self, key: str, upload_id: str) -> list[dict[str, Any]]:
        """Every uploaded part ``{PartNumber, ETag}``, in order, across ListParts' pages."""
        checked = self._checked(key)
        parts: list[dict[str, Any]] = []
        request: dict[str, Any] = {'Bucket': self._bucket, 'Key': checked, 'UploadId': upload_id,
                                   'MaxParts': _LIST_PARTS_PAGE}
        while True:
            response = self._s3.list_parts(**request)
            parts.extend({'PartNumber': int(part['PartNumber']), 'ETag': str(part['ETag'])}
                         for part in response.get('Parts') or [])
            if not response.get('IsTruncated'):
                return sorted(parts, key=lambda part: part['PartNumber'])
            request['PartNumberMarker'] = response['NextPartNumberMarker']

    def complete_multipart_upload(self, key: str, upload_id: str, parts: Sequence[Mapping[str, Any]]) -> None:
        self._s3.complete_multipart_upload(Bucket=self._bucket, Key=self._checked(key), UploadId=upload_id,
                                           MultipartUpload={'Parts': [dict(part) for part in parts]})

    def open_uploads(self) -> list[tuple[str, str]]:
        """Every multipart upload still open under the workspace's exports, ``(key, upload id)``, across
        ListMultipartUploads' pages (an erasure aborts them: voc-retention)."""
        request: dict[str, Any] = {'Bucket': self._bucket, 'Prefix': exports_prefix(self.scope)}
        found: list[tuple[str, str]] = []
        while True:
            response = self._s3.list_multipart_uploads(**request)
            found.extend((self._checked(upload['Key']), str(upload['UploadId']))
                         for upload in response.get('Uploads') or [])
            if not response.get('IsTruncated'):
                return found
            request.update(KeyMarker=response['NextKeyMarker'], UploadIdMarker=response['NextUploadIdMarker'])

    def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        """Abort an upload; one already gone (``NoSuchUpload``: aborted or completed since it was listed) is done.
        A completed one is a zip, which the caller's version delete removes (voc-retention lists after aborting)."""
        try:
            self._s3.abort_multipart_upload(Bucket=self._bucket, Key=self._checked(key), UploadId=upload_id)
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') != _NO_SUCH_UPLOAD:
                raise

    def put_work_object(self, key: str, body: bytes) -> None:
        """A work object of a running export (a zip tail, central-directory records), tagged like the zip."""
        self._s3.put_object(Bucket=self._bucket, Key=self._checked(key), Body=body, Tagging=EXPORT_TAGGING)

    def delete_work_object(self, key: str) -> None:
        """Delete a work object (``{export id}/work/{name}``) of an export that may not go on: never the zip, nothing
        else (the export job's role holds DeleteObject on ``ws/{one id}/exports/*/work/*`` only)."""
        checked = self._checked(key)
        segments = checked[len(exports_prefix(self.scope)):].split('/')
        if len(segments) != len(EXPORTS_WORK_SEGMENTS) or segments[1] != EXPORTS_WORK_SEGMENTS[1]:
            raise OutOfScopeError("not a work object of the workspace's exports")
        self._s3.delete_object(Bucket=self._bucket, Key=checked)

    def read_object(self, key: str) -> bytes:
        """The bytes of an export object (a work object the job saved)."""
        return bytes(self._s3.get_object(Bucket=self._bucket, Key=self._checked(key))['Body'].read())

    def presigned_download(self, key: str, filename: str, expires_in: int) -> str:
        """A presigned GET of ``key`` for ``expires_in`` seconds, downloaded as ``filename`` (an attachment)."""
        if not filename or any(char in filename for char in '"\\/\r\n'):
            raise ValueError('a download name is a plain file name')
        return str(self._s3.generate_presigned_url(
            'get_object', ExpiresIn=expires_in,
            Params={'Bucket': self._bucket, 'Key': self._checked(key),
                    'ResponseContentDisposition': f'attachment; filename="{filename}"'}))


#: S3 lists at most this many objects a page (ListObjectsV2).
_LIST_OBJECTS_PAGE: Final = 1000
#: S3's 403 codes (a GetObject of a missing key answers one to a role without an unconditioned ListBucket).
_ACCESS_DENIED: Final = frozenset({'AccessDenied', '403'})


@dataclass(frozen=True)
class ListedObject:
    """One current object of a workspace, as a listing shows it."""

    key: str
    size: int


@dataclass(frozen=True)
class ObjectPage:
    """One page of a workspace's objects (never its exports), and the key the next page starts after (None: done)."""

    objects: list[ListedObject]
    following: str | None


@dataclass(frozen=True)
class OpenedObject:
    """An object being read: its body (a stream: ``read(n)``), content type and size."""

    body: Any
    content_type: str
    size: int


class WorkspaceObjects:
    """The workspace's own objects in one bucket, read-only: every current object under ``s3_prefix`` except its
    exports (``exports_prefix``: the export's own zips and work objects are never read back into an export). Lists
    with ``Prefix`` ``ws/{ws}/`` only (the export job's ``s3:ListBucket`` holds that ``s3:prefix``), and reads a key
    only under it, outside the exports, with no empty, ``.`` or ``..`` segment (``OutOfScopeError`` before the
    call). Never writes, tags or deletes."""

    def __init__(self, scope: WorkspaceScope, s3: Any, bucket: str) -> None:
        if not bucket:
            raise ValueError('a workspace has its objects in a bucket')
        self.scope = scope
        self._s3 = s3
        self._bucket = bucket

    def list_page(self, start_after: str | None) -> ObjectPage:
        """One page (``_LIST_OBJECTS_PAGE``) of the workspace's current objects in key order, after ``start_after``
        (a key under the workspace, or None from the first), without its exports. A listed key outside the workspace
        is refused."""
        prefix = s3_prefix(self.scope)
        request: dict[str, Any] = {'Bucket': self._bucket, 'Prefix': prefix, 'MaxKeys': _LIST_OBJECTS_PAGE}
        if start_after is not None:
            if not start_after.startswith(prefix):
                raise OutOfScopeError('a listing cursor outside the workspace')
            request['StartAfter'] = start_after
        response = self._s3.list_objects_v2(**request)
        listed = [(str(entry['Key']), int(entry.get('Size') or 0)) for entry in response.get('Contents') or []]
        if any(not key.startswith(prefix) for key, _ in listed):
            raise OutOfScopeError('a listed key outside the workspace')
        exports = exports_prefix(self.scope)
        objects = [ListedObject(key, size) for key, size in listed if not key.startswith(exports)]
        following = listed[-1][0] if listed and response.get('IsTruncated') else None
        return ObjectPage(objects, following)

    def _checked(self, key: object) -> str:
        prefix = s3_prefix(self.scope)
        if (not isinstance(key, str) or not key.startswith(prefix) or key.startswith(exports_prefix(self.scope))
                or any(segment in ('', '.', '..') for segment in key[len(prefix):].split('/'))):
            raise OutOfScopeError("a key outside the workspace's own objects")
        return key

    def open(self, key: str) -> OpenedObject | None:
        """``key``'s current version (its body a stream), or None when it is gone since it was listed.

        S3 answers a GetObject of a missing key 403 (``AccessDenied``), not 404, to a role without an unconditioned
        ``s3:ListBucket`` (this one lists only with its ``s3:prefix``). So a 403 is checked: a listing of exactly
        that key (``Prefix`` the key, one result, which the prefix condition allows) that does not find it means the
        key is gone; one that finds it means the 403 is real, raised as it came."""
        checked = self._checked(key)
        try:
            response = self._s3.get_object(Bucket=self._bucket, Key=checked)
        except ClientError as error:
            code = error.response.get('Error', {}).get('Code')
            if code in S3_MISSING_KEY_CODES or (code in _ACCESS_DENIED and not self._still_listed(checked)):
                return None
            raise
        return OpenedObject(response['Body'], str(response.get('ContentType') or ''),
                            int(response.get('ContentLength') or 0))

    def _still_listed(self, key: str) -> bool:
        """Whether ``key`` itself is still a current object (not merely a prefix of another key)."""
        response = self._s3.list_objects_v2(Bucket=self._bucket, Prefix=key, MaxKeys=1)
        return any(entry.get('Key') == key for entry in response.get('Contents') or [])


def partition_query(partition_attribute: str, partition: str, sort_condition: str | None,
                    kwargs: Mapping[str, Any]) -> dict[str, Any]:
    """The Query request of one partition: ``#p = :p`` (then ``AND {sort_condition}``), merged with the names and
    values the caller's ``kwargs`` bring and the rest of them. Checks nothing: ``WorkspaceTable.query`` checks the
    partition first; shared/ingest_tables.py's deployment-wide table builds the same request."""
    request = dict(kwargs)
    names = {**(request.pop('ExpressionAttributeNames', None) or {}), '#p': partition_attribute}
    values = {**(request.pop('ExpressionAttributeValues', None) or {}), ':p': partition}
    condition = '#p = :p' + (f' AND {sort_condition}' if sort_condition else '')
    return {'KeyConditionExpression': condition, 'ExpressionAttributeNames': names,
            'ExpressionAttributeValues': values, **request}


class WorkspaceTable:
    """A DynamoDB table seen through one workspace: every key, item and query must be in the scope.

    Only the calls the data path makes. A key or item whose partition (``pk``, ``source`` or an index partition
    attribute it carries) is outside the scope raises ``OutOfScopeError`` before anything reaches DynamoDB.

    The multi-item calls (``transact_write_items``, ``batch_get_item``, ``batch_writer``; a ``TransactGetItems``
    comes with its first caller) act on this one table only and check every entry as the single-item calls do. They go through the table's own
    client (``table.meta.client``): a resource's client takes and returns plain Python values, as ``put_item`` does
    (shared/batch_get.py relies on the same), so the view only fills in ``TableName``.
    """

    def __init__(self, scope: WorkspaceScope, table: Any, key: str = 'pk') -> None:
        if key not in TABLE_PARTITION_KEYS:
            raise ValueError('a data-path table is keyed on pk or source')
        self.scope = scope
        self.key_attribute = key
        self._table = table

    def _check_key(self, key: Mapping[str, Any]) -> None:
        if not self.scope.owns(key.get(self.key_attribute)):
            raise OutOfScopeError('a key outside the workspace')

    def check_keys(self, keys: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """``keys`` as plain dicts once every one is in the scope (``OutOfScopeError`` otherwise): a caller's own
        ``BatchGetItem`` names only keys of the workspace (``batch_get_item`` makes one through the view)."""
        checked = [dict(key) for key in keys]
        for key in checked:
            self._check_key(key)
        return checked

    def _check_item(self, item: Mapping[str, Any]) -> None:
        self._check_key(item)
        for attribute in PARTITION_ATTRIBUTES:
            # ``source`` is voc-watermarks' key and no index's partition (test_ws_repo pins both against
            # core-stack.ts): on a table keyed on ``pk`` it is a plain attribute (an import run's source label).
            # On voc-watermarks (keyed on ``source``) every partition attribute an item carries must be in scope.
            if attribute == WATERMARK_PARTITION and self.key_attribute == 'pk':
                continue
            if attribute in item and not self.scope.owns(item[attribute]):
                raise OutOfScopeError(f'{attribute} outside the workspace')

    def get_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        self._check_key(key)
        return self._table.get_item(Key=dict(key), **kwargs)

    def put_item(self, item: Mapping[str, Any], **kwargs: Any) -> dict:
        self._check_item(item)
        return self._table.put_item(Item=dict(item), **kwargs)

    def delete_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        self._check_key(key)
        return self._table.delete_item(Key=dict(key), **kwargs)

    def update_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        """``UpdateItem`` of a key in the scope.

        Every partition attribute the ``UpdateExpression`` names, directly or through an
        ``ExpressionAttributeNames`` alias, must be SET from one placeholder (``gsi2pk = :g``) whose value is in
        the scope; any other use of one (a ``REMOVE``, ``if_not_exists``, arithmetic, a list append) is refused,
        because its value could not be checked here.
        """
        self.check_update(key, **kwargs)
        return self._table.update_item(Key=dict(key), **kwargs)

    def check_update(self, key: Mapping[str, Any], **kwargs: Any) -> None:
        """``update_item``'s checks without the call (``OutOfScopeError`` when one fails): a caller that sends the
        same update inside a ``TransactWriteItems`` (the aggregator's arrivals) checks each ``Update`` here first."""
        self._check_key(key)
        expression = kwargs.get('UpdateExpression')
        names = kwargs.get('ExpressionAttributeNames') or {}
        values = kwargs.get('ExpressionAttributeValues') or {}
        if not isinstance(expression, str):
            raise OutOfScopeError('an update needs an UpdateExpression')
        for attribute in PARTITION_ATTRIBUTES:
            for spelling in _spellings(attribute, names):
                for match in _mentions(spelling, expression):
                    assigned = _ASSIGNED_PLACEHOLDER.match(expression, match.end())
                    if assigned is None or not self.scope.owns(values.get(assigned.group(1))):
                        raise OutOfScopeError(f'{attribute} outside the workspace')

    def query(self, partition_attribute: str, partition: str, *, sort_condition: str | None = None,
              **kwargs: Any) -> dict:
        """One page of a Query of partition ``partition`` (in the scope) on ``partition_attribute``.

        The key condition is built here (``#p = :p``, then ``AND {sort_condition}`` when given, whose own names
        and values go in ``ExpressionAttributeNames`` / ``ExpressionAttributeValues``), so no caller can query an
        index without the workspace prefix.
        """
        if not self.scope.owns(partition):
            raise OutOfScopeError('a query outside the workspace')
        if 'KeyConditionExpression' in kwargs:
            raise OutOfScopeError('the key condition is built by the layer')
        start = kwargs.get('ExclusiveStartKey')
        # A cursor a client sent back: every partition attribute it names must be in the scope too.
        if start is not None and (not isinstance(start, Mapping) or any(
                attribute in start and not self.scope.owns(start[attribute]) for attribute in PARTITION_ATTRIBUTES)):
            raise OutOfScopeError('a cursor outside the workspace')
        return self._table.query(**partition_query(partition_attribute, partition, sort_condition, kwargs))

    def iter_query(self, partition_attribute: str, partition: str, *, sort_condition: str | None = None,
                   max_items: int | None = None, **kwargs: Any) -> Iterator[dict]:
        """Every item of ``query`` across its pages (at most ``max_items``; shared/dynamo_paging.py pages)."""
        return iter_query(_BoundQuery(self, partition_attribute, partition, sort_condition), kwargs,
                          max_items=max_items)

    def transact_write_items(self, items: Sequence[Mapping[str, Any]], **kwargs: Any) -> dict:
        """One ``TransactWriteItems`` on this table: 1 to 100 entries, each ``{'Put': {'Item': …}}``,
        ``{'Update': {'Key': …, 'UpdateExpression': …}}``, ``{'Delete': {'Key': …}}`` or
        ``{'ConditionCheck': {'Key': …, 'ConditionExpression': …}}`` (plain Python values, no ``TableName``).

        Each item is checked as ``put_item`` checks it, each key as ``get_item`` does, each ``Update`` as
        ``check_update`` does; one entry outside the scope refuses the whole transaction before it is sent, so
        nothing of it is written. Only ``ClientRequestToken``, ``ReturnConsumedCapacity`` and
        ``ReturnItemCollectionMetrics`` are passed on.
        """
        options = _checked_options('TransactWriteItems', kwargs, _TRANSACT_WRITE_OPTIONS)
        entries = list(items)
        if not 1 <= len(entries) <= MAX_TRANSACT_ITEMS:
            raise ValueError(f'a TransactWriteItems takes 1 to {MAX_TRANSACT_ITEMS} entries, not {len(entries)}')
        checked = [self._checked_write(entry) for entry in entries]
        self._refuse_duplicates('TransactWriteItems',
                                [body.get('Key') or body['Item'] for entry in checked for body in entry.values()])
        return self._table.meta.client.transact_write_items(TransactItems=checked, **options)

    def batch_get_item(self, keys: Iterable[Mapping[str, Any]], **kwargs: Any) -> list[dict]:
        """Every item found for ``keys`` (all in the scope, none twice), in any order; a missing key is simply absent.

        shared/batch_get.py ``batch_get_all`` sends it: requests of up to 100 keys, each request's
        ``UnprocessedKeys`` retried with a jittered backoff, ``BATCH_GET_ATTEMPTS`` calls in all, then
        ``UnprocessedKeysError``. ``ProjectionExpression`` and ``ExpressionAttributeNames`` are passed on; reads are
        strongly consistent unless ``ConsistentRead=False``.
        """
        options = _checked_options('BatchGetItem', kwargs, _BATCH_GET_OPTIONS)
        checked = self.check_keys(keys)
        self._refuse_duplicates('BatchGetItem', checked)
        failure = UnprocessedKeysError(f'BatchGetItem left keys unprocessed after {BATCH_GET_ATTEMPTS} calls')
        return batch_get_all(self._table, checked, failure=failure, read_options=options)

    def batch_writer(self) -> WorkspaceBatchWriter:
        """``table.batch_writer()`` through the view (a context manager): each ``put_item(Item=…)`` is checked as
        ``put_item`` checks it before it is buffered. Puts only for now (``WorkspaceBatchWriter``)."""
        return WorkspaceBatchWriter(self._check_item, self._table.batch_writer())

    def _checked_write(self, entry: object) -> dict[str, Any]:
        """One ``TransactItems`` entry, checked, with the view's ``TableName``."""
        if not isinstance(entry, Mapping) or len(entry) != 1:
            raise ValueError(f'a transaction entry is one of {", ".join(_TRANSACT_ACTIONS)}')
        [(action, body)] = entry.items()
        if action not in _TRANSACT_ACTIONS or not isinstance(body, Mapping):
            raise ValueError(f'a transaction entry is one of {", ".join(_TRANSACT_ACTIONS)}')
        request = dict(body)
        if 'TableName' in request:
            raise OutOfScopeError('a transaction entry never names its table: the view sends it to its own')
        if action == 'Put':
            item = _required(request, 'Item', action)
            self._check_item(item)
            request['Item'] = dict(item)
        else:
            key = _required(request, 'Key', action)
            if action == 'Update':
                self.check_update(key, **{field: value for field, value in request.items() if field != 'Key'})
            else:
                self._check_key(key)
            if action == 'ConditionCheck' and not isinstance(request.get('ConditionExpression'), str):
                raise ValueError('a ConditionCheck entry needs its ConditionExpression')
            request['Key'] = dict(key)
        return {action: {**request, 'TableName': self._table.name}}

    def _key_identity(self, key: Mapping[str, Any]) -> tuple[str, str]:
        """The item a key or an item names: its partition and, on a ``pk`` table, its ``sk``."""
        sort_key = key.get('sk') if self.key_attribute == 'pk' else None
        return repr(key.get(self.key_attribute)), repr(sort_key)

    def _refuse_duplicates(self, call: str, keys: Iterable[Mapping[str, Any]]) -> None:
        """DynamoDB refuses one call naming an item twice: refused here first (ValueError), naming the item."""
        seen: set[tuple[str, str]] = set()
        for key in keys:
            identity = self._key_identity(key)
            if identity in seen:
                partition, sort_key = identity
                raise ValueError(f'a {call} names one item twice: {self.key_attribute} {partition}, sk {sort_key}')
            seen.add(identity)


class _BoundQuery:
    """One partition's ``WorkspaceTable.query`` with the ``table.query(**kwargs)`` shape the pager calls."""

    def __init__(self, table: WorkspaceTable, partition_attribute: str, partition: str,
                 sort_condition: str | None) -> None:
        self._table = table
        self._partition_attribute = partition_attribute
        self._partition = partition
        self._sort_condition = sort_condition

    def query(self, **kwargs: Any) -> dict:
        return self._table.query(self._partition_attribute, self._partition, sort_condition=self._sort_condition,
                                 **kwargs)


class WorkspaceBatchWriter:
    """``WorkspaceTable.batch_writer()``: boto3's batch writer of the view's table, each item checked before it is
    buffered, so an item outside the scope is refused before any BatchWriteItem carries it. The refusal does not
    undo the puts before it: leaving the ``with`` block on any exception still flushes what is buffered (boto3's
    writer flushes in ``__exit__`` whatever ended the block), so a caller that needs all or nothing uses
    ``transact_write_items``.

    Puts only. ``delete_item`` is refused for now: the workspace's hard delete (phase 4, docs/multi-workspace.md
    "Export and delete") adds a checked batch delete; until then a delete goes one key at a time through
    ``WorkspaceTable.delete_item``.
    """

    def __init__(self, check_item: Callable[[Mapping[str, Any]], None], writer: Any) -> None:
        self._check_item = check_item
        self._writer = writer

    def __enter__(self) -> Self:
        self._writer.__enter__()
        return self

    def __exit__(self, *exc_info: object) -> None:
        # boto3's writer flushes what is buffered on the way out.
        self._writer.__exit__(*exc_info)

    def put_item(self, *, Item: Mapping[str, Any]) -> None:
        self._check_item(Item)
        self._writer.put_item(Item=dict(Item))

    def delete_item(self, **_kwargs: Any) -> NoReturn:
        raise OutOfScopeError('a batch delete is not part of the workspace layer yet: delete one key at a time '
                              'with WorkspaceTable.delete_item')


def _checked_options(call: str, kwargs: Mapping[str, Any], allowed: frozenset[str]) -> dict[str, Any]:
    """A multi-item call's options: refused when one names a table (the view sends to its own), or is not passed on."""
    if any(field in kwargs for field in _TABLE_FIELDS):
        raise OutOfScopeError(f'a {call} never names its table: the view sends it to its own')
    unknown = sorted(set(kwargs) - allowed)
    if unknown:
        raise ValueError(f'a {call} through the workspace layer does not take {", ".join(unknown)}')
    return dict(kwargs)


def _required(request: Mapping[str, Any], field: str, action: str) -> Mapping[str, Any]:
    value = request.get(field)
    if not isinstance(value, Mapping):
        raise ValueError(f'a {action} entry needs its {field}')
    return value


def _spellings(attribute: str, names: Mapping[str, Any]) -> list[str]:
    """``attribute`` as an expression can name it: itself, or each ``#alias`` mapped to it."""
    return [attribute, *(alias for alias, name in names.items() if name == attribute)]


def _mentions(spelling: str, expression: str) -> Iterator[re.Match[str]]:
    """Each place ``expression`` names ``spelling`` as a top-level attribute (not a part of another name, a
    placeholder, or a nested ``a.b`` path)."""
    return re.finditer(rf'(?<![\w#:.]){re.escape(spelling)}(?![\w.])', expression)


def ws_table(scope: WorkspaceScope, table: Any, key: str = 'pk') -> WorkspaceTable:
    """``table`` seen through ``scope`` (``WorkspaceTable``); ``key`` is its partition key (``source`` for
    voc-watermarks)."""
    return WorkspaceTable(scope, table, key)
