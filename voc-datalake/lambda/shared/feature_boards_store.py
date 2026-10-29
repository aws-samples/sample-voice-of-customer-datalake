"""Feedback boards in voc-feature-requests (docs/feature-requests.md -> Data model).

``BOARD#{id}`` / ``META`` is a board (gsi1pk ``BOARDS``, gsi1sk the lower-cased name);
``SLUG#{slug}`` / ``BOARD`` guards the slug's uniqueness and is written in ONE transaction with
META on create and rename. Every save, archive and delete also rewrites the boards' derived
sign-up row in the participants table (``shared.feature_boards_audience``).

``paused`` (+ ``paused_at`` / ``paused_by`` while it is) is the TEMPORARY stop: the board stays
visible to its audience and in the sign-up row, but takes no new request, +1 or edit
(``shared.feature_requests_routes``). ``archived`` is the PERMANENT step before delete: hidden from
everyone but admins and from the sign-up row.

The seeded board ``brd_sales`` (slug ``sales-feature-requests``, template ``sales``, audience
``company``) is created ONCE, by the first read that finds no board at all, so the requests filed
before boards (no ``board_id``) have a home: a request without ``board_id`` is that board's. The
marker ``BOARDS#SEEDED`` / ``META`` (no gsi1pk, so never listed as a board) is written with it and
by every board delete, so deleting the last board leaves an empty list instead of a new seed.
"""
from __future__ import annotations

import re
import secrets
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.dynamo_paging import query_all
from shared.engagement_common import optional_text, public_fields, required_text, update_existing
from shared.exceptions import ConflictError, ValidationError
from shared.feature_board_fields import (
    template_fields,
    template_statuses,
    validate_fields_config,
    validate_statuses,
    validate_template,
)
from shared.feature_boards_audience import (
    DEFAULT_AUDIENCE,
    audience_of,
    derived_row,
    validate_audience,
    write_derived_row,
)
from shared.indexes import FEATURE_REQUESTS_LISTING_INDEX
from shared.timestamps import now_iso

BOARDS_PARTITION: Final = 'BOARDS'
SEEDED_MARKER_KEY: Final = {'pk': 'BOARDS#SEEDED', 'sk': 'META'}
SEEDED_BOARD_ID: Final = 'brd_sales'
SEEDED_SLUG: Final = 'sales-feature-requests'
SEEDED_NAME: Final = 'Sales feature requests'
MAX_BOARDS: Final = 100
MAX_NAME: Final = 80
MAX_DESCRIPTION: Final = 1000
MAX_SLUG: Final = 60
# Paths of the standalone board page that a slug must never shadow (/board/login, /board/boards).
RESERVED_SLUGS: Final = frozenset({'login', 'boards'})
BOARD_NOT_FOUND: Final = 'Board not found'
SLUG_TAKEN: Final = 'slug_taken'
BOARD_LIMIT: Final = 'board_limit'
_SLUG: Final = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*\Z')
_BOARD_ID: Final = re.compile(r'^brd_(?:[0-9a-f]{8}|sales)\Z')
_SLUG_SUFFIX: Final = 9  # '-' + the 8 hex digits of the board id
_EDITABLE: Final = ('name', 'slug', 'description', 'fields', 'statuses', 'audience', 'archived', 'paused')
# Who paused the board and when: only while it is paused, and ``paused_by`` (a Cognito sub) for admins only.
_PAUSE_STAMP: Final = ('paused_at', 'paused_by')


def board_key(board_id: str) -> dict[str, str]:
    return {'pk': f'BOARD#{board_id}', 'sk': 'META'}


def slug_key(slug: str) -> dict[str, str]:
    return {'pk': f'SLUG#{slug}', 'sk': 'BOARD'}


def is_board_id(value: object) -> bool:
    return isinstance(value, str) and bool(_BOARD_ID.match(value))


def is_slug(value: object) -> bool:
    return isinstance(value, str) and len(value) <= MAX_SLUG and bool(_SLUG.match(value))


def slug_from(name: str) -> str:
    """A slug from a name (``Beta feedback`` -> ``beta-feedback``); ``board`` when nothing is left."""
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:MAX_SLUG].strip('-')
    return slug if slug and slug not in RESERVED_SLUGS else 'board'


def validate_slug(value: object) -> str:
    if not is_slug(value) or value in RESERVED_SLUGS:
        raise ValidationError(f'slug must be at most {MAX_SLUG} lower-case letters, digits and single hyphens '
                              f'(not {", ".join(sorted(RESERVED_SLUGS))})')
    return str(value)


def board_view(board: Mapping[str, Any], *, admin: bool, frontend_url: str) -> dict[str, Any]:
    """The wire shape: META without keys, plus the share link; non-admins see the audience mode only."""
    view = public_fields(board, frozenset())
    view['share_url'] = f'{frontend_url}/board/{board.get("slug", "")}' if frontend_url else ''
    view['request_count'] = max(int(board.get('request_count') or 0), 0)
    view['archived'] = board.get('archived') is True
    view['paused'] = is_paused(board)
    audience = audience_of(board)
    view['audience'] = audience if admin else {'mode': audience['mode']}
    if not view['paused']:
        for key in _PAUSE_STAMP:
            view.pop(key, None)
    if not admin:
        view.pop('created_by', None)
        view.pop('paused_by', None)
    return view


def is_paused(board: Mapping[str, Any]) -> bool:
    """A paused board is read as before, but takes no new request, +1 or edit until it is resumed."""
    return board.get('paused') is True


# ── Reads ─────────────────────────────────────────────────────────────────────

def get_board(table: Any, board_id: str) -> dict[str, Any] | None:
    item = table.get_item(Key=board_key(board_id), ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else None


def find_board(table: Any, ref: object) -> dict[str, Any] | None:
    """The board with this id or slug, or None."""
    if is_board_id(ref):
        return get_board(table, str(ref))
    if not is_slug(ref):
        return None
    guard = table.get_item(Key=slug_key(str(ref)), ConsistentRead=True).get('Item') or {}
    return get_board(table, str(guard['board_id'])) if is_board_id(guard.get('board_id')) else None


def list_boards(table: Any) -> list[dict[str, Any]]:
    """Every board (archived too), by name."""
    return query_all(table, {
        'IndexName': FEATURE_REQUESTS_LISTING_INDEX, 'KeyConditionExpression': 'gsi1pk = :p',
        'ExpressionAttributeValues': {':p': BOARDS_PARTITION},
    }, max_items=MAX_BOARDS)


# ── Writes ────────────────────────────────────────────────────────────────────

def _transact(table: Any, items: list[dict[str, Any]]) -> bool:
    """One TransactWriteItems; False when DynamoDB cancelled it (a condition failed)."""
    try:
        table.meta.client.transact_write_items(TransactItems=items)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            return False
        raise
    return True


def _put(table: Any, item: Mapping[str, Any]) -> dict[str, Any]:
    return {'Put': {'TableName': table.name, 'Item': dict(item), 'ConditionExpression': 'attribute_not_exists(pk)'}}


def _refresh_audience(participants: Any, boards: Sequence[Mapping[str, Any]]) -> None:
    write_derived_row(participants, derived_row(boards))


def _with(boards: Sequence[Mapping[str, Any]], board: Mapping[str, Any] | None, board_id: str) -> list[Any]:
    """``boards`` with ``board_id`` replaced by ``board`` (removed when None)."""
    others = [entry for entry in boards if entry.get('board_id') != board_id]
    return [*others, board] if board is not None else others


def _new_board(board_id: str, slug: str, values: Mapping[str, Any], created_by: str) -> dict[str, Any]:
    now = now_iso()
    name = str(values['name'])
    template = str(values['template'])
    return {**board_key(board_id), 'board_id': board_id, 'slug': slug, 'name': name,
            'description': values.get('description', ''), 'template': template,
            'fields': values.get('fields') or template_fields(template),
            'statuses': values.get('statuses') or template_statuses(template),
            'audience': values.get('audience') or dict(DEFAULT_AUDIENCE), 'archived': False, 'paused': False,
            'request_count': int(values.get('request_count', 0)), 'created_at': now, 'created_by': created_by,
            'updated_at': now, 'gsi1pk': BOARDS_PARTITION, 'gsi1sk': name.lower()}


def _seeded_marker() -> dict[str, Any]:
    return dict(SEEDED_MARKER_KEY)


def was_seeded(table: Any) -> bool:
    return 'Item' in table.get_item(Key=SEEDED_MARKER_KEY, ConsistentRead=True)


def seed_if_empty(table: Any, participants: Any, existing_requests: Callable[[], int]) -> list[dict[str, Any]]:
    """Every board; when there is none and none was ever seeded, the seeded Sales board first
    (idempotent). ``existing_requests`` counts the requests it starts with (read only to seed)."""
    boards = list_boards(table)
    if boards or was_seeded(table):
        return boards
    board = _new_board(SEEDED_BOARD_ID, SEEDED_SLUG, {'name': SEEDED_NAME, 'template': 'sales',
                                                      'request_count': existing_requests()}, 'system')
    guard = {**slug_key(SEEDED_SLUG), 'board_id': SEEDED_BOARD_ID}
    if _transact(table, [_put(table, board), _put(table, guard), _put(table, _seeded_marker())]):
        _refresh_audience(participants, [board])
    seeded = get_board(table, SEEDED_BOARD_ID)
    return [seeded] if seeded is not None else []


def validate_create(body: Mapping[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(body) - {'name', 'template', 'slug', 'description', 'audience'})
    if unknown:
        raise ValidationError(f'unknown board field: {unknown[0]}')
    values: dict[str, Any] = {'name': required_text(body, 'name', MAX_NAME),
                              'template': validate_template(body.get('template')),
                              'description': optional_text(body, 'description', MAX_DESCRIPTION)}
    if body.get('slug') is not None:
        values['slug'] = validate_slug(body['slug'])
    if body.get('audience') is not None:
        values['audience'] = validate_audience(body['audience'])
    return values


def create_board(table: Any, participants: Any, values: Mapping[str, Any], created_by: str) -> dict[str, Any]:
    """A new board from validated ``values``; 409 ``slug_taken`` / ``board_limit``."""
    boards = list_boards(table)
    if len(boards) >= MAX_BOARDS:
        raise ConflictError(BOARD_LIMIT)
    suffix = secrets.token_hex(4)
    board_id = f'brd_{suffix}'
    explicit = 'slug' in values
    slug = str(values['slug']) if explicit else slug_from(str(values['name']))
    if not explicit and find_board(table, slug) is not None:
        slug = f'{slug[:MAX_SLUG - _SLUG_SUFFIX]}-{suffix}'
    board = _new_board(board_id, slug, values, created_by)
    row = derived_row(_with(boards, board, board_id))
    if not _transact(table, [_put(table, board), _put(table, {**slug_key(slug), 'board_id': board_id})]):
        raise ConflictError(SLUG_TAKEN)
    write_derived_row(participants, row)
    return board


def validate_update(body: Mapping[str, Any]) -> dict[str, Any]:
    """The editable fields present in ``body``, validated (at least one)."""
    unknown = sorted(set(body) - set(_EDITABLE))
    if unknown:
        raise ValidationError(f'unknown board field: {unknown[0]}')
    checks = {'name': lambda raw: required_text({'name': raw}, 'name', MAX_NAME), 'slug': validate_slug,
              'description': lambda raw: optional_text({'d': raw}, 'd', MAX_DESCRIPTION),
              'fields': validate_fields_config, 'statuses': validate_statuses, 'audience': validate_audience,
              'archived': lambda raw: _flag(raw, 'archived'), 'paused': lambda raw: _flag(raw, 'paused')}
    changes = {key: checks[key](body[key]) for key in _EDITABLE if key in body}
    if not changes:
        raise ValidationError(f'Nothing to update: send any of {", ".join(_EDITABLE)}')
    if 'name' in changes:
        changes['gsi1sk'] = str(changes['name']).lower()
    return changes


def _flag(raw: object, name: str) -> bool:
    if not isinstance(raw, bool):
        raise ValidationError(f'{name} must be true or false')
    return raw


def with_pause_stamp(board: Mapping[str, Any], changes: Mapping[str, Any], by: str) -> dict[str, Any]:
    """``changes`` plus who paused the board and when, set when it pauses and cleared when it resumes
    (a ``paused`` equal to the stored one changes nothing, so the first pause keeps its stamp)."""
    if 'paused' not in changes or changes['paused'] == is_paused(board):
        return dict(changes)
    stamp: dict[str, Any] = ({'paused_at': now_iso(), 'paused_by': by} if changes['paused']
                             else dict.fromkeys(_PAUSE_STAMP))
    return {**changes, **stamp}


def _rename(table: Any, board: Mapping[str, Any], changes: Mapping[str, Any]) -> dict[str, Any]:
    """Slug + META in one transaction: the new guard, the old one removed, the META update."""
    board_id, new_slug = str(board['board_id']), str(changes['slug'])
    names = {f'#f{i}': key for i, key in enumerate(changes)}
    values = {f':v{i}': value for i, value in enumerate(changes.values())}
    sets = ', '.join([*(f'#f{i} = :v{i}' for i in range(len(changes))), 'updated_at = :now'])
    update = {'Update': {'TableName': table.name, 'Key': board_key(board_id), 'UpdateExpression': f'SET {sets}',
                         'ConditionExpression': 'attribute_exists(pk)', 'ExpressionAttributeNames': names,
                         'ExpressionAttributeValues': {**values, ':now': now_iso()}}}
    old = {'Delete': {'TableName': table.name, 'Key': slug_key(str(board.get('slug', '')))}}
    if not _transact(table, [_put(table, {**slug_key(new_slug), 'board_id': board_id}), old, update]):
        raise ConflictError(SLUG_TAKEN)
    return get_board(table, board_id) or {}


def update_board(table: Any, participants: Any, board: Mapping[str, Any], changes: Mapping[str, Any]) -> dict[str, Any]:
    """Apply validated ``changes``; the new META (and the sign-up row rewritten)."""
    board_id = str(board['board_id'])
    boards = list_boards(table)
    row = derived_row(_with(boards, {**board, **changes}, board_id))
    if 'slug' in changes and changes['slug'] != board.get('slug'):
        updated = _rename(table, board, changes)
    else:
        updated = update_existing(table, board_key(board_id), changes, BOARD_NOT_FOUND)
    write_derived_row(participants, row)
    return updated


def delete_board(table: Any, participants: Any, board: Mapping[str, Any]) -> None:
    """The board and its slug guard (the caller checked that no request is left on it). Also marks
    the table seeded (plain put: deployments seeded before the marker), so no board comes back."""
    board_id = str(board['board_id'])
    boards = list_boards(table)
    table.put_item(Item=_seeded_marker())
    table.delete_item(Key=slug_key(str(board.get('slug', ''))))
    table.delete_item(Key=board_key(board_id))
    _refresh_audience(participants, _with(boards, None, board_id))
