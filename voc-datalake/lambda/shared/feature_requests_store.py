"""Requests and their supports on the feedback boards, in voc-feature-requests (docs/feature-requests.md).

``FR#{id}`` / ``META`` is the request (its board in ``board_id``: absent = the seeded board, so
requests filed before boards read as the Sales board's; its board-field values in ``fields``);
``FR#{id}`` / ``SUP#{id}`` one support (a +1, its field values as top-level attributes, the
shape from before boards). Creating a request writes META, the reporter's own support
(``is_reporter``) and the board's ``request_count`` in one transaction. ``totals`` on META are
RECOMPUTED from the support rows (the keys per board template, ``TEMPLATE_TOTALS``) after every
change and written with a ``version`` condition, retried once on a conflict.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.dynamo_paging import count_query, query_all
from shared.dynamo_values import as_count
from shared.engagement_common import (
    conditional_write,
    new_id,
    now_iso,
    optional_text,
    public_fields,
    required_text,
    update_existing,
)
from shared.exceptions import ConflictError, NotFoundError
from shared.feature_board_fields import SUPPORT_FIELD_KEYS, TEMPLATE_TOTALS, template_of
from shared.feature_boards_store import BOARD_NOT_FOUND, SEEDED_BOARD_ID, board_key
from shared.indexes import FEATURE_REQUESTS_LISTING_INDEX

REQUEST_PREFIX: Final = 'fr'
SUPPORT_PREFIX: Final = 'sup'
REQUESTS_PARTITION: Final = 'FRS'
MAX_TITLE: Final = 160
MAX_DESCRIPTION: Final = 4000
MAX_NAME: Final = 160
MAX_REQUESTS_LISTED: Final = 1000
MAX_SUPPORTS: Final = 2000
REQUEST_NOT_FOUND: Final = 'Feature request not found'
SUPPORT_NOT_FOUND: Final = 'Support not found'
_HIDDEN: Final = frozenset({'version'})


def request_key(request_id: str) -> dict[str, str]:
    return {'pk': f'FR#{request_id}', 'sk': 'META'}


def support_key(request_id: str, support_id: str) -> dict[str, str]:
    return {'pk': f'FR#{request_id}', 'sk': f'SUP#{support_id}'}


def board_id_of(request: Mapping[str, Any]) -> str:
    board_id = request.get('board_id')
    return board_id if isinstance(board_id, str) and board_id else SEEDED_BOARD_ID


def empty_totals(template: str) -> dict[str, Any]:
    return {key: (None if key == 'avg_rating' else 0) for key in TEMPLATE_TOTALS[template_of(template)]}


def request_view(item: Mapping[str, Any], template: str) -> dict[str, Any]:
    view = public_fields(item, _HIDDEN)
    keys = TEMPLATE_TOTALS[template_of(template)]
    raw = view.get('totals')
    stored: dict[str, Any] = raw if isinstance(raw, dict) else {}
    view['totals'] = {**empty_totals(template), **{key: stored[key] for key in keys if key in stored}}
    view['board_id'] = board_id_of(item)
    view['fields'] = view['fields'] if isinstance(view.get('fields'), dict) else {}
    return view


def support_view(item: Mapping[str, Any]) -> dict[str, Any]:
    view = public_fields(item, frozenset())
    view['fields'] = {key: view[key] for key in SUPPORT_FIELD_KEYS if key in view}
    return view


def request_text(body: Mapping[str, Any], *, partial: bool, description_required: bool) -> dict[str, Any]:
    """Title (≤ 160, required) and description (≤ 4000, required when ``description_required``, the
    board template's rule in ``shared.feature_board_fields``): on every board."""
    fields: dict[str, Any] = {}
    if not partial or 'title' in body:
        fields['title'] = required_text(body, 'title', MAX_TITLE)
    if not partial or 'description' in body:
        read = required_text if description_required else optional_text
        fields['description'] = read(body, 'description', MAX_DESCRIPTION) or ''
    return fields


def poster_name(body: Mapping[str, Any]) -> str:
    return optional_text(body, 'name', MAX_NAME) or ''


# ── Reads ─────────────────────────────────────────────────────────────────────

def get_request(table: Any, request_id: str) -> dict[str, Any] | None:
    item = table.get_item(Key=request_key(request_id), ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else None


def require_request(table: Any, request_id: str) -> dict[str, Any]:
    item = get_request(table, request_id)
    if item is None:
        raise NotFoundError(REQUEST_NOT_FOUND)
    return item


def supports_of(table: Any, request_id: str) -> list[dict[str, Any]]:
    """The request's supports, oldest first."""
    rows = query_all(table, {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :s)',
        'ExpressionAttributeValues': {':pk': f'FR#{request_id}', ':s': 'SUP#'},
        'ConsistentRead': True,
    }, max_items=MAX_SUPPORTS)
    return sorted(rows, key=lambda row: str(row.get('created_at', '')))


def list_requests(table: Any) -> list[dict[str, Any]]:
    """Every request of every board, newest first (``gsi1``)."""
    return query_all(table, {
        'IndexName': FEATURE_REQUESTS_LISTING_INDEX, 'KeyConditionExpression': 'gsi1pk = :p',
        'ExpressionAttributeValues': {':p': REQUESTS_PARTITION}, 'ScanIndexForward': False,
    }, max_items=MAX_REQUESTS_LISTED)


def requests_of_board(table: Any, board_id: str) -> list[dict[str, Any]]:
    """The board's requests, newest first (at most ``MAX_REQUESTS_LISTED`` OF THIS BOARD)."""
    return board_requests(table, board_id, limit=MAX_REQUESTS_LISTED, newest_first=True)


def _board_requests_query(board_id: str) -> dict[str, Any]:
    """The gsi1 ``FRS`` partition filtered to one board (the seeded board also owns every request
    without ``board_id``, the ones filed before boards)."""
    condition = 'board_id = :b'
    if board_id == SEEDED_BOARD_ID:
        condition += ' OR attribute_not_exists(board_id)'
    return {'IndexName': FEATURE_REQUESTS_LISTING_INDEX, 'KeyConditionExpression': 'gsi1pk = :p',
            'FilterExpression': condition, 'ExpressionAttributeValues': {':p': REQUESTS_PARTITION, ':b': board_id}}


def board_requests(table: Any, board_id: str, *, limit: int, newest_first: bool = False) -> list[dict[str, Any]]:
    """Up to ``limit`` of the board's requests, oldest first by default. Pages the whole ``FRS``
    partition until ``limit`` match, so it never depends on how many OTHER boards' requests exist."""
    kwargs = {**_board_requests_query(board_id), 'ScanIndexForward': not newest_first}
    return query_all(table, kwargs, max_items=limit)


def has_requests(table: Any, board_id: str) -> bool:
    return bool(board_requests(table, board_id, limit=1))


def count_board_requests(table: Any, board_id: str) -> int:
    return count_query(table, _board_requests_query(board_id))


# ── Totals ────────────────────────────────────────────────────────────────────

def _sales_totals(supports: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Distinct customers (case-insensitive) and the USD sums per impact."""
    totals = {'customers': len({str(row.get('customer', '')).strip().lower()
                                for row in supports if str(row.get('customer', '')).strip()}),
              'committed_usd': 0, 'at_risk_usd': 0}
    for row in supports:
        amount = int(row.get('amount_usd') or 0)
        if row.get('impact') == 'committed':
            totals['committed_usd'] += amount
        elif row.get('impact') == 'at_risk':
            totals['at_risk_usd'] += amount
    return totals


def compute_totals(supports: Sequence[Mapping[str, Any]], template: str = 'sales',
                   values: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The template's totals. ``supporters``: distinct supporter emails. Sales adds customers and
    the committed / at-risk dollars; service adds ``affected`` (the reporter's ``affected_count``,
    at least 1, plus every other supporter); beta adds ``avg_rating`` (the request's rating)."""
    values = values or {}
    supporters = len({str(row.get('email', '')).lower() for row in supports if row.get('email')})
    totals: dict[str, Any] = {'supporters': supporters}
    kind = template_of(template)
    if kind == 'sales':
        totals.update(_sales_totals(supports))
    elif kind == 'service':
        totals['affected'] = max(as_count(values.get('affected_count')), 1) + max(supporters - 1, 0)
    elif kind == 'beta':
        totals['avg_rating'] = as_count(values.get('rating')) or None
    return totals


def _write_totals(table: Any, request_id: str, totals: Mapping[str, Any], version: int) -> dict[str, Any]:
    response = table.update_item(
        Key=request_key(request_id),
        UpdateExpression='SET totals = :t, version = :next, updated_at = :now',
        ConditionExpression='attribute_exists(pk) AND version = :v',
        ExpressionAttributeValues={':t': dict(totals), ':v': version, ':next': version + 1, ':now': now_iso()},
        ReturnValues='ALL_NEW',
    )
    return response['Attributes']


TOTALS_ATTEMPTS: Final = 2
TOTALS_CONFLICT: Final = 'The request changed while it was being updated. Please retry.'


def recompute_totals(table: Any, request_id: str, template: str = 'sales') -> dict[str, Any]:
    """Recompute and store ``totals`` (version-conditional, retried once); the new META."""
    for _ in range(TOTALS_ATTEMPTS):
        meta = require_request(table, request_id)
        values = meta.get('fields') if isinstance(meta.get('fields'), dict) else {}
        totals = compute_totals(supports_of(table, request_id), template, values)
        try:
            return _write_totals(table, request_id, totals, int(meta.get('version') or 0))
        except ClientError as error:
            if not is_conditional_check_failure(error):
                raise
    raise ConflictError(TOTALS_CONFLICT)


# ── Writes ────────────────────────────────────────────────────────────────────

def new_support(request_id: str, fields: Mapping[str, Any], email: str, *, is_reporter: bool) -> dict[str, Any]:
    support_id = new_id(SUPPORT_PREFIX)
    now = now_iso()
    return {**support_key(request_id, support_id), 'support_id': support_id, 'request_id': request_id,
            **fields, 'email': email, 'is_reporter': is_reporter, 'created_at': now, 'updated_at': now}


def create_request(table: Any, board: Mapping[str, Any], meta_fields: Mapping[str, Any],
                   support: Mapping[str, Any], reporter: tuple[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    """META (``meta_fields``: title, description, status, fields) + the reporter's support + the
    board's ``request_count``, in one transaction; ``(META, support)``. ``reporter``: (email, name)."""
    email, name = reporter
    request_id = new_id(REQUEST_PREFIX)
    now = now_iso()
    board_id = str(board['board_id'])
    sup = new_support(request_id, support, email, is_reporter=True)
    values = meta_fields.get('fields') or {}
    meta = {**request_key(request_id), 'request_id': request_id, **meta_fields, 'board_id': board_id,
            'reporter_email': email, 'reporter_name': name, 'created_at': now, 'updated_at': now,
            'totals': compute_totals([sup], str(board.get('template', '')), values), 'version': 0,
            'gsi1pk': REQUESTS_PARTITION, 'gsi1sk': f'{now}#{request_id}'}
    absent = 'attribute_not_exists(pk)'
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table.name, 'Item': meta, 'ConditionExpression': absent}},
            {'Put': {'TableName': table.name, 'Item': sup, 'ConditionExpression': absent}},
            {'Update': {'TableName': table.name, 'Key': board_key(board_id),
                        'UpdateExpression': 'ADD request_count :one', 'ConditionExpression': 'attribute_exists(pk)',
                        'ExpressionAttributeValues': {':one': 1}}},
        ])
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise NotFoundError(BOARD_NOT_FOUND) from error  # the board was deleted meanwhile
        raise
    return meta, sup


def update_request(table: Any, request_id: str, fields: Mapping[str, Any]) -> dict[str, Any]:
    """SET ``fields`` (at least one) on META, bumping ``version`` so a concurrent recompute retries."""
    return update_existing(table, request_key(request_id), fields, REQUEST_NOT_FOUND, bump_version=True)


def delete_request(table: Any, request: Mapping[str, Any]) -> None:
    """The request, every support, and one off its board's ``request_count`` (never below 0)."""
    request_id = str(request['request_id'])
    with table.batch_writer() as batch:
        for row in supports_of(table, request_id):
            batch.delete_item(Key={'pk': row['pk'], 'sk': row['sk']})
    table.delete_item(Key=request_key(request_id))
    conditional_write(table.update_item, Key=board_key(board_id_of(request)),
                      UpdateExpression='ADD request_count :minus',
                      ConditionExpression='attribute_exists(pk) AND request_count > :zero',
                      ExpressionAttributeValues={':minus': -1, ':zero': 0})


def get_support(table: Any, request_id: str, support_id: str) -> dict[str, Any]:
    item = table.get_item(Key=support_key(request_id, support_id), ConsistentRead=True).get('Item')
    if not isinstance(item, dict):
        raise NotFoundError(SUPPORT_NOT_FOUND)
    return item


def put_support(table: Any, item: Mapping[str, Any], *, replacing: bool = False) -> None:
    """Write a support row. ``replacing``: only over the row that is still there (NotFoundError when a
    concurrent delete removed it, so an edit never brings a deleted +1 back)."""
    if not replacing:
        table.put_item(Item=dict(item))
        return
    if not conditional_write(table.put_item, Item=dict(item), ConditionExpression='attribute_exists(pk)'):
        raise NotFoundError(SUPPORT_NOT_FOUND)


def delete_support(table: Any, request_id: str, support_id: str) -> None:
    table.delete_item(Key=support_key(request_id, support_id))
