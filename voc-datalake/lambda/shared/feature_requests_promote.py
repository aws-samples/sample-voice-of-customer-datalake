"""Promote a feature request into a project (``POST /feature-requests/{id}/promote``, admin).

Every distinct supporter email and every contact email becomes a person (origin
``feature_request``; an existing person is reused). External contacts are skipped
when the engagement settings turn external people off, and reported. They all join
the list ``Requests: {title}`` (kind ``requesters``, created once, then reused through
the request's ``list_id``), which is linked to the project. The request records
``project_id`` / ``list_id`` and, on a board with a ``planned`` status, moves to it when it was
in the board's first status or ``under_review``.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final

from shared.feature_board_fields import status_keys
from shared.feature_requests_store import supports_of, update_request
from shared.logging import logger
from shared.participants_lists import MAX_LIST_NAME, add_member, create_list, get_list, link, list_view
from shared.participants_store import REASON_INVALID_EMAIL, upsert_person

LIST_NAME_PREFIX: Final = 'Requests: '
PLANNED: Final = 'planned'
UNDER_REVIEW: Final = 'under_review'


def promoted_emails(supports: Sequence[Mapping[str, Any]]) -> list[tuple[str, str]]:
    """``(email, name)`` for every distinct supporter and contact address, in support order."""
    found: dict[str, str] = {}
    for row in supports:
        for field, name in (('email', row.get('name')), ('contact_email', '')):
            value = row.get(field)
            if isinstance(value, str) and value and value.lower() not in found:
                found[value.lower()] = name if isinstance(name, str) else ''
    return list(found.items())


def _requests_list(participants: Any, request: Mapping[str, Any], created_by: str) -> dict[str, Any]:
    existing = get_list(participants, str(request['list_id'])) if request.get('list_id') else None
    if existing is not None:
        return existing
    name = f'{LIST_NAME_PREFIX}{request.get("title", "")}'[:MAX_LIST_NAME]
    return create_list(participants, {'name': name, 'gsi1sk': name.lower(), 'kind': 'requesters',
                                      'description': ''}, created_by, feature_request_id=request['request_id'])


def _moves_to_planned(board: Mapping[str, Any], status: object) -> bool:
    keys = status_keys(board)
    return PLANNED in keys and status in {keys[0], UNDER_REVIEW} and status != PLANNED


def promote(requests_table: Any, participants: Any, request: Mapping[str, Any], board: Mapping[str, Any],
            project_id: str, settings: Mapping[str, Any], created_by: str) -> dict[str, Any]:
    """Run the promotion (see the module docstring); the route's answer body."""
    request_id = str(request['request_id'])
    the_list = _requests_list(participants, request, created_by)
    list_id = str(the_list['list_id'])
    added = 0
    skipped: list[dict[str, str]] = []
    for email, name in promoted_emails(supports_of(requests_table, request_id)):
        try:
            person_id, _ = upsert_person(participants, settings, {'email': email, 'name': name},
                                         origin='feature_request', created_by=created_by)
        except ValueError as exc:
            skipped.append({'email': email, 'reason': str(exc) or REASON_INVALID_EMAIL})
            continue
        added += int(add_member(participants, list_id, person_id, created_by))
    link(participants, project_id, 'LIST', list_id, created_by)
    changes: dict[str, Any] = {'project_id': project_id, 'list_id': list_id}
    if _moves_to_planned(board, request.get('status')):
        changes['status'] = PLANNED
    updated = update_request(requests_table, request_id, changes)
    logger.info('Feature request promoted', extra={'request_id': request_id, 'project_id': project_id,
                                                   'added': added, 'skipped': len(skipped)})
    refreshed = get_list(participants, list_id) or the_list
    return {'request': updated, 'list': list_view(refreshed), 'added': added, 'skipped': skipped}

