"""The workspace-scoped repository layer of the data path (docs/multi-workspace.md, "Request flow", step 4).

Every partition key of the data path starts with ``WS#{ws}#`` and every object key with ``ws/{ws}/``, so a team
only ever reads and writes its own rows and objects. This module is the one place those keys are built:

* ``WorkspaceScope``: a verified workspace. Made only from what the server trusts: the request's resolved
  membership (``scope_of``, after shared/workspace.py ``resolve_workspace``), an asynchronous message's
  ``workspace_id`` field (``scope_from_message``: SQS bodies, Lambda async payloads, written by our own code from
  a scope), a stored partition key (``scope_from_key``: DynamoDB Stream records; ``partition_scope`` for a
  worker that reads both kinds of row, None for a deployment-wide one), or a stored control-plane routing row
  (``scope_from_lookup``: a public route's ``FORM#{id}``, a webhook's workspace ``META``, read by
  shared/workspace_routing.py). Never from a request field.
* Key builders: ``feedback_key`` and the feedback indexes' partitions (``date_pk``, ``category_pk``,
  ``urgency_pk``, ``feedback_id_pk``, ``channel_pk``), ``metric_pk`` / ``metric_type``, ``watermark_key``,
  ``source_run_pk``, ``scraper_run_pk`` and ``s3_key`` for objects (the credentials secret's name is
  shared/workspace_ids.py ``credentials_secret_name``).
* ``ws_table``: a table that refuses any key, item, update or query outside the scope's partitions (every index
  partition of voc-feedback is one of ``PARTITION_ATTRIBUTES``: gsi4 and gsi5 are keyed on ``gsi4pk`` / ``gsi5pk``,
  no longer on the raw ``feedback_id`` and ``source_channel``). Each call takes only the boto3 parameters listed
  for it (``ALLOWED_OPTIONS``): a ``TableName`` (which boto3 would let override the table), the legacy
  ``AttributeUpdates``, ``Expected``, ``KeyConditions``, ``QueryFilter``, ``ConditionalOperator`` and
  ``AttributesToGet``, or any other is refused before DynamoDB. A table's scope, key and handle are fixed once
  built (``__slots__``, read-only properties); shared/test/test_ws_raw_access.py counts any use of the private
  handle, ``_unscoped_table``, outside this layer.

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
    voc-watermarks  source WS#{ws}#{plugin}#{key}
    raw bucket      ws/{ws}/raw/{source}/{yyyy}/{mm}/{dd}/{stem}/{sha16}.json, ws/{ws}/silver/..., ws/{ws}/...
    secrets         {prefix}/{ws}/credentials (prefix voc/ws, <deployment prefix>-voc/ws in a prefixed deployment)
"""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any, Final, Protocol

from shared.dynamo_paging import iter_query
from shared.workspace_ids import is_workspace_id, ws_key

__all__ = [
    'FORM_LOOKUP_PREFIX',
    'PARTITION_ATTRIBUTES',
    'WORKSPACE_FIELD',
    'WORKSPACE_KEY_PREFIX',
    'OutOfScopeError',
    'WorkspaceScope',
    'WorkspaceTable',
    'category_pk',
    'channel_pk',
    'date_pk',
    'feedback_id_pk',
    'feedback_key',
    'is_workspace_key',
    'message_scope',
    'metric_pk',
    'metric_type',
    'partition_query',
    'partition_scope',
    's3_key',
    'scope_from_key',
    'scope_from_lookup',
    'scope_from_message',
    'scope_of',
    'scraper_run_pk',
    'source_run_pk',
    'urgency_pk',
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
}


class OutOfScopeError(ValueError):
    """A key, item or query outside the scope's partitions: a programming error, never a client's (500)."""


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


def watermark_key(scope: WorkspaceScope, plugin: str, key: str) -> str:
    """The ``source`` key of a plugin's watermark in voc-watermarks: ``WS#{ws}#{plugin}#{key}``."""
    return scope.key(plugin, key)


def s3_key(scope: WorkspaceScope, *parts: str) -> str:
    """An object key inside the workspace: ``ws/{ws}/a/b``. Refuses empty, ``.`` and ``..`` segments."""
    segments = [segment for part in parts for segment in part.split('/')]
    if not segments or any(segment in ('', '.', '..') for segment in segments):
        raise ValueError('an object key needs non-empty segments')
    return '/'.join(('ws', scope.ws, *segments))


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
        """``keys`` as plain dicts once every one is in the scope (``OutOfScopeError`` otherwise): a caller's
        ``BatchGetItem``, which this view does not make itself, names only keys of the workspace."""
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
