"""The workspace-scoped repository layer of the data path (docs/multi-workspace.md, "Request flow", step 4).

Every partition key of the data path starts with ``WS#{ws}#`` and every object key with ``ws/{ws}/``, so a team
only ever reads and writes its own rows and objects. This module is the one place those keys are built:

* ``WorkspaceScope``: a verified workspace. Made only from what the server trusts: the request's resolved
  membership (``scope_of``, after shared/workspace.py ``resolve_workspace``), an asynchronous message's
  ``workspace_id`` field (``scope_from_message``: SQS bodies, Lambda async payloads, an erasure job's row, written by
  our own code from a scope; ``event_scope`` for a project job's or an agent run's worker, whose state machine
  states carry it in a ``run_scope`` object), a stored partition key (``scope_from_key``: DynamoDB Stream records; ``partition_scope`` for a
  worker that reads both kinds of row, None for a deployment-wide one), or a stored control-plane routing row
  (``scope_from_lookup``: a public route's ``FORM#{id}``, a webhook's workspace ``META``, read by
  shared/workspace_routing.py). Never from a request field.
* Key builders: ``feedback_key`` and the feedback indexes' partitions (``date_pk``, ``category_pk``,
  ``urgency_pk``, ``feedback_id_pk``, ``channel_pk``), ``metric_pk`` / ``metric_type``, ``watermark_key``,
  ``source_run_pk``, ``scraper_run_pk``, ``erasure_job_pk``, ``reprocess_job_pk``, ``export_job_pk``, ``conversants_pk`` (the
  workspace's conversation owners, shared/conversations.py) and ``s3_key`` for objects (``s3_prefix`` their common ``ws/{ws}/``), ``plugin_config_key`` (a plugin's config list; ``plugin_config_history_key`` a list it replaced; the
  credentials parameters' names are shared/workspace_ids.py ``credentials_parameter_name``).
* ``ws_table``: a table that refuses any key, item, update, query or scan outside the scope's partitions (every index
  partition of voc-feedback is one of ``PARTITION_ATTRIBUTES``: gsi4 and gsi5 are keyed on ``gsi4pk`` / ``gsi5pk``,
  no longer on the raw ``feedback_id`` and ``source_channel``), also in its multi-item calls on that one table
  (``transact_write_items``, ``batch_get_item``, ``batch_writer``): a caller never names a table, and one entry
  outside the scope refuses the whole call before anything is sent. Each call, and each entry of a transaction,
  takes only the boto3 parameters listed for it (``ALLOWED_OPTIONS``, ``_TRANSACT_ENTRY_FIELDS``): a ``TableName``
  (which boto3 would let override the table), the legacy ``AttributeUpdates``, ``Expected``, ``KeyConditions``,
  ``QueryFilter``, ``ConditionalOperator`` and ``AttributesToGet``, or any other is refused before DynamoDB. A
  table's scope, key and handle are fixed once built (``__slots__``, read-only properties);
  shared/test/test_ws_raw_access.py counts any use of the private handle, ``_unscoped_table``, outside this layer.
* ``control_query``: one read-only Query page of the workspace's two control-plane partitions in voc-workspaces,
  ``WS#{ws}`` (``META`` and the ``MEMBER#`` rows) and ``AUDIT#WS#{ws}``, which the layer builds itself (they are not
  ``WS#{ws}#…`` keys, so ``ws_table`` refuses them). The export job's reader (phase 4).
* ``claim_project_id`` / ``project_claim`` / ``release_project_claim``: the deployment-wide claim of a project id
  made in a workspace, ``PROJECT_ID#{id}`` / ``CLAIM`` in voc-projects (docs/multi-workspace.md, the project plan,
  3a): an ``OutsideEntry`` of kind ``claim`` the layer builds and puts (only if absent) inside the workspace's own
  transaction (``WorkspaceTable.transact_write_items``'s ``outside``), its strongly consistent read, and its
  conditional delete. One of the two keys outside a workspace the layer writes for one; as a caller's own entry,
  ``ws_table`` refuses it.
* ``route_share_id`` / ``read_share_route`` / ``release_share_route``: the other one (since 7.37.00, 3e), a review
  link's deployment-wide routing row ``DOCSHARE#{id}`` / ``META`` naming the workspace the link is kept in: an
  ``OutsideEntry`` of kind ``route`` (with the link's ``ttl``) put the same way, the one GetItem the reviewer routes
  send (a row naming no workspace is the deployment's link itself), and its conditional delete. The one ``outside``
  parameter takes one entry, so a transaction holds at most one outside its workspace.
* ``ExportObjects``: the workspace's export objects, ``ws/{ws}/exports/…`` only (``exports_prefix``): the multipart
  upload of an export's zip, its work objects (each tagged ``voc-export=true``, which the raw bucket's lifecycle
  expires and its policy refuses anywhere else) and a presigned download of the zip. Any key outside the prefix is
  refused before any call reaches S3.
* ``workspace_is_active``: the one status check of every writer of a workspace's data (the scheduled fan-out, an
  ingestor's run, the processor, the aggregator; 4d-1): a GetItem of ``META`` limited to its status, cached per
  container in a ``WorkspaceStatusCache`` (300 s an active answer, 30 s a not-active one; ``WorkspaceStatusCheck``
  binds it to a table). ``watermark_directory_key``: the voc-aggregates row that lists a
  workspace's watermark, so its voc-watermarks rows are found without a Scan.
* For the hard delete (4d-2, lambda/jobs/workspace_delete/), which runs only once the workspace is ``deleting``:
  ``WorkspaceTable.batch_delete`` (checked BatchWriteItem deletes), ``WorkspaceObjectVersions`` (every version, delete
  marker and open upload under ``ws/{ws}/``, listed and deleted by version id), ``WorkspaceControlRows`` (the
  workspace's ``META``, ``MEMBER#``, ``USER#``, ``FORM#``, ``PLUGIN#`` and listing rows of voc-workspaces, each one
  key shape), ``WorkspaceTombstones`` (a deleted item's or memory's tombstone, a conditional put of a new key in
  ``AUDIT#tombstone#{kind}`` / ``{ws}#{id}``) and ``delete_work_pk`` (the job's own inventory partition).

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
                    pk WS#{ws}#JOB#category_reprocess (a workspace's category reprocess jobs and their lock)
                    pk WS#{ws}#JOB#export (a workspace's export jobs and their lock, shared/export_jobs.py)
                    pk WS#{ws}#PLUGIN_CONFIG  sk {plugin} (a plugin's config list, shared/plugin_configs.py)
                    pk WS#{ws}#PLUGIN_CONFIG#HISTORY  sk {plugin}#{iso}#{random} (a replaced list, kept, no ttl)
                    pk WS#{ws}#WATERMARK_KEYS  sk {plugin}#{key} (lists a watermark, ``watermark_directory_key``)
                    pk WS#{ws}#DELETE#PARTITIONS  sk {kind}#{name} (the hard delete's inventory, ``delete_work_pk``)
                    pk AUDIT#tombstone#{kind}  sk {ws}#{id} (a deleted item's or memory's, ``WorkspaceTombstones``)
                    pk WS#{ws}#USERCTX_SUBS  sk {sub} (who saved objectives, ``user_context_owners_pk``)
    voc-watermarks  source WS#{ws}#{plugin}#{key}
    voc-conversations  pk WS#{ws}#USER#{sub}  sk CONV#{id}, RUNCANCEL#{id} (a member's own conversations there)
                    pk WS#{ws}#CONVERSANTS  sk {sub} (who has kept a conversation there, shared/conversations.py)
    voc-memory      pk WS#{ws}#MEM#company  sk MEM#{memory_id}   gsi1pk WS#{ws}#MEMSTATUS#{scope}#{status}
                    pk WS#{ws}#MEMEVT#{memory_id}, WS#{ws}#MEMCURSOR, WS#{ws}#MEMIMPORT (shared/memory_store.py)
    voc-workspaces  pk WS#{ws} (META, MEMBER#{sub}), pk AUDIT#WS#{ws}: read by ``control_query``; META's status by
                    ``workspace_is_active``; the rows ``WorkspaceControlRows`` deletes (its docstring)
    voc-projects    pk PROJECT_ID#{project id}  sk CLAIM (deployment-wide: ``claim_project_id``, ``project_claim``,
                    ``release_project_claim``)
                    pk DOCSHARE#{share id}  sk META (deployment-wide; a workspace's link's route: ``route_share_id``,
                    ``read_share_route``, ``release_share_route``)
    raw bucket      ws/{ws}/raw/{source}/{yyyy}/{mm}/{dd}/{stem}/{sha16}.json, ws/{ws}/silver/..., ws/{ws}/...,
                    ws/{ws}/exports/{export id}/… (``ExportObjects``)
    SSM parameters  {prefix}/{ws}/credentials/{plugin} (prefix /voc/ws, /<deployment prefix>-voc/ws in a prefixed
                    deployment; decision 19)
"""
from __future__ import annotations

import os
import re
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, NamedTuple, NoReturn, Protocol, Self

from boto3.dynamodb.conditions import Attr, ConditionBase
from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

from shared import usage_meter
from shared.aws import S3_MISSING_KEY_CODES, consistent_item, is_conditional_check_failure
from shared.batch_get import BATCH_GET_ATTEMPTS, batch_get_all, unprocessed_backoff
from shared.dynamo_paging import iter_query
from shared.review_share_audience import is_share_id, routing_of, share_key
from shared.row_ids import LONG_OPAQUE_ID_RE
from shared.trial_state import unchanged_check, unpaused_check
from shared.workspace_ids import ACTIVE, WORKSPACE_FIELD, is_workspace_id, ws_key
from shared.workspace_plugins import WORKSPACE_SORT_PREFIX, plugin_partition

__all__ = [
    'FORM_LOOKUP_PREFIX',
    'OUTSIDE_ENTRY_INDEX',
    'PARTITION_ATTRIBUTES',
    'STATUS_READ_ATTRIBUTES',
    'TOMBSTONE_PARTITION_PREFIX',
    'WORKSPACE_FIELD',
    'WORKSPACE_KEY_PREFIX',
    'ExportObjects',
    'ListedObject',
    'ObjectVersion',
    'OutOfScopeError',
    'OutsideEntry',
    'WorkspaceControlRows',
    'WorkspaceObjectVersions',
    'WorkspaceObjects',
    'WorkspaceScope',
    'WorkspaceStatusCheck',
    'WorkspaceTable',
    'WorkspaceTombstones',
    'category_pk',
    'channel_pk',
    'claim_project_id',
    'control_query',
    'conversants_pk',
    'date_pk',
    'delete_work_pk',
    'erasure_job_pk',
    'event_scope',
    'export_job_pk',
    'exports_prefix',
    'feedback_id_pk',
    'feedback_key',
    'has_plain_segments',
    'is_workspace_key',
    'memory_company_pk',
    'memory_cursor_pk',
    'memory_event_pk',
    'memory_import_pk',
    'memory_status_pk',
    'message_scope',
    'metric_pk',
    'metric_type',
    'optional_scope',
    'partition_query',
    'partition_scope',
    'plugin_config_history_key',
    'plugin_config_history_pk',
    'plugin_config_key',
    'plugin_config_pk',
    'project_claim',
    'read_share_route',
    'release_project_claim',
    'release_share_route',
    'reprocess_job_pk',
    'require_scope',
    'route_share_id',
    's3_key',
    's3_prefix',
    'scope_from_key',
    'scope_from_lookup',
    'scope_from_message',
    'scope_of',
    'scraper_run_pk',
    'source_run_pk',
    'urgency_pk',
    'user_context_owners_pk',
    'watermark_directory_key',
    'watermark_key',
    'ws_table',
]

#: The field every state of a project job's state machine (voc-document-workflow, voc-research-workflow) and of
#: voc-agent-run passes its Lambda the run's workspace in (since 7.29.00): an object, ``{}`` for a run of the
#: deployment, ``{workspace_id}`` for a workspace's. Its first states set it from the execution's input (an
#: ``IsPresent`` choice), because a JSONPath parameter whose path the input lacks fails the state, so the input of a
#: deployment run stays as it was.
RUN_SCOPE_FIELD: Final = 'run_scope'
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
_WRITE_OPTIONS: Final = frozenset({'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues',
                                   'ReturnValues', 'ReturnConsumedCapacity', 'ReturnItemCollectionMetrics',
                                   'ReturnValuesOnConditionCheckFailure'})
#: The boto3 parameters each ``WorkspaceTable`` call passes on (its key, item or partition aside); any other is
#: refused: ``TableName`` (boto3 lets a call's own one override the table's), the legacy ``AttributeUpdates``,
#: ``Expected``, ``KeyConditions``, ``QueryFilter``, ``ConditionalOperator`` and ``AttributesToGet`` (none of which
#: the layer checks), and a ``Key`` or ``Item`` beside the checked one.
ALLOWED_OPTIONS: Final[Mapping[str, frozenset[str]]] = {
    'get_item': frozenset({'ConsistentRead', 'ProjectionExpression', 'ExpressionAttributeNames',
                           'ReturnConsumedCapacity'}),
    'put_item': _WRITE_OPTIONS,
    'delete_item': _WRITE_OPTIONS,
    'update_item': _WRITE_OPTIONS | {'UpdateExpression'},
    'query': frozenset({'IndexName', 'Limit', 'ExclusiveStartKey', 'ScanIndexForward', 'ConsistentRead',
                        'ProjectionExpression', 'FilterExpression', 'ExpressionAttributeNames',
                        'ExpressionAttributeValues', 'Select', 'ReturnConsumedCapacity'}),
    # The filter is a boto3 condition (``Attr``), ANDed with the scope's own: no names or values of its own.
    'scan': frozenset({'Limit', 'ExclusiveStartKey', 'FilterExpression', 'ConsistentRead', 'ReturnConsumedCapacity'}),
}
#: DynamoDB's ceiling on the entries of one TransactWriteItems.
MAX_TRANSACT_ITEMS: Final = 100
#: The entries a TransactWriteItems takes, and the options passed on (every other one is refused).
_TRANSACT_ACTIONS: Final = ('Put', 'Update', 'Delete', 'ConditionCheck')
_TRANSACT_WRITE_OPTIONS: Final = frozenset({'ClientRequestToken', 'ReturnConsumedCapacity',
                                            'ReturnItemCollectionMetrics'})
_BATCH_GET_OPTIONS: Final = frozenset({'ProjectionExpression', 'ExpressionAttributeNames', 'ConsistentRead'})
_ENTRY_CONDITION_FIELDS: Final = frozenset({'ConditionExpression', 'ExpressionAttributeNames',
                                            'ExpressionAttributeValues', 'ReturnValuesOnConditionCheckFailure'})
#: The fields each TransactWriteItems entry takes (the ``ALLOWED_OPTIONS`` rule for a single call, per entry): a
#: legacy ``Expected`` or ``AttributeUpdates``, or anything else, is refused before the transaction is sent.
_TRANSACT_ENTRY_FIELDS: Final[Mapping[str, frozenset[str]]] = {
    'Put': _ENTRY_CONDITION_FIELDS | {'Item'},
    'Update': _ENTRY_CONDITION_FIELDS | {'Key', 'UpdateExpression'},
    'Delete': _ENTRY_CONDITION_FIELDS | {'Key'},
    'ConditionCheck': _ENTRY_CONDITION_FIELDS | {'Key'},
}
#: Request fields that name a table: the view fills in its own, a caller never names one.
_TABLE_FIELDS: Final = ('TableName', 'RequestItems')


class OutOfScopeError(ValueError):
    """A key, item or query outside the scope's partitions: a programming error, never a client's (500)."""


class UnprocessedKeysError(RuntimeError):
    """BatchGetItem still left keys unprocessed after ``BATCH_GET_ATTEMPTS`` calls (shared/batch_get.py): the read
    fails rather than quietly return fewer items."""


class UnprocessedItemsError(RuntimeError):
    """BatchWriteItem still left deletes unprocessed after ``BATCH_WRITE_ATTEMPTS`` calls
    (``WorkspaceTable.batch_delete``): the delete fails rather than quietly leave items behind."""


#: BatchWriteItem's ceiling of requests a call, and how many calls one request's unprocessed items get (the first
#: included) before ``UnprocessedItemsError``: the same bound and backoff as a BatchGetItem's (shared/batch_get.py).
MAX_BATCH_WRITE_ITEMS: Final = 25
BATCH_WRITE_ATTEMPTS: Final = BATCH_GET_ATTEMPTS


def _deleted_key(request: object) -> Mapping[str, Any]:
    """The key of a ``{'DeleteRequest': {'Key': …}}`` DynamoDB handed back unprocessed; OutOfScopeError for any other
    request (a batch delete sends deletes only)."""
    delete = request.get('DeleteRequest') if isinstance(request, Mapping) else None
    key = delete.get('Key') if isinstance(delete, Mapping) else None
    if not isinstance(key, Mapping):
        raise OutOfScopeError('a batch delete re-sends deletes only')
    return key


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


def optional_scope(context: ResolvedWorkspace | None) -> WorkspaceScope | None:
    """``scope_of`` a request's resolved membership, or None for a request that names none (the deployment's)."""
    return None if context is None else scope_of(context)


def scope_from_message(body: Mapping[str, Any]) -> WorkspaceScope:
    """The scope an asynchronous message names in ``workspace_id`` (written by our own code from a scope).

    ValueError when the field is missing or not a workspace id: such a message belongs to no workspace and is
    never processed under a guessed one.
    """
    value = body.get(WORKSPACE_FIELD)
    if not isinstance(value, str):
        raise ValueError('the message names no workspace')
    return WorkspaceScope(value)


def event_scope(event: Mapping[str, Any]) -> WorkspaceScope | None:
    """The workspace a project job's or an agent run's worker event names, or None for the deployment (since 7.29.00).

    Either shape: an asynchronous invoke's own ``workspace_id`` (written by shared/workspace_routing.py
    ``workspace_payload``), or a state machine state's ``run_scope`` object (``RUN_SCOPE_FIELD``). No field: the
    deployment, as before. ValueError for a field that is there but names no workspace (``scope_from_message``), a
    ``run_scope`` that is not an object, or an event that carries both: never run deployment-wide instead.
    """
    if RUN_SCOPE_FIELD in event:
        carried = event[RUN_SCOPE_FIELD]
        if WORKSPACE_FIELD in event or not isinstance(carried, Mapping):
            raise ValueError('the event names its workspace twice, or not in an object')
        event = carried
    return scope_from_message(event) if WORKSPACE_FIELD in event else None


def is_workspace_key(partition_key: object) -> bool:
    """Whether ``partition_key`` is a workspace's (``WS#…``), well formed or not: a deployment-wide reader skips
    it either way (``scope_from_key`` is the one that checks the workspace it names)."""
    return isinstance(partition_key, str) and partition_key.startswith(WORKSPACE_KEY_PREFIX)


def message_scope(body: object) -> tuple[bool, WorkspaceScope | None]:
    """``(refused, scope)`` of an asynchronous message on a path that serves both a workspace and the deployment.

    A message that names a workspace in ``workspace_id`` runs in it; one that names none (no such field) runs
    deployment-wide (``scope`` None); one whose field is there but is not a workspace id (``None`` included) is
    refused, never run deployment-wide instead.

    The message's Bedrock calls are counted (shared/usage_meter.py) to its workspace, to the deployment when it
    names none, and to no one when it is refused: UNATTRIBUTED is set first, so a refused record after a good one
    is never counted to the good one's workspace.
    """
    usage_meter.attribute(usage_meter.UNATTRIBUTED)
    if not isinstance(body, Mapping) or WORKSPACE_FIELD not in body:
        usage_meter.attribute(None)
        return False, None
    try:
        scope = scope_from_message(body)
    except ValueError:
        return True, None
    usage_meter.attribute(scope.ws)
    return False, scope


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


def reprocess_job_pk(scope: WorkspaceScope) -> str:
    """A workspace's category reprocess jobs and their lock (voc-aggregates, shared/reprocess_jobs.py):
    ``WS#{ws}#JOB#category_reprocess``."""
    return scope.key('JOB', 'category_reprocess')


def export_job_pk(scope: WorkspaceScope) -> str:
    """A workspace's export jobs and their lock (voc-aggregates, shared/export_jobs.py): ``WS#{ws}#JOB#export``."""
    return scope.key('JOB', 'export')


def user_context_owners_pk(scope: WorkspaceScope) -> str:
    """The list of the members who saved their own objectives in the workspace (voc-aggregates, shared/
    company_context.py ``put_my_context``, one row per person, ``sk`` their sub): ``WS#{ws}#USERCTX_SUBS``. A Query
    of it names every ``WS#{ws}#USERCTX#{sub}`` row, a former member's too (the hard delete's ``user_contexts``)."""
    return scope.key('USERCTX_SUBS')


def conversants_pk(scope: WorkspaceScope) -> str:
    """The list of the workspace's conversation owners in voc-conversations, one row per person who ever kept a
    conversation there (shared/conversations.py ``conversant_key``): ``WS#{ws}#CONVERSANTS``. A Query of it, knowing
    only the workspace id, names every ``WS#{ws}#USER#{sub}`` partition, a former member's too."""
    return scope.key('CONVERSANTS')


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


def delete_work_pk(scope: WorkspaceScope) -> str:
    """The hard delete's inventory of the workspace in voc-aggregates (lambda/jobs/workspace_delete/): the partitions
    and ids it found while it swept (``sk {kind}#{name}``), so a later sweep deletes them without a Scan:
    ``WS#{ws}#DELETE#PARTITIONS``. Written only by that job, deleted by it last."""
    return scope.key('DELETE', 'PARTITIONS')


def has_plain_segments(path: str) -> bool:
    """Whether every ``/``-separated segment of ``path`` is a name: none empty (no leading, trailing or doubled
    ``/``), ``.`` or ``..``, so the path names no other place than it reads. The one segment rule of the object keys
    the layer builds and checks (``s3_key``, ``ExportObjects``, ``WorkspaceObjects``) and of shared/avatar.py's."""
    return all(segment not in ('', '.', '..') for segment in path.split('/'))


def s3_key(scope: WorkspaceScope, *parts: str) -> str:
    """An object key inside the workspace: ``ws/{ws}/a/b``. Refuses empty, ``.`` and ``..`` segments."""
    segments = [segment for part in parts for segment in part.split('/')]
    if not segments or not has_plain_segments('/'.join(segments)):
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


def require_scope(workspace: object, refusal: str) -> None:
    """``OutOfScopeError(refusal)`` unless ``workspace`` is a ``WorkspaceScope``: a store typed for a workspace only
    refuses the deployment (None), a bare id or anything else at run time too."""
    if not isinstance(workspace, WorkspaceScope):
        raise OutOfScopeError(refusal)


#: The deployment-wide claim of a project id (voc-projects): ``PROJECT_ID#{id}`` / ``CLAIM``, naming the workspace
#: the project was made in (``WORKSPACE_FIELD``) and when (``claimed_at``). Outside every workspace by design: a
#: public link, the product-doc extractor or an MCP pin that knows only the id finds its workspace here, and no two
#: workspaces hold one id (docs/multi-workspace.md, the project plan, 3a). It is written only inside the scoped
#: transaction that writes the project's ``META`` and registry row (``WorkspaceTable.transact_write_items``'s
#: ``outside``), so it never exists without them. The deployment's creates never put one: a reader that knows only an
#: id looks up the deployment's ``PROJECT#{id}`` row as well as the claim, and refuses when both exist (3h).
PROJECT_CLAIM_PREFIX: Final = 'PROJECT_ID#'
PROJECT_CLAIM_SORT_KEY: Final = 'CLAIM'
#: Where the entry outside the workspace (a claim, a route) sits in its transaction: a held claim is the
#: cancellation reason at this index (shared/ids.py ``write_with_fresh_id(put_index=...)``).
OUTSIDE_ENTRY_INDEX: Final = 0
#: The environment variable naming voc-projects (shared/tables.py ``get_projects_table``): the one table an entry
#: outside a workspace is written in.
PROJECTS_TABLE_ENV: Final = 'PROJECTS_TABLE'
_NOT_THE_DEPLOYMENT: Final = 'a project claim names a workspace, never the deployment'
_ROUTE_NOT_THE_DEPLOYMENT: Final = 'a share route names a workspace, never the deployment'
_NOT_OURS: Final = "a transaction's entry outside its workspace is a project claim or a share route of its own workspace"
_OUTSIDE_TOKEN: Final = object()


def _project_claim_key(project_id: object) -> dict[str, str]:
    """``{pk, sk}`` of a project id's claim. The id must have the project id shape (``LONG_OPAQUE_ID_RE``: letters,
    digits, ``_`` and ``-``, no ``#``), so the key is a claim's and no other row's (``OutOfScopeError`` otherwise)."""
    if not isinstance(project_id, str) or not LONG_OPAQUE_ID_RE.fullmatch(project_id):
        raise OutOfScopeError('a project claim names a project id')
    return {'pk': f'{PROJECT_CLAIM_PREFIX}{project_id}', 'sk': PROJECT_CLAIM_SORT_KEY}


def _share_route_key(share_id: object) -> dict[str, str]:
    """``{pk, sk}`` of a review link id's routing row; the id must have the link id shape (``shr_`` + 32 hex), so the
    key is a link's and no other row's (``OutOfScopeError`` otherwise)."""
    if not is_share_id(share_id):
        raise OutOfScopeError('a share route names a review link id')
    return share_key(share_id)


class _OutsideKind(NamedTuple):
    """What one kind of entry outside a workspace is: its name, its key, the field its time is kept in, and the
    refusal of the deployment."""

    name: str
    key: Callable[[object], dict[str, str]]
    at_field: str
    not_the_deployment: str
    #: Whether the row expires (a ``ttl``, a positive epoch second): a route with its link, never a claim.
    expires: bool

    def ttl_fits(self, ttl: object) -> bool:
        """A claim's ``ttl`` is None; a route's a positive int (not a bool)."""
        if not self.expires:
            return ttl is None
        return isinstance(ttl, int) and not isinstance(ttl, bool) and ttl > 0


#: The two kinds of row outside every workspace the layer writes for one (docs/multi-workspace.md, the project plan):
#: a project id's claim (3a, kept for good) and a review link's routing row (3e, expiring with its link).
_OUTSIDE_KINDS: Final[Mapping[str, _OutsideKind]] = {
    'claim': _OutsideKind('project claim', _project_claim_key, 'claimed_at', _NOT_THE_DEPLOYMENT, expires=False),
    'route': _OutsideKind('share route', _share_route_key, 'routed_at', _ROUTE_NOT_THE_DEPLOYMENT, expires=True),
}


class OutsideEntry:
    """The one entry outside its workspace a ``WorkspaceTable.transact_write_items`` takes (its ``outside``): a
    project id's claim (``kind`` ``claim``, built only by ``claim_project_id``) or a review link's routing row
    (``route``, built only by ``route_share_id``). It holds the kind, the workspace, the id, the time and, for a
    route, the link's ``ttl``: never a key or an item, which the transaction builds itself
    (``WorkspaceTable._outside_entry``). Fixed once built, and never subclassed; one parameter takes one, so a
    transaction holds at most one entry outside its workspace."""

    __slots__ = ('_at', '_item_id', '_kind', '_scope', '_ttl')
    _at: str
    _item_id: str
    _kind: str
    _scope: WorkspaceScope
    _ttl: int | None

    def __init_subclass__(cls) -> NoReturn:
        raise TypeError('an OutsideEntry cannot be subclassed')

    def __init__(self, token: object, kind: str, scope: WorkspaceScope, item_id: str, at: str,
                 ttl: int | None = None) -> None:
        if token is not _OUTSIDE_TOKEN:
            raise TypeError('an outside entry is built by claim_project_id or route_share_id only')
        for name, value in (('_kind', kind), ('_scope', scope), ('_item_id', item_id), ('_at', at), ('_ttl', ttl)):
            object.__setattr__(self, name, value)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError('an OutsideEntry cannot be changed')

    def __delattr__(self, name: str) -> None:
        raise AttributeError('an OutsideEntry cannot be changed')

    @property
    def kind(self) -> str:
        """``claim`` or ``route``."""
        return self._kind

    @property
    def scope(self) -> WorkspaceScope:
        """The workspace the id is claimed for, or the link routed to."""
        return self._scope

    @property
    def item_id(self) -> str:
        """The project id claimed, or the link id routed."""
        return self._item_id

    @property
    def at(self) -> str:
        """When (the project's or the link's ``created_at``)."""
        return self._at

    @property
    def ttl(self) -> int | None:
        """A route's expiry (the link's own ``ttl``), so a dead route expires with its link; a claim's is None."""
        return self._ttl


def _outside(kind: str, item_id: str, workspace: WorkspaceScope, at: str, ttl: int | None = None) -> OutsideEntry:
    """An entry of ``kind`` for a real workspace only (``OutOfScopeError`` for the deployment or anything but a
    ``WorkspaceScope``, and for an id of another shape); nothing is sent here."""
    spec = _OUTSIDE_KINDS[kind]
    require_scope(workspace, spec.not_the_deployment)
    if not at:
        raise ValueError(f'a {spec.name} says when it was made')
    if not spec.ttl_fits(ttl):
        raise ValueError(f"a {spec.name}'s ttl is {'a positive epoch second' if spec.expires else 'none'}")
    spec.key(item_id)
    return OutsideEntry(_OUTSIDE_TOKEN, kind, workspace, item_id, at, ttl)


def claim_project_id(project_id: str, *, workspace: WorkspaceScope, claimed_at: str) -> OutsideEntry:
    """The claim of ``project_id`` for ``workspace``, to write in that workspace's transaction (``outside=``)."""
    return _outside('claim', project_id, workspace, claimed_at)


def project_claim(table: Any, project_id: str) -> WorkspaceScope | None:
    """The workspace ``project_id`` is claimed for, or None when no claim exists (a deployment project, or no
    project). A strongly consistent GetItem of the claim, projected to its workspace only. A claim that names no
    workspace id raises ValueError: it is never read as the deployment's.

    A caller uses the answer only to route: it then applies that workspace's own access check (its membership) to
    the caller before it reads or answers anything, and never echoes the workspace id it found.
    """
    response = table.get_item(Key=_project_claim_key(project_id), ConsistentRead=True,
                              ProjectionExpression='#ws', ExpressionAttributeNames={'#ws': WORKSPACE_FIELD})
    item = response.get('Item')
    if item is None:
        return None
    workspace_id = item.get(WORKSPACE_FIELD)
    if not is_workspace_id(workspace_id):
        raise ValueError('a project claim names no workspace')
    return WorkspaceScope(str(workspace_id))


def release_project_claim(table: Any, project_id: str, *, workspace: WorkspaceScope) -> bool:
    """Delete ``project_id``'s claim, only while it names ``workspace`` (the workspace's delete, 3g). False when there
    is no such claim (none, or another workspace's): nothing is deleted then."""
    return _release_naming(table, _project_claim_key, project_id, workspace, _NOT_THE_DEPLOYMENT)


def _release_naming(table: Any, key_of: Callable[[object], dict[str, str]], row_id: str, workspace: WorkspaceScope,
                    refusal: str) -> bool:
    """A DeleteItem of the row ``key_of(row_id)`` conditioned on it naming ``workspace`` (``WORKSPACE_FIELD``; a
    real workspace only, ``refusal`` otherwise): False, nothing deleted, when it does not (no row, a row naming
    none, another workspace's)."""
    require_scope(workspace, refusal)
    try:
        table.delete_item(Key=key_of(row_id), ConditionExpression='#ws = :ws',
                          ExpressionAttributeNames={'#ws': WORKSPACE_FIELD},
                          ExpressionAttributeValues={':ws': workspace.ws})
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
        raise
    return True


#: A review link made in a workspace (docs/multi-workspace.md, the project plan, 3e) keeps one deployment-wide routing
#: row, ``DOCSHARE#{share id}`` / ``META`` (shared/review_share_audience.py ``share_key``), naming its workspace
#: (``WORKSPACE_FIELD``), when (``routed_at``) and its expiry (``ttl``), nothing else: the link itself is the workspace's own row
#: (shared/project_keys.py ``review_link_key``). The board pool's PreSignUp trigger and the reviewer routes know only
#: the id, so they find the workspace here. A deployment's link IS its ``DOCSHARE#{id}`` row, which names no workspace,
#: as before. The routing row is written only inside the scoped transaction that writes the link and the workspace's
#: registry row (``WorkspaceTable.transact_write_items``'s ``outside``), so it never exists without them, and it
#: carries the link's own ``ttl``, so a dead route expires with its link.


def route_share_id(share_id: str, *, workspace: WorkspaceScope, routed_at: str, ttl: int) -> OutsideEntry:
    """The route of review link ``share_id`` to ``workspace``, expiring at ``ttl`` (the link's own), to write in that
    workspace's transaction (``outside=``)."""
    return _outside('route', share_id, workspace, routed_at, ttl)


class SharedLink(NamedTuple):
    """What a review link id's ``DOCSHARE#{id}`` row names (``read_share_route``): the deployment's link itself
    (``share``, ``scope`` None); a workspace's routing row (``scope``, ``share`` None: the link is that workspace's own
    row); or nothing (both None: no row, or a row naming anything but a workspace id, never read as the
    deployment's)."""

    share: dict[str, Any] | None
    scope: WorkspaceScope | None


def read_share_route(table: Any, share_id: str) -> SharedLink:
    """One strongly consistent GetItem of ``DOCSHARE#{share_id}`` / ``META`` in voc-projects (the request the
    deployment's reviewer routes always sent), read as shared/review_share_audience.py ``routing_of`` reads it: a row
    naming no workspace is the deployment's link, a routing row gives its workspace's scope (built here), and a row
    naming anything but a workspace id gives nothing, so the caller refuses it.

    A caller uses the scope only to route: it reads the link from that workspace (shared/project_keys.py
    ``review_link_key``), keeps it only when it is the link of this id (``routed_share``), and never echoes the
    workspace id it found."""
    response = table.get_item(Key=_share_route_key(share_id), ConsistentRead=True)
    share, workspace_id = routing_of(response.get('Item'))
    return SharedLink(share, None if workspace_id is None else WorkspaceScope(workspace_id))


def release_share_route(table: Any, share_id: str, *, workspace: WorkspaceScope) -> bool:
    """Delete review link ``share_id``'s routing row, only while it names ``workspace`` (the workspace's delete, its
    ``docshares`` entry). False when there is no such row (none, the deployment's own link, or another workspace's
    route): nothing is deleted then."""
    return _release_naming(table, _share_route_key, share_id, workspace, _ROUTE_NOT_THE_DEPLOYMENT)


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
#: ``META``, with its keys: those roles are held to these (lib/utils/workspace-resolution-grants.ts
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


#: The listing partition of every workspace in voc-workspaces (shared/platform_workspaces.py ``LISTING_PK``).
LISTING_PARTITION: Final = 'WORKSPACES'
#: A member's inverse row's partition (shared/workspace_members.py ``USER#{sub}`` / ``WS#{ws}``).
USER_PARTITION_PREFIX: Final = 'USER#'
#: A workspace's slug guard (shared/platform_workspaces.py): kept for good, marked deleted, so no slug is reused.
SLUG_PARTITION_PREFIX: Final = 'SLUG#'
#: The status a workspace's hard delete runs under (shared/workspace_deletes.py ``DELETING``).
DELETING: Final = 'deleting'
#: A delete of a row that names its workspace in ``workspace_id``: only this workspace's, or none (already gone).
_NAMES_THIS_WORKSPACE: Final = 'attribute_not_exists(pk) OR workspace_id = :ws'


def _plain_part(value: object, what: str) -> str:
    """``value`` when it is a non-empty string with no ``#`` (so it cannot reach another key shape); else ValueError."""
    if not isinstance(value, str) or not value or '#' in value:
        raise ValueError(f'a control row needs a plain {what}')
    return value


class WorkspaceControlRows:
    """The workspace's control-plane rows in voc-workspaces, one checked DeleteItem (or UpdateItem) each: used by the
    hard delete (4d-2), which runs only once the workspace is ``deleting``.

    Each method builds its one key shape from the scope and a plain part (no ``#``, so no other shape), and refuses
    anything else before any call. A missing row is done (DeleteItem of an absent key changes nothing). The rows that
    are keyed by another id (``FORM#{form id}``, the listing row, the slug guard) are changed only if they name THIS
    workspace (``workspace_id``): one naming another is ``OutOfScopeError``, nothing changed. ``META`` goes only while
    it reads ``deleting`` (an active workspace's ``META`` is never deleted). Every ``AUDIT#`` row stays::

        WS#{ws}           / {any but META}   delete_partition_row (MEMBER#{sub}, INVITE#{id})
        USER#{sub}        / WS#{ws}          delete_user_row
        FORM#{form id}    / META             delete_form_lookup (its workspace_id this one)
        PLUGIN#{plugin}   / WS#{ws}          delete_plugin_row
        WORKSPACES        / {name}#{ws}      delete_listing_row (its workspace_id this one)
        WS#{ws}           / META             delete_meta (its status deleting)
        SLUG#{slug}       / META             mark_slug_deleted (kept, ``deleted_at`` set; its workspace_id this one)
    """

    def __init__(self, scope: WorkspaceScope, table: Any) -> None:
        self.scope = scope
        self._table = table

    def delete_partition_row(self, sort_key: object) -> None:
        """Any row of the workspace's own ``WS#{ws}`` partition but ``META`` (a ``MEMBER#{sub}`` row, an invite): the
        partition is built from the scope, so only the sort key is the caller's. ``META`` goes by ``delete_meta``."""
        if not isinstance(sort_key, str) or not sort_key or sort_key == LOOKUP_SORT_KEY:
            raise ValueError('a partition row other than META needs its sort key')
        self._table.delete_item(Key={'pk': control_partition(self.scope, 'meta'), 'sk': sort_key})

    def delete_user_row(self, sub: str) -> None:
        self._table.delete_item(Key={'pk': f'{USER_PARTITION_PREFIX}{_plain_part(sub, "member")}',
                                     'sk': f'{WORKSPACE_SORT_PREFIX}{self.scope.ws}'})

    def delete_plugin_row(self, plugin: str) -> None:
        """``PLUGIN#{plugin}`` / ``WS#{ws}`` (shared/workspace_plugins.py ``plugin_partition``: ValueError for an id
        that is not a plugin id)."""
        self._table.delete_item(Key={'pk': plugin_partition(plugin), 'sk': f'{WORKSPACE_SORT_PREFIX}{self.scope.ws}'})

    def delete_form_lookup(self, form_id: str) -> None:
        self._change_naming_this_workspace(
            {'pk': f'{FORM_LOOKUP_PREFIX}{_plain_part(form_id, "form id")}', 'sk': LOOKUP_SORT_KEY})

    def delete_listing_row(self, sort_key: object) -> None:
        """The listing row ``WORKSPACES`` / ``{name}#{ws}`` as stored: a sort key that does not end with this
        workspace's id after a name is refused."""
        suffix = f'#{self.scope.ws}'
        if not isinstance(sort_key, str) or not sort_key.endswith(suffix) or len(sort_key) == len(suffix):
            raise OutOfScopeError("not this workspace's listing row")
        self._change_naming_this_workspace({'pk': LISTING_PARTITION, 'sk': sort_key})

    def delete_meta(self) -> None:
        """``WS#{ws}`` / ``META``, only while its status is ``deleting`` (gone already is done); ``OutOfScopeError``
        when it reads anything else (a cancelled delete's workspace is active again: nothing is deleted)."""
        try:
            self._table.delete_item(Key={'pk': control_partition(self.scope, 'meta'), 'sk': LOOKUP_SORT_KEY},
                                    ConditionExpression='attribute_not_exists(pk) OR #status = :deleting',
                                    ExpressionAttributeNames={'#status': 'status'},
                                    ExpressionAttributeValues={':deleting': DELETING})
        except ClientError as error:
            if is_conditional_check_failure(error):
                raise OutOfScopeError('the workspace is not being deleted') from error
            raise

    def mark_slug_deleted(self, slug: str, at: str) -> None:
        """Set ``deleted_at`` on the workspace's slug guard ``SLUG#{slug}`` / ``META`` and keep it: the slug stays
        reserved for good. Only a guard that names this workspace (``OutOfScopeError`` otherwise, also for none)."""
        try:
            self._table.update_item(
                Key={'pk': f'{SLUG_PARTITION_PREFIX}{_plain_part(slug, "slug")}', 'sk': LOOKUP_SORT_KEY},
                UpdateExpression='SET deleted_at = if_not_exists(deleted_at, :at)',
                ConditionExpression='workspace_id = :ws',
                ExpressionAttributeValues={':at': at, ':ws': self.scope.ws})
        except ClientError as error:
            if is_conditional_check_failure(error):
                raise OutOfScopeError("not this workspace's slug") from error
            raise

    def _change_naming_this_workspace(self, key: dict[str, str]) -> None:
        try:
            self._table.delete_item(Key=key, ConditionExpression=_NAMES_THIS_WORKSPACE,
                                    ExpressionAttributeValues={':ws': self.scope.ws})
        except ClientError as error:
            if is_conditional_check_failure(error):
                raise OutOfScopeError('a control row of another workspace') from error
            raise


#: Where every tombstone lives in voc-aggregates (under the audit-row guard, which pins ``AUDIT#*``): ``{kind}`` a
#: deleted item's source (jobs/retention/copies.py ``tombstone_key``) or ``memory``.
TOMBSTONE_PARTITION_PREFIX: Final = 'AUDIT#tombstone#'


def workspace_tombstone_key(scope: WorkspaceScope, kind: str, item_id: str) -> dict[str, str]:
    """The tombstone of one of the workspace's deleted items: ``AUDIT#tombstone#{kind}`` / ``{ws}#{item id}``.

    The workspace is in the sort key, so two workspaces' copies of one source item (one id), and the deployment's
    (``sk`` the bare id), never share a tombstone: the key voc-retention writes for the same item (its ``tombstone_key``,
    jobs/retention/copies.py), so of the two one is kept. ValueError for an empty part."""
    if not kind or not item_id:
        raise ValueError('a tombstone key needs a kind and an id')
    return {'pk': f'{TOMBSTONE_PARTITION_PREFIX}{kind}', 'sk': f'{scope.ws}#{item_id}'}


def _plain_old_item(raw: object) -> dict[str, Any]:
    """A failed condition's ``ALL_OLD`` item (DynamoDB's typed JSON in an error response) as plain values; ``{}``
    when there is none."""
    if not isinstance(raw, Mapping):
        return {}
    deserializer = TypeDeserializer()
    typed: Mapping[str, Any] = raw
    return {str(name): deserializer.deserialize(value) for name, value in typed.items()}


#: What a tombstone never takes from its caller: its key and its workspace, both built here.
_TOMBSTONE_FIXED: Final = frozenset({'pk', 'sk', WORKSPACE_FIELD})


class WorkspaceTombstones:
    """The workspace's tombstones in voc-aggregates, one conditional PutItem of a new key each (TENETS.md D4, D5).

    ``put_new`` writes ``workspace_tombstone_key`` with the caller's fields (never content: the caller's rule) and the
    workspace's ``workspace_id``; a key already there (an erasure's tombstone of the same item, or this job's own from
    an earlier generation) is kept as it is, never overwritten. Not a batch: IAM cannot tell a batch put from a batch
    delete, so the roles that write tombstones put them one PutItem at a time (lib/utils/audit-row-guard.ts).

    Built from the workspace's own view of voc-aggregates (``ws_table``): the tombstones go to that view's table, and
    no caller outside the layer ever holds the table itself."""

    def __init__(self, aggregates: WorkspaceTable) -> None:
        self.scope = aggregates.scope
        # A tombstone is not a key of the view's scope: the view's one tombstone put writes it.
        self._view = aggregates

    def put_new(self, kind: str, item_id: str, fields: Mapping[str, Any]) -> dict[str, Any] | None:
        """Write the tombstone of ``item_id``; None when written, else the one already there (kept as it is)."""
        clashing = sorted(set(fields) & _TOMBSTONE_FIXED)
        if clashing:
            raise OutOfScopeError(f'a tombstone builds its own {", ".join(clashing)}')
        item = {**fields, **workspace_tombstone_key(self.scope, kind, item_id), WORKSPACE_FIELD: self.scope.ws}
        return self._view.put_new_tombstone(item)


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


def _open_uploads(s3: Any, bucket: str, prefix: str, checked: Callable[[object], str]) -> list[tuple[str, str]]:
    """Every multipart upload still open under ``prefix``, ``(key, upload id)`` (each key ``checked``: a key outside
    the caller's keys refuses the whole listing), across ListMultipartUploads' pages."""
    request: dict[str, Any] = {'Bucket': bucket, 'Prefix': prefix}
    found: list[tuple[str, str]] = []
    while True:
        response = s3.list_multipart_uploads(**request)
        found.extend((checked(upload.get('Key')), str(upload['UploadId'])) for upload in response.get('Uploads') or [])
        if not response.get('IsTruncated'):
            return found
        request.update(KeyMarker=response['NextKeyMarker'], UploadIdMarker=response['NextUploadIdMarker'])


def _abort_upload(s3: Any, bucket: str, key: str, upload_id: str) -> None:
    """Abort one upload of an already checked ``key``; one already gone (``NoSuchUpload``) is done."""
    try:
        s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') != _NO_SUCH_UPLOAD:
            raise


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
        if not has_plain_segments(key[len(prefix):]):
            raise OutOfScopeError("a key outside the workspace's exports")
        return key

    def start_upload(self, key: str, content_type: str) -> str:
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
        return _open_uploads(self._s3, self._bucket, exports_prefix(self.scope), self._checked)

    def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        """Abort an upload; one already gone (``NoSuchUpload``: aborted or completed since it was listed) is done.
        A completed one is a zip, which the caller's version delete removes (voc-retention lists after aborting)."""
        _abort_upload(self._s3, self._bucket, self._checked(key), upload_id)

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
    """An object being read: its body (a stream: ``read(n)``), content type, size and ETag (the version read, so a
    dropped stream resumes on that version only: ``WorkspaceObjects.resume``)."""

    body: Any
    content_type: str
    size: int
    etag: str = ''


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
                or not has_plain_segments(key[len(prefix):])):
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
                            int(response.get('ContentLength') or 0), str(response.get('ETag') or ''))

    def resume(self, key: str, start: int, etag: str) -> Any:
        """The rest of ``key`` from byte ``start`` (a stream), only while its current version is still ``etag``: a
        ranged GetObject with ``IfMatch``, so a version replaced mid-copy is refused (412, raised) and never spliced
        onto the bytes already read."""
        if not etag or start < 0:
            raise ValueError('a resume names the version read and a byte offset')
        return self._s3.get_object(Bucket=self._bucket, Key=self._checked(key), Range=f'bytes={start}-',
                                   IfMatch=etag)['Body']

    def _still_listed(self, key: str) -> bool:
        """Whether ``key`` itself is still a current object (not merely a prefix of another key)."""
        response = self._s3.list_objects_v2(Bucket=self._bucket, Prefix=key, MaxKeys=1)
        return any(entry.get('Key') == key for entry in response.get('Contents') or [])


#: S3 lists at most this many versions a page (ListObjectVersions) and deletes at most this many a call
#: (DeleteObjects).
VERSIONS_PAGE: Final = 1000


@dataclass(frozen=True)
class ObjectVersion:
    """One version of an object, or one delete marker (both are deleted by their version id)."""

    key: str
    version_id: str


@dataclass(frozen=True)
class VersionPage:
    """One page of a workspace's object versions, and where the next page starts (``(key marker, version id
    marker)``; None: done)."""

    versions: list[ObjectVersion]
    following: tuple[str, str] | None


@dataclass(frozen=True)
class VersionDeleteFailure:
    """A version DeleteObjects did not delete, with S3's code (the caller retries it or counts it)."""

    key: str
    version_id: str
    code: str


class WorkspaceObjectVersions:
    """Every version, delete marker and open multipart upload under the workspace's ``s3_prefix`` (its exports
    included), listed and deleted for good: used by the hard delete (4d-2). A sibling of ``WorkspaceObjects``
    (read-only, current objects only), never a change to it.

    Lists with ``Prefix`` ``ws/{ws}/`` only and deletes by version id only, at most ``VERSIONS_PAGE`` a call. A key
    is the workspace's when it starts ``ws/{ws}/`` and goes on (S3 keys are literal: no ``..`` is ever resolved, so
    such a key is still under the prefix); any other key, listed or asked for, is ``OutOfScopeError`` before a delete
    or an abort is sent, and refuses the whole call."""

    def __init__(self, scope: WorkspaceScope, s3: Any, bucket: str) -> None:
        if not bucket:
            raise ValueError('a workspace has its objects in a bucket')
        self.scope, self._s3, self._bucket = scope, s3, bucket

    def _checked(self, key: object) -> str:
        prefix = s3_prefix(self.scope)
        if not isinstance(key, str) or not key.startswith(prefix) or len(key) == len(prefix):
            raise OutOfScopeError('a key outside the workspace')
        return key

    def list_page(self, following: tuple[str, str] | None) -> VersionPage:
        """One page of the workspace's versions and delete markers, from ``following`` (a page's own, or None from
        the first). A listed key outside the workspace is refused."""
        request: dict[str, Any] = {'Bucket': self._bucket, 'Prefix': s3_prefix(self.scope), 'MaxKeys': VERSIONS_PAGE}
        if following is not None:
            key_marker, version_marker = following
            request.update(KeyMarker=self._checked(key_marker), VersionIdMarker=version_marker)
        response = self._s3.list_object_versions(**request)
        versions = [ObjectVersion(self._checked(entry.get('Key')), str(entry.get('VersionId') or 'null'))
                    for part in ('Versions', 'DeleteMarkers') for entry in response.get(part) or []]
        following_page = ((str(response['NextKeyMarker']), str(response.get('NextVersionIdMarker') or ''))
                          if response.get('IsTruncated') else None)
        return VersionPage(versions, following_page)

    def delete(self, versions: Sequence[ObjectVersion]) -> list[VersionDeleteFailure]:
        """Delete 1 to ``VERSIONS_PAGE`` versions (none twice) in one DeleteObjects; the ones S3 did not delete. A
        version already gone counts as deleted (S3 answers it deleted)."""
        if not 1 <= len(versions) <= VERSIONS_PAGE:
            raise ValueError(f'a version delete takes 1 to {VERSIONS_PAGE} versions, not {len(versions)}')
        objects = [{'Key': self._checked(version.key), 'VersionId': version.version_id} for version in versions]
        if len({(entry['Key'], entry['VersionId']) for entry in objects}) != len(objects):
            raise ValueError('a version delete names one version twice')
        response = self._s3.delete_objects(Bucket=self._bucket, Delete={'Objects': objects, 'Quiet': True})
        return [VersionDeleteFailure(str(error.get('Key') or ''), str(error.get('VersionId') or ''),
                                     str(error.get('Code') or ''))
                for error in response.get('Errors') or []]

    def open_uploads(self) -> list[tuple[str, str]]:
        """Every multipart upload still open under the workspace (its exports' and any other), ``(key, upload
        id)``, across ListMultipartUploads' pages. A listed key outside the workspace is refused."""
        return _open_uploads(self._s3, self._bucket, s3_prefix(self.scope), self._checked)

    def abort_upload(self, key: str, upload_id: str) -> None:
        """Abort one open upload of the workspace; one already gone (``NoSuchUpload``: aborted or completed since it
        was listed) is done (a completed one is an object, which the version delete removes)."""
        _abort_upload(self._s3, self._bucket, self._checked(key), upload_id)


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

    # Fixed state: no __dict__, and nothing can be set or deleted once built, so no caller can swap the scope, the
    # key or the handle behind a table it was given.
    __slots__ = ('_key_attribute', '_scope', '_unscoped_table')
    _key_attribute: str
    _scope: WorkspaceScope
    _unscoped_table: Any

    def __init__(self, scope: WorkspaceScope, table: Any, key: str = 'pk') -> None:
        if key not in TABLE_PARTITION_KEYS:
            raise ValueError('a data-path table is keyed on pk or source')
        for name, value in (('_scope', scope), ('_key_attribute', key), ('_unscoped_table', table)):
            object.__setattr__(self, name, value)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError('a WorkspaceTable cannot be changed')

    def __delattr__(self, name: str) -> None:
        raise AttributeError('a WorkspaceTable cannot be changed')

    @property
    def scope(self) -> WorkspaceScope:
        """The workspace this table is seen through."""
        return self._scope

    @property
    def key_attribute(self) -> str:
        """The table's partition key: ``pk``, or ``source`` (voc-watermarks)."""
        return self._key_attribute

    @staticmethod
    def _check_options(method: str, kwargs: Mapping[str, Any]) -> None:
        unknown = sorted(set(kwargs) - ALLOWED_OPTIONS[method])
        if unknown:
            raise OutOfScopeError(f'{method} does not take {", ".join(unknown)}')

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
        self._check_options('get_item', kwargs)
        self._check_key(key)
        return self._unscoped_table.get_item(Key=dict(key), **kwargs)

    def put_item(self, item: Mapping[str, Any], **kwargs: Any) -> dict:
        self._check_options('put_item', kwargs)
        self._check_item(item)
        return self._unscoped_table.put_item(Item=dict(item), **kwargs)

    def put_new_tombstone(self, item: Mapping[str, Any]) -> dict[str, Any] | None:
        """The view's one write outside its partitions, for ``WorkspaceTombstones``: a put of a new key in an
        ``AUDIT#tombstone#…`` partition whose sort key is this workspace's (``{ws}#…``); anything else is refused
        (``OutOfScopeError``). None when written; the tombstone already there when the key was taken (kept as it is,
        read from the failed condition's ``ALL_OLD``: no extra read)."""
        pk, sk = item.get('pk'), item.get('sk')
        if not (isinstance(pk, str) and pk.startswith(TOMBSTONE_PARTITION_PREFIX)
                and isinstance(sk, str) and sk.startswith(f'{self.scope.ws}#')):
            raise OutOfScopeError('not a tombstone of the workspace')
        try:
            self._unscoped_table.put_item(Item=dict(item), ConditionExpression='attribute_not_exists(pk)',
                                          ReturnValuesOnConditionCheckFailure='ALL_OLD')
        except ClientError as error:
            if is_conditional_check_failure(error):
                return _plain_old_item(error.response.get('Item'))
            raise
        return None

    def delete_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        self._check_options('delete_item', kwargs)
        self._check_key(key)
        return self._unscoped_table.delete_item(Key=dict(key), **kwargs)

    def update_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        """``UpdateItem`` of a key in the scope.

        Every partition attribute the ``UpdateExpression`` names, directly or through an
        ``ExpressionAttributeNames`` alias, must be SET from one placeholder (``gsi2pk = :g``) whose value is in
        the scope; any other use of one (a ``REMOVE``, ``if_not_exists``, arithmetic, a list append) is refused,
        because its value could not be checked here.
        """
        self.check_update(key, **kwargs)
        return self._unscoped_table.update_item(Key=dict(key), **kwargs)

    def check_update(self, key: Mapping[str, Any], **kwargs: Any) -> None:
        """``update_item``'s checks without the call (``OutOfScopeError`` when one fails): a caller that sends the
        same update inside a ``TransactWriteItems`` (the aggregator's arrivals) checks each ``Update`` here first,
        its parameters too (``ALLOWED_OPTIONS``, without the ``Key`` and ``TableName`` the transaction names)."""
        self._check_options('update_item', kwargs)
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
        self._check_options('query', kwargs)
        start = kwargs.get('ExclusiveStartKey')
        # A cursor a client sent back: every partition attribute it names must be in the scope too.
        if start is not None and (not isinstance(start, Mapping) or any(
                attribute in start and not self.scope.owns(start[attribute]) for attribute in PARTITION_ATTRIBUTES)):
            raise OutOfScopeError('a cursor outside the workspace')
        return self._unscoped_table.query(**partition_query(partition_attribute, partition, sort_condition, kwargs))

    def iter_query(self, partition_attribute: str, partition: str, *, sort_condition: str | None = None,
                   max_items: int | None = None, **kwargs: Any) -> Iterator[dict]:
        """Every item of ``query`` across its pages (at most ``max_items``; shared/dynamo_paging.py pages)."""
        return iter_query(_BoundQuery(self, partition_attribute, partition, sort_condition), kwargs,
                          max_items=max_items)

    def scan(self, **kwargs: Any) -> dict:
        """One page of a Scan of the table that answers the scope's rows only: its ``FilterExpression`` (a boto3
        condition, ``Attr(…)``; a string one is refused, as it could not be combined) is ANDed with the table's key
        beginning ``WS#{ws}#``, and a returned row outside it (which the filter rules out) raises ``OutOfScopeError``
        rather than reach the caller.

        A cursor (``ExclusiveStartKey``) is a position in the whole table, not a partition read: DynamoDB applies
        ``Limit`` before the filter, so a page's ``LastEvaluatedKey`` is the last row it evaluated, often another
        scope's. So a cursor may name any row, but only by the table's own key (``pk``/``source`` and ``sk``); any
        other attribute in it is refused. It never widens what is answered: the filter and the row check do that.

        A Scan still reads, and is billed for, the whole table: the filter only narrows what comes back. Its caller
        is a workspace's category reprocess (jobs/category_reprocess), as the deployment's reprocess scans the whole
        table for its own rows.
        """
        self._check_options('scan', kwargs)
        request = dict(kwargs)
        caller_filter = request.pop('FilterExpression', None)
        if caller_filter is not None and not isinstance(caller_filter, ConditionBase):
            raise OutOfScopeError('a scan filter through the workspace layer is a boto3 condition')
        start = request.get('ExclusiveStartKey')
        if start is not None and (not isinstance(start, Mapping) or not start
                                  or not set(start) <= {self.key_attribute, 'sk'}
                                  or not all(isinstance(value, str) for value in start.values())):
            raise OutOfScopeError('a scan cursor names the table key only')
        scoped: ConditionBase = Attr(self.key_attribute).begins_with(self.scope.prefix)
        response = self._unscoped_table.scan(
            FilterExpression=scoped if caller_filter is None else scoped & caller_filter, **request)
        if any(not self.scope.owns(item.get(self.key_attribute)) for item in response.get('Items') or []):
            raise OutOfScopeError('a scanned row outside the workspace')
        return response

    def transact_write_items(self, items: Sequence[Mapping[str, Any]], *, outside: OutsideEntry | None = None,
                             unpaused_in: Any | None = None, unchanged_in: tuple[Any, object] | None = None,
                             **kwargs: Any) -> dict:
        """One ``TransactWriteItems`` on this table: 1 to 100 entries, each ``{'Put': {'Item': …}}``,
        ``{'Update': {'Key': …, 'UpdateExpression': …}}``, ``{'Delete': {'Key': …}}`` or
        ``{'ConditionCheck': {'Key': …, 'ConditionExpression': …}}`` (plain Python values, no ``TableName``).

        Each item is checked as ``put_item`` checks it, each key as ``get_item`` does, each ``Update`` as
        ``check_update`` does; one entry outside the scope refuses the whole transaction before it is sent, so
        nothing of it is written. Only ``ClientRequestToken``, ``ReturnConsumedCapacity`` and
        ``ReturnItemCollectionMetrics`` are passed on.

        ``outside``: the one entry outside the workspace a transaction takes (an ``OutsideEntry`` for this same
        workspace: a project id's claim, ``claim_project_id``, or a review link's routing row, ``route_share_id``),
        put first (``OUTSIDE_ENTRY_INDEX``, counted in the 100) and only if absent, so it is written with the rows it
        belongs to or not at all. One for another workspace, or anything but an ``OutsideEntry``, is refused; a
        caller's own entry outside the workspace stays refused.

        ``unpaused_in``: voc-workspaces (its table handle): the transaction also checks this view's OWN workspace's
        ``META`` there (shared/trial_state.py ``unpaused_check``, last, counted in the 100): still active and no paused
        trial, so a write that puts something live cannot land once a trial's pause committed. ``unchanged_in``:
        ``(voc-workspaces, rev)``: the check there is a trial pause's turn-off's instead (shared/trial_state.py
        ``unchanged_check``, 7.71.04): still active and its trial's ``rev`` still ``rev``, so the pause turns a form off
        only while no extension or conversion wrote the trial since it saved its lists. Never both (a ValueError: one
        transaction checks an item once). The layer names the key from its own scope; a caller names no key and no
        condition. A cancelled transaction's error propagates: its reasons name the caller's entries first and the
        check last.
        """
        options = _checked_options('TransactWriteItems', kwargs, _TRANSACT_WRITE_OPTIONS)
        entries = list(items)
        claimed = [] if outside is None else [self._outside_entry(outside)]
        meta = self._meta_checks(unpaused_in, unchanged_in)
        if not 1 <= len(entries) + len(claimed) + len(meta) <= MAX_TRANSACT_ITEMS:
            raise ValueError(f'a TransactWriteItems takes 1 to {MAX_TRANSACT_ITEMS} entries, '
                             f'not {len(entries) + len(claimed) + len(meta)}')
        checked = [self._checked_write(entry) for entry in entries]
        self._refuse_duplicates('TransactWriteItems',
                                [body.get('Key') or body['Item'] for entry in checked for body in entry.values()])
        return self._unscoped_table.meta.client.transact_write_items(TransactItems=[*claimed, *checked, *meta],
                                                                     **options)

    def _meta_checks(self, unpaused_in: Any | None, unchanged_in: tuple[Any, object] | None) -> list[dict[str, Any]]:
        """The check of this view's own workspace's ``META`` a transaction asked for (``transact_write_items``), if
        any: ``unpaused_check`` or ``unchanged_check``, never both."""
        if unpaused_in is not None and unchanged_in is not None:
            raise ValueError("a TransactWriteItems checks its workspace's META once: unpaused_in or unchanged_in")
        if unpaused_in is not None:
            return [unpaused_check(unpaused_in.name, self.scope.ws)]
        if unchanged_in is not None:
            workspaces, rev = unchanged_in
            return [unchanged_check(workspaces.name, self.scope.ws, rev)]
        return []

    def _outside_entry(self, outside: object) -> dict[str, Any]:
        """The outside entry's Put, built here from its kind, id, time and expiry and this view's own workspace and
        table: only an ``OutsideEntry`` itself (``type`` checked, not ``isinstance``), complete, of this workspace,
        of a well-formed id, on voc-projects (``PROJECTS_TABLE_ENV``); ``OutOfScopeError`` otherwise, before anything
        is sent."""
        if type(outside) is not OutsideEntry:
            raise OutOfScopeError(_NOT_OURS)
        try:
            kind, scope, item_id, at, ttl = outside.kind, outside.scope, outside.item_id, outside.at, outside.ttl
        except AttributeError as error:  # an instance made without its constructor (``object.__new__``)
            raise OutOfScopeError(_NOT_OURS) from error
        spec = _OUTSIDE_KINDS.get(kind)
        if spec is None or scope != self.scope or not at or not spec.ttl_fits(ttl):
            raise OutOfScopeError(_NOT_OURS)
        item = {**spec.key(item_id), WORKSPACE_FIELD: self.scope.ws, spec.at_field: at,
                **({'ttl': ttl} if spec.expires else {})}
        table_name = self._unscoped_table.name
        if not table_name or table_name != os.environ.get(PROJECTS_TABLE_ENV):
            raise OutOfScopeError(f'a {spec.name} is written in the projects table only')
        return {'Put': {'TableName': table_name, 'Item': item, 'ConditionExpression': 'attribute_not_exists(pk)'}}

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
        return batch_get_all(self._unscoped_table, checked, failure=failure, read_options=options)

    def batch_writer(self) -> WorkspaceBatchWriter:
        """``table.batch_writer()`` through the view (a context manager): each ``put_item(Item=…)`` is checked as
        ``put_item`` checks it before it is buffered. Puts only (``WorkspaceBatchWriter``); deletes go through
        ``batch_delete``."""
        return WorkspaceBatchWriter(self._check_item, self._unscoped_table.batch_writer())

    def batch_delete(self, keys: Iterable[Mapping[str, Any]]) -> int:
        """Delete every item ``keys`` names, and answer how many keys were sent: used by the hard delete (4d-2).

        Every key is checked before anything is sent (in the scope, exactly the table's key: ``pk`` and ``sk``, or
        ``source`` on voc-watermarks; none twice), so one key outside the scope refuses the whole call. Sent as
        BatchWriteItem requests of up to ``MAX_BATCH_WRITE_ITEMS`` deletes on this table only; each request's
        ``UnprocessedItems`` are checked again and re-sent with a jittered backoff, ``BATCH_WRITE_ATTEMPTS`` calls in
        all, then ``UnprocessedItemsError`` (the requests before it stay deleted: a delete of a missing key changes
        nothing, so the caller simply repeats the call). Deleting an absent key is not an error.
        """
        checked = self.check_keys(keys)
        expected = {self.key_attribute} | ({'sk'} if self.key_attribute == 'pk' else set())
        if any(set(key) != expected for key in checked):
            raise ValueError(f'a batch delete names each item by its key alone: {", ".join(sorted(expected))}')
        self._refuse_duplicates('BatchWriteItem', checked)
        for start in range(0, len(checked), MAX_BATCH_WRITE_ITEMS):
            self._delete_chunk(checked[start:start + MAX_BATCH_WRITE_ITEMS])
        return len(checked)

    def _delete_chunk(self, keys: list[dict[str, Any]]) -> None:
        name = self._unscoped_table.name
        pending: list[Any] = [{'DeleteRequest': {'Key': key}} for key in keys]
        for attempt in range(BATCH_WRITE_ATTEMPTS):
            if attempt:
                unprocessed_backoff(attempt)
            response = self._unscoped_table.meta.client.batch_write_item(RequestItems={name: pending})
            pending = list((response.get('UnprocessedItems') or {}).get(name) or [])
            if not pending:
                return
            # What DynamoDB hands back is re-sent only as deletes of keys of the scope.
            self.check_keys(_deleted_key(request) for request in pending)
        raise UnprocessedItemsError(
            f'BatchWriteItem left {len(pending)} deletes unprocessed after {BATCH_WRITE_ATTEMPTS} calls')

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
        unknown = sorted(set(request) - _TRANSACT_ENTRY_FIELDS[action])
        if unknown:
            raise OutOfScopeError(f'a {action} entry does not take {", ".join(unknown)}')
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
        return {action: {**request, 'TableName': self._unscoped_table.name}}

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

    Puts only. ``delete_item`` is refused: a batch of deletes goes through ``WorkspaceTable.batch_delete`` (every key
    checked before any is sent, its unprocessed items retried within a bound), one delete through
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
        raise OutOfScopeError('the batch writer only puts: delete with WorkspaceTable.batch_delete or delete_item')


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
