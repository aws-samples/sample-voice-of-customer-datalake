"""The workspace-scoped repository layer of the data path (docs/multi-workspace.md, "Request flow", step 4).

Every partition key of the data path starts with ``WS#{ws}#`` and every object key with ``ws/{ws}/``, so a team
only ever reads and writes its own rows and objects. This module is the one place those keys are built:

* ``WorkspaceScope``: a verified workspace. Made only from what the server trusts: the request's resolved
  membership (``scope_of``, after shared/workspace.py ``resolve_workspace``), an asynchronous message's
  ``workspace_id`` field (``scope_from_message``: SQS bodies, Lambda async payloads, written by our own code from
  a scope), or a stored partition key (``scope_from_key``: DynamoDB Stream records). Never from a request field.
* Key builders: ``feedback_key`` and the feedback indexes' partitions (``date_pk``, ``category_pk``,
  ``urgency_pk``, ``feedback_id_pk``, ``channel_pk``), ``metric_pk`` / ``metric_type``, ``watermark_key``,
  ``source_run_pk``, and ``s3_key`` for objects.
* ``ws_table``: a table that refuses any key, item, update or query outside the scope's partitions, and any
  write of gsi4's and gsi5's partitions while those stay shared by every workspace (``UNSCOPED_INDEX_ATTRIBUTES``).

shared/test/test_ws_raw_access.py counts, per module outside this layer, the raw table and bucket calls and the
unscoped data-path keys, against an allowlist of the modules not moved yet that must match exactly.

The keys (``{ws}`` is ``ws_`` + a ULID, shared/workspace.py ``is_workspace_id``)::

    voc-feedback    pk WS#{ws}#SOURCE#{source}   sk FEEDBACK#{feedback_id}
                    gsi1pk WS#{ws}#DATE#{yyyy-mm-dd}      gsi2pk WS#{ws}#CATEGORY#{category}
                    gsi3pk WS#{ws}#URGENCY#{urgency}
                    gsi4pk WS#{ws}#FEEDBACK#{feedback_id}  gsi5pk WS#{ws}#CHANNEL#{channel}   (planned: today
                    gsi4 and gsi5 are keyed on the raw feedback_id and source_channel, re-keyed with the processor)
    voc-aggregates  pk WS#{ws}#METRIC#{name}     metric_type WS#{ws}#{type}
                    pk WS#{ws}#SOURCE_RUN#{source}
    voc-watermarks  source WS#{ws}#{plugin}#{key}
    raw bucket      ws/{ws}/raw/{source}/{yyyy}/{mm}/{dd}/{stem}/{sha16}.json, ws/{ws}/silver/..., ws/{ws}/...
"""
from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared.dynamo_paging import iter_query
from shared.workspace import WorkspaceContext, is_workspace_id, ws_key

__all__ = [
    'PARTITION_ATTRIBUTES',
    'UNSCOPED_INDEX_ATTRIBUTES',
    'WORKSPACE_FIELD',
    'OutOfScopeError',
    'WorkspaceScope',
    'category_pk',
    'channel_pk',
    'date_pk',
    'feedback_id_pk',
    'feedback_key',
    'metric_pk',
    'metric_type',
    's3_key',
    'scope_from_key',
    'scope_from_message',
    'scope_of',
    'source_run_pk',
    'urgency_pk',
    'watermark_key',
    'ws_table',
]

#: The field an asynchronous message (SQS body, Lambda async payload) names its workspace in.
WORKSPACE_FIELD: Final = 'workspace_id'
#: Item attributes that are partition keys of the table or of one of its indexes: each must be in the scope.
PARTITION_ATTRIBUTES: Final = ('pk', 'source', 'gsi1pk', 'gsi2pk', 'gsi3pk', 'gsi4pk', 'gsi5pk', 'metric_type')
#: The partitions of gsi4 (``feedback_id``) and gsi5 (``source_channel``) of voc-feedback today: raw values, the same
#: in every workspace. The processor's slice re-keys both indexes onto ``gsi4pk`` / ``gsi5pk`` (``feedback_id_pk``,
#: ``channel_pk``); until then the layer refuses to write either attribute, so nothing it writes is found across
#: workspaces through them (shared/test/test_ws_repo.py pins this list against lib/stacks/core-stack.ts).
UNSCOPED_INDEX_ATTRIBUTES: Final = ('feedback_id', 'source_channel')
#: ``= :placeholder`` right after an attribute in an UpdateExpression: the one checked way to set a partition.
_ASSIGNED_PLACEHOLDER: Final = re.compile(r'\s*=\s*(:\w+)(?![\w(])\s*(?:,|\Z|\b(?:SET|REMOVE|ADD|DELETE)\b)',
                                          re.IGNORECASE)


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


def scope_of(context: WorkspaceContext) -> WorkspaceScope:
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


def scope_from_key(partition_key: object) -> WorkspaceScope:
    """The scope a stored partition key ``WS#{ws}#…`` belongs to (a DynamoDB Stream record's ``pk``)."""
    if not isinstance(partition_key, str) or not partition_key.startswith('WS#'):
        raise ValueError('not a workspace key')
    ws, separator, rest = partition_key[3:].partition('#')
    if not separator or not rest:
        raise ValueError('not a workspace key')
    return WorkspaceScope(ws)


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


def watermark_key(scope: WorkspaceScope, plugin: str, key: str) -> str:
    """The ``source`` key of a plugin's watermark in voc-watermarks: ``WS#{ws}#{plugin}#{key}``."""
    return scope.key(plugin, key)


def s3_key(scope: WorkspaceScope, *parts: str) -> str:
    """An object key inside the workspace: ``ws/{ws}/a/b``. Refuses empty, ``.`` and ``..`` segments."""
    segments = [segment for part in parts for segment in part.split('/')]
    if not segments or any(segment in ('', '.', '..') for segment in segments):
        raise ValueError('an object key needs non-empty segments')
    return '/'.join(('ws', scope.ws, *segments))


class WorkspaceTable:
    """A DynamoDB table seen through one workspace: every key, item and query must be in the scope.

    Only the calls the data path makes. A key or item whose partition (``pk``, ``source`` or an index partition
    attribute it carries) is outside the scope raises ``OutOfScopeError`` before anything reaches DynamoDB.
    """

    def __init__(self, scope: WorkspaceScope, table: Any) -> None:
        self.scope = scope
        self._table = table

    def _check_key(self, key: Mapping[str, Any]) -> None:
        partition = key.get('pk', key.get('source'))
        if not self.scope.owns(partition):
            raise OutOfScopeError('a key outside the workspace')

    def _check_item(self, item: Mapping[str, Any]) -> None:
        self._check_key(item)
        if any(attribute in item for attribute in UNSCOPED_INDEX_ATTRIBUTES):
            raise OutOfScopeError('an index partition shared by every workspace')
        for attribute in PARTITION_ATTRIBUTES:
            if attribute in item and not self.scope.owns(item[attribute]):
                raise OutOfScopeError(f'{attribute} outside the workspace')

    def get_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        self._check_key(key)
        return self._table.get_item(Key=dict(key), **kwargs)

    def put_item(self, item: Mapping[str, Any], **kwargs: Any) -> dict:
        self._check_item(item)
        return self._table.put_item(Item=dict(item), **kwargs)

    def update_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        """``UpdateItem`` of a key in the scope.

        Every partition attribute the ``UpdateExpression`` names, directly or through an
        ``ExpressionAttributeNames`` alias, must be SET from one placeholder (``gsi2pk = :g``) whose value is in
        the scope; any other use of one (a ``REMOVE``, ``if_not_exists``, arithmetic, a list append) is refused,
        because its value could not be checked here.
        """
        self._check_key(key)
        expression = kwargs.get('UpdateExpression')
        names = kwargs.get('ExpressionAttributeNames') or {}
        values = kwargs.get('ExpressionAttributeValues') or {}
        if not isinstance(expression, str):
            raise OutOfScopeError('an update needs an UpdateExpression')
        if _names_any(expression, names, UNSCOPED_INDEX_ATTRIBUTES):
            raise OutOfScopeError('an index partition shared by every workspace')
        for attribute in PARTITION_ATTRIBUTES:
            for spelling in _spellings(attribute, names):
                for match in _mentions(spelling, expression):
                    assigned = _ASSIGNED_PLACEHOLDER.match(expression, match.end())
                    if assigned is None or not self.scope.owns(values.get(assigned.group(1))):
                        raise OutOfScopeError(f'{attribute} outside the workspace')
        return self._table.update_item(Key=dict(key), **kwargs)

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
        names = {**(kwargs.pop('ExpressionAttributeNames', None) or {}), '#p': partition_attribute}
        values = {**(kwargs.pop('ExpressionAttributeValues', None) or {}), ':p': partition}
        condition = '#p = :p' + (f' AND {sort_condition}' if sort_condition else '')
        return self._table.query(KeyConditionExpression=condition, ExpressionAttributeNames=names,
                                 ExpressionAttributeValues=values, **kwargs)

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


def _names_any(expression: str, names: Mapping[str, Any], attributes: tuple[str, ...]) -> bool:
    return any(next(_mentions(spelling, expression), None) is not None
               for attribute in attributes for spelling in _spellings(attribute, names))


def ws_table(scope: WorkspaceScope, table: Any) -> WorkspaceTable:
    """``table`` seen through ``scope`` (``WorkspaceTable``)."""
    return WorkspaceTable(scope, table)
