"""The workspace-scoped repository layer (docs/multi-workspace.md, "Model" and "Request flow" step 4).

Phase 2 moves the data path onto this module; until then nothing in the data path uses it (only its tests do), and
every table and bucket is read and written as before. The raw-access audit (scripts/audit/ws_raw_access.py) counts,
file by file, the raw table handles and S3 writes outside this module: its allowlist is the work list phases 2 and
3 shrink, and a new raw access, or a count that grows, fails the gate.

* ``ws_key(ws, *parts)`` (shared/workspace.py): ``WS#{ws}#a#b``, the partition keys of a workspace's data.
* ``ws_table(ws, env_var)``: one of the tables phase 2 keys by workspace (``TABLES``, by the environment variable
  that names it), seen through ``ws``. Its partition attribute (``pk``) and every index partition attribute of that
  table (``TABLES``: ``gsi1pk``, voc-aggregates' ``metric_type``, …) must hold ``WS#{ws}#…`` with at least one
  part after the workspace: the control-plane partition ``WS#{ws}`` itself (its ``META`` and ``MEMBER#`` rows,
  voc-workspaces) is outside it, so a data route never reaches a membership. Any other key raises
  ``WorkspaceScopeError`` (a ``ValueError``) before an AWS call, and so does a table that is not in ``TABLES``.
* ``ws_s3_key(ws, *parts)``: ``ws/{ws}/a/b``, one path segment per part: an empty part, ``.``, ``..``, a ``/``
  or ``\\`` inside a part, or a control character (C0, DEL, C1, U+2028, U+2029) is refused.

``get_item``, ``put_item``, ``update_item`` and ``delete_item`` take boto3's keyword forms (``Key=``, ``Item=``) and
answer boto3's responses, so a call site of those four moves by swapping its handle (its key values becoming
``WS#{ws}#…``, phase 2's re-keying), unless it passes a legacy
parameter (below) or its update sets a key or index partition attribute (that one becomes a ``put_item``). ``query``
does not: it names its partition value (and an index by name) and builds the key condition itself, refusing a
caller's ``KeyConditionExpression``, so each query call site is rewritten when it moves. There is no ``scan`` (it
would read every workspace). ``update_item`` refuses an ``UpdateExpression`` that names a key or index partition
attribute, as a plain word or as a ``#placeholder`` the expression uses (resolved through
``ExpressionAttributeNames``); a condition that names one (``attribute_exists(#pk)``) passes. Index keys are set
with ``put_item``, where their values are checked. Each method takes only the parameters listed for it
(``_ALLOWED``); anything else, the legacy ``AttributeUpdates``, ``Expected``, ``KeyConditions``, ``QueryFilter`` and
``AttributesToGet`` included, is refused. A ``WorkspaceTable``'s state is fixed (``__slots__``, read-only
properties; the raw-access audit counts any private attribute of it, ``vars()`` or ``__dict__`` used elsewhere). The layer offers no transactions and no batch reads or writes yet: phase 2 adds scoped ones with the same key
checks before it moves a call site that needs them.
"""
from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from boto3.dynamodb.conditions import ConditionBase, Key

from shared import indexes
from shared.aws import get_dynamodb_resource
from shared.exceptions import ConfigurationError
from shared.tables import cached_table
from shared.workspace import is_workspace_id, ws_key

#: One S3 path segment: no separator, no C0/DEL/C1 control character, no line or paragraph separator.
_S3_PART: Final = re.compile(r'[^/\\\x00-\x1f\x7f-\x9f\u2028\u2029]+')
#: Placeholders (``#name``, ``:value``) in an expression, removed before its plain words are read.
_PLACEHOLDER: Final = re.compile(r'[#:][A-Za-z0-9_]+')
_NAME_PLACEHOLDER: Final = re.compile(r'#[A-Za-z0-9_]+')
_WORD: Final = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
_WRITE_OPTIONS: Final = frozenset({'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues',
                                   'ReturnValues', 'ReturnConsumedCapacity', 'ReturnItemCollectionMetrics',
                                   'ReturnValuesOnConditionCheckFailure'})
#: The parameters each method passes on; anything else (the legacy AttributeUpdates, Expected, KeyConditions,
#: QueryFilter, AttributesToGet, …) is refused.
_ALLOWED: Final[Mapping[str, frozenset[str]]] = {
    'get_item': frozenset({'ConsistentRead', 'ProjectionExpression', 'ExpressionAttributeNames',
                           'ReturnConsumedCapacity'}),
    'put_item': _WRITE_OPTIONS,
    'delete_item': _WRITE_OPTIONS,
    'update_item': _WRITE_OPTIONS | {'UpdateExpression'},
    'query': frozenset({'Limit', 'ExclusiveStartKey', 'ScanIndexForward', 'ConsistentRead', 'ProjectionExpression',
                        'FilterExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues', 'Select',
                        'ReturnConsumedCapacity'}),
}


def _check_options(method: str, kwargs: Mapping[str, Any]) -> None:
    unknown = sorted(set(kwargs) - _ALLOWED[method])
    if unknown:
        raise WorkspaceScopeError(f'{method} does not take {", ".join(unknown)}')


@dataclass(frozen=True)
class TableSchema:
    """A workspace-keyed table: its partition attribute and its indexes' partition attributes, by index name."""

    partition_key: str = 'pk'
    indexes: Mapping[str, str] = field(default_factory=dict)

    @property
    def scoped_attributes(self) -> frozenset[str]:
        """Every attribute that must hold a ``WS#{ws}#…`` value."""
        return frozenset({self.partition_key, *self.indexes.values()})


def _pairs(*index_names: str) -> dict[str, str]:
    """Key-pair indexes (lib/stacks/core-stack.ts addKeyPairIndex): ``gsi<N>-…`` is partitioned on ``gsi<N>pk``."""
    return {name: f'{name.split("-")[0]}pk' for name in index_names}


#: The tables phase 2 and 3 key by workspace (pk / sk, lib/stacks/core-stack.ts), by the environment variable
#: that names each, with their indexes. The design prefixes every index partition key too, so ``metric_type``,
#: ``kind``, ``feedback_id`` and ``source_channel`` must hold ``WS#{ws}#…`` values here.
TABLES: Final[Mapping[str, TableSchema]] = {
    'FEEDBACK_TABLE': TableSchema(indexes={
        **_pairs(indexes.FEEDBACK_BY_DATE_INDEX, indexes.FEEDBACK_BY_CATEGORY_INDEX, indexes.FEEDBACK_BY_URGENCY_INDEX),
        indexes.FEEDBACK_BY_ID_INDEX: 'feedback_id', indexes.FEEDBACK_BY_CHANNEL_INDEX: 'source_channel'}),
    'AGGREGATES_TABLE': TableSchema(indexes={indexes.AGGREGATES_BY_METRIC_TYPE_INDEX: 'metric_type'}),
    'PROJECTS_TABLE': TableSchema(indexes=_pairs(indexes.PROJECTS_BY_TYPE_INDEX)),
    'JOBS_TABLE': TableSchema(indexes=_pairs(indexes.JOBS_BY_STATUS_INDEX)),
    'CONVERSATIONS_TABLE': TableSchema(indexes={indexes.CONVERSATIONS_BY_KIND_INDEX: 'kind'}),
    'MEMORY_TABLE': TableSchema(indexes=_pairs(indexes.MEMORY_BY_STATUS_INDEX)),
    'AGENTS_TABLE': TableSchema(indexes=_pairs(indexes.AGENTS_LISTING_INDEX)),
    'RADAR_TABLE': TableSchema(),
    'PARTICIPANTS_TABLE': TableSchema(indexes=_pairs(indexes.PARTICIPANTS_LISTING_INDEX)),
    'FEATURE_REQUESTS_TABLE': TableSchema(indexes=_pairs(indexes.FEATURE_REQUESTS_LISTING_INDEX)),
}


class WorkspaceScopeError(ValueError):
    """A key, object key or table outside the workspace's reach: refused before any AWS call."""


def _require_workspace(ws: str) -> None:
    if not is_workspace_id(ws):
        raise WorkspaceScopeError('not a workspace id')


def ws_s3_key(ws: str, *parts: str) -> str:
    """``ws/{ws}/a/b``: an object key inside the workspace's prefix (``ws/{ws}/raw/…``, ``ws/{ws}/avatars/…``)."""
    _require_workspace(ws)
    if not parts:
        raise WorkspaceScopeError('an object key needs a part after the workspace')
    for part in parts:
        if part in {'.', '..'} or not _S3_PART.fullmatch(part):
            raise WorkspaceScopeError('an object key part must be one non-empty path segment')
    return '/'.join(('ws', ws, *parts))


class WorkspaceTable:
    """A DynamoDB table seen through one workspace (see the module docstring)."""

    # Fixed state: no __dict__, and no attribute can be set or deleted once built. Private to this module: the
    # raw-access audit counts any `_` attribute of a handle, vars() or __dict__ used outside it.
    __slots__ = ('_prefix', '_schema', '_unscoped_table', '_ws')
    _prefix: str
    _schema: TableSchema
    _unscoped_table: Any
    _ws: str

    def __init__(self, ws: str, unscoped_table: Any, schema: TableSchema) -> None:
        _require_workspace(ws)
        for name, value in (('_ws', ws), ('_unscoped_table', unscoped_table), ('_schema', schema),
                            ('_prefix', ws_key(ws) + '#')):
            object.__setattr__(self, name, value)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError('a WorkspaceTable cannot be changed')

    def __delattr__(self, name: str) -> None:
        raise AttributeError('a WorkspaceTable cannot be changed')

    @property
    def ws(self) -> str:
        """The workspace this table is seen through."""
        return self._ws

    def _check_value(self, value: object) -> None:
        if not (isinstance(value, str) and value.startswith(self._prefix) and len(value) > len(self._prefix)):
            raise WorkspaceScopeError('key outside the workspace')

    def _check_key(self, key: Mapping[str, Any]) -> dict[str, Any]:
        self._check_value(key.get(self._schema.partition_key))
        return dict(key)

    def get_item(self, *, Key: Mapping[str, Any], **kwargs: Any) -> dict[str, Any]:
        """``GetItem``: boto3's response (``['Item']`` when found)."""
        _check_options('get_item', kwargs)
        return self._unscoped_table.get_item(Key=self._check_key(Key), **kwargs)

    def put_item(self, *, Item: Mapping[str, Any], **kwargs: Any) -> dict[str, Any]:
        """``PutItem``: the partition attribute and every index partition attribute the item carries must be inside
        the workspace."""
        _check_options('put_item', kwargs)
        row = self._check_key(Item)
        for name in self._schema.indexes.values():
            if name in row:
                self._check_value(row[name])
        return self._unscoped_table.put_item(Item=row, **kwargs)

    def update_item(self, *, Key: Mapping[str, Any], **kwargs: Any) -> dict[str, Any]:
        """``UpdateItem`` of the item at ``Key``. Refused when the ``UpdateExpression`` names a key or index partition
        attribute, as a plain word or as a ``#placeholder`` it uses (resolved through ``ExpressionAttributeNames``;
        a name used only by the ``ConditionExpression`` passes). Set index keys with ``put_item``."""
        _check_options('update_item', kwargs)
        key = self._check_key(Key)
        expression = kwargs.get('UpdateExpression') or ''
        names = kwargs.get('ExpressionAttributeNames') or {}
        words = set(_WORD.findall(_PLACEHOLDER.sub(' ', expression)))
        words |= {names.get(placeholder, placeholder) for placeholder in _NAME_PLACEHOLDER.findall(expression)}
        if words & self._schema.scoped_attributes:
            raise WorkspaceScopeError('an update may not name a key or index partition attribute: use put_item')
        return self._unscoped_table.update_item(Key=key, **kwargs)

    def delete_item(self, *, Key: Mapping[str, Any], **kwargs: Any) -> dict[str, Any]:
        """``DeleteItem`` of the item at ``Key``."""
        _check_options('delete_item', kwargs)
        return self._unscoped_table.delete_item(Key=self._check_key(Key), **kwargs)

    def query(self, partition: str, *, sort: ConditionBase | None = None, index: str | None = None,
              **kwargs: Any) -> dict[str, Any]:
        """One ``Query`` page of the partition ``partition`` (``WS#{ws}#…``), on the table or on the index named
        ``index`` (one of the table's); ``sort`` narrows the sort key (``Key('sk').begins_with(…)``). Not boto3's
        form: a ``KeyConditionExpression`` of the caller's is refused, and so is an ``ExclusiveStartKey`` outside the
        workspace."""
        if 'KeyConditionExpression' in kwargs or 'IndexName' in kwargs:
            raise WorkspaceScopeError('name the partition and the index, not a KeyConditionExpression or IndexName')
        _check_options('query', kwargs)
        if index is not None and index not in self._schema.indexes:
            raise WorkspaceScopeError('not an index of this table')
        attribute = self._schema.partition_key if index is None else self._schema.indexes[index]
        self._check_value(partition)
        start = kwargs.get('ExclusiveStartKey')
        if start is not None:
            for name in {self._schema.partition_key, attribute}:
                self._check_value(start.get(name))
        condition = Key(attribute).eq(partition)
        if index is not None:
            kwargs['IndexName'] = index
        return self._unscoped_table.query(KeyConditionExpression=condition if sort is None else condition & sort, **kwargs)


def ws_table(ws: str, env_var: str) -> WorkspaceTable:
    """The workspace-keyed table the environment variable ``env_var`` names (one of ``TABLES``), seen through
    ``ws``; a variable that is unset or empty is a ``ConfigurationError`` (a 500)."""
    _require_workspace(ws)
    schema = TABLES.get(env_var)
    if schema is None:
        raise WorkspaceScopeError('not a workspace-keyed table')
    name = os.environ.get(env_var, '')
    if not name:
        raise ConfigurationError(f'{env_var} not configured')
    return WorkspaceTable(ws, cached_table(get_dynamodb_resource(), name), schema)
