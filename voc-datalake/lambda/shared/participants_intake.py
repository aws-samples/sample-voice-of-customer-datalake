"""People named in a request body: existing ``person_ids`` plus new ``people`` by email.

Shared by ``POST /participants/lists/{id}/members`` and ``POST /participants/projects/{id}``.
A new person whose address is invalid, or external while external people are off,
is reported in ``rejected`` (``{email, reason}``) and the rest go ahead; a known
address resolves to its existing person, unsubscribed or not (they are skipped
at send, never re-subscribed).

A new person's ``origin`` is ``manual`` unless the body says ``origin: 'assistant'`` (the AI
assistant's approved ``add_participants`` card). ``feature_request`` is set only by the board,
server-side: a client cannot claim it (400).
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from shared.engagement_common import id_list
from shared.exceptions import NotFoundError, ValidationError
from shared.participants_store import PERSON_NOT_FOUND, PERSON_PREFIX, REASON_INVALID_EMAIL, get_people, upsert_person

MAX_PEOPLE_PER_REQUEST: Final = 200
MAX_REJECTED_EMAIL_CHARS: Final = 254
#: The origins a client may claim for the people it adds (``feature_request`` is the board's own).
CLIENT_ORIGINS: Final = ('manual', 'assistant')


@dataclass
class Intake:
    person_ids: list[str] = field(default_factory=list)
    created: int = 0
    rejected: list[dict[str, str]] = field(default_factory=list)


def _new_people(body: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    people = body.get('people')
    if people is None:
        return []
    if not isinstance(people, list) or not all(isinstance(entry, dict) for entry in people):
        raise ValidationError('people must be a list of objects with an email')
    return people


def _rejected(entry: Mapping[str, Any], reason: str) -> dict[str, str]:
    email = entry.get('email')
    return {'email': email.strip()[:MAX_REJECTED_EMAIL_CHARS] if isinstance(email, str) else '', 'reason': reason}


def client_origin(body: Mapping[str, Any]) -> str:
    """The body's ``origin`` (default ``manual``); 400 for anything outside CLIENT_ORIGINS."""
    origin = body.get('origin', 'manual')
    if not isinstance(origin, str) or origin not in CLIENT_ORIGINS:
        raise ValidationError(f'origin must be one of: {", ".join(CLIENT_ORIGINS)}')
    return origin


def collect_people(table: Any, settings: Mapping[str, Any], body: Mapping[str, Any], *, created_by: str) -> Intake:
    """Resolve ``person_ids`` (404 for an unknown one) and ``people`` (created as needed, with the body's
    ``origin``), de-duplicated."""
    origin = client_origin(body)
    person_ids = id_list(body.get('person_ids'), 'person_ids', PERSON_PREFIX, MAX_PEOPLE_PER_REQUEST)
    new_people = _new_people(body)
    if len(person_ids) + len(new_people) > MAX_PEOPLE_PER_REQUEST:
        raise ValidationError(f'at most {MAX_PEOPLE_PER_REQUEST} people per request')
    if person_ids and len(get_people(table, person_ids)) != len(person_ids):
        raise NotFoundError(PERSON_NOT_FOUND)
    intake = Intake(person_ids=list(person_ids))
    for entry in new_people:
        try:
            person_id, created = upsert_person(table, settings, entry, origin=origin, created_by=created_by)
        except ValueError as exc:
            intake.rejected.append(_rejected(entry, str(exc) or REASON_INVALID_EMAIL))
            continue
        intake.created += int(created)
        if person_id not in intake.person_ids:
            intake.person_ids.append(person_id)
    return intake
