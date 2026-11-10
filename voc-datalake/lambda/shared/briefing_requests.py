"""Read and refresh one user's brief (``/settings/my-briefing/brief|refresh|cards``).

Refresh is open to everyone, with no cap, and rebuilds only the caller's own brief
(the org layer of their group only when it is stale). The free debounce: with no
review processed since the last brief AND that brief younger than 15 minutes, a
refresh answers ``up_to_date`` at once — no message, no model call. A build already
running answers ``pending`` (no second message).
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared import briefing_prefs as prefs
from shared import briefing_store as store
from shared.aws import get_sqs_client
from shared.exceptions import ConfigurationError, ServiceError
from shared.logging import logger
from shared.project_access import Caller

QUEUE_ENV: Final = 'BRIEFING_QUEUE_URL'
REASON_REFRESH: Final = 'refresh'
REASON_SCHEDULED: Final = 'scheduled'


def build_message(sub: str, username: str, reason: str) -> str:
    """The ``voc-briefing`` queue body (the worker validates it)."""
    return json.dumps({'kind': 'build', 'sub': sub, 'username': username, 'reason': reason})


def _queue_url() -> str:
    url = os.environ.get(QUEUE_ENV, '')
    if not url:
        raise ConfigurationError('The morning brief is not configured')
    return url


def _send(url: str, caller: Caller) -> None:
    try:
        get_sqs_client().send_message(QueueUrl=url, MessageBody=build_message(caller.subject, caller.username,
                                                                              REASON_REFRESH))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Brief refresh: enqueue failed')
        raise ServiceError('Could not start the brief. Please retry.') from exc


def get_brief(table: Any, sub: str, now: datetime) -> dict[str, Any]:
    return store.brief_view(store.latest_brief(table, sub), now)


def follow_ui_language(table: Any, sub: str, row: Mapping[str, Any] | None, ui_language: str | None,
                       now: datetime) -> Mapping[str, Any] | None:
    """The preferences row after the reader's UI language applies to it.

    A brief language the reader CHOSE in the brief settings always wins. Otherwise (no row, no
    ``language_source``, or ``ui``) the brief follows the app: the UI language is stored on the row
    as ``language_source: 'ui'``, so this build, the scheduled brief and the email all read it.
    """
    if ui_language is None or prefs.language_source(row) == prefs.LANGUAGE_CHOSEN:
        return row
    if prefs.stored_preferences(row)['language'] == ui_language:
        return row
    answer = table.update_item(
        Key=prefs.preferences_key(sub),
        UpdateExpression='SET #language = :language, language_source = :source, updated_at = :now',
        ExpressionAttributeNames={'#language': 'language'},
        ExpressionAttributeValues={':language': ui_language, ':source': prefs.LANGUAGE_UI, ':now': now.isoformat()},
        ReturnValues='ALL_NEW',
    )
    return answer.get('Attributes')


def refresh(table: Any, caller: Caller, now: datetime, ui_language: str | None = None) -> dict[str, Any]:
    """``{status: up_to_date | pending, brief}`` — the caller's brief is rebuilt unless fresh.

    ``ui_language`` is the language the reader uses the app in (the optional refresh body); the
    brief is written in it unless they chose a brief language (``follow_ui_language``).
    """
    latest = store.latest_brief(table, caller.subject)
    if store.is_building(latest, now):
        return {'status': store.STATUS_PENDING, 'brief': store.brief_view(latest, now)}
    row = table.get_item(Key=prefs.preferences_key(caller.subject)).get('Item')
    row = follow_ui_language(table, caller.subject, row, ui_language, now)
    settings = prefs.stored_preferences(row)
    marker = store.feedback_marker(table, now)
    if store.is_up_to_date(latest, marker, now, store.settings_marker(settings)):
        return {'status': 'up_to_date', 'brief': store.brief_view(latest, now)}
    url = _queue_url()
    day = prefs.local_day(settings['time_zone'], now)
    pending = store.mark_pending(table, caller.subject, day, now)
    try:
        _send(url, caller)
    except ServiceError:
        store.mark_failed(table, caller.subject, day, now)
        raise
    return {'status': store.STATUS_PENDING, 'brief': store.brief_view(pending, now)}
