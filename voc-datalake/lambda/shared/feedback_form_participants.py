"""Attribute a feedback-form answer to the participant ask it came from (docs/participants.md).

An ask's form link opens the widget page with ``?r=<response token>``; the page posts
it back as ``participant_token`` with the answer. When the token resolves
(``TOKEN#{sha256}`` / ``RESPONSE`` in voc-participants) the submission carries
``metadata.participant = {person_id, ask_id, project_id?}`` and, once it is queued, the
recipient is marked ``responded`` (counted once on the ask). An unknown token, a
missing table (``PARTICIPANTS_TABLE`` unset: the feature is off) or a failed read are
all ignored silently: an attribution never blocks an answer.

Called by the public submit route of ``api/feedback_form_handler.py``; it needs
GetItem + UpdateItem on the participants table and nothing else.
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from functools import lru_cache
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import get_dynamodb_resource
from shared.logging import logger
from shared.participants_asks import RESPONSE_SK, mark_responded, resolve_token

ATTRIBUTION_FIELD = 'participant_token'


@lru_cache(maxsize=4)
def _table(name: str) -> Any:
    return get_dynamodb_resource().Table(name)


def _participants_table() -> Any | None:
    name = os.environ.get('PARTICIPANTS_TABLE', '')
    return _table(name) if name else None


def resolve_participant(body: Mapping[str, Any]) -> dict[str, str] | None:
    """``{person_id, ask_id, project_id?}`` for the body's ``participant_token``, else None."""
    token = body.get(ATTRIBUTION_FIELD)
    table = _participants_table() if token else None
    if table is None:
        return None
    try:
        row = resolve_token(table, token, RESPONSE_SK)
    except (ClientError, BotoCoreError):
        logger.exception('Participant token could not be read; the answer is kept unattributed')
        return None
    if row is None or not isinstance(row.get('ask_id'), str):
        return None
    ref = {'person_id': str(row['person_id']), 'ask_id': str(row['ask_id'])}
    if isinstance(row.get('project_id'), str):
        ref['project_id'] = row['project_id']
    return ref


def record_response(ref: Mapping[str, str] | None) -> None:
    """Mark the recipient ``responded`` (once); a failure is logged, never raised."""
    if not ref:
        return
    table = _participants_table()
    if table is None:
        return
    try:
        if mark_responded(table, ref['ask_id'], ref['person_id']):
            logger.info('Participant responded', extra={'ask_id': ref['ask_id'], 'person_id': ref['person_id']})
    except (ClientError, BotoCoreError):
        logger.exception('Participant response could not be recorded')
