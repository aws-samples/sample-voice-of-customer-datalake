"""The engagement settings row (``SETTINGS`` / ``engagement`` in voc-participants).

Read by the engagement API (sending, people creation) and by the board's PreSignUp
trigger (``auth/board_triggers.py``: only an email whose domain is listed may sign
up). Stdlib + a boto3 Table only, so the trigger bundle needs nothing else.

Fields and defaults:
    company_domains        lower-case domains, at most 20 (empty = nobody may join the board)
    allow_external_people  people outside company_domains may be added (default true)
    daily_send_cap         emails per UTC day, 1-5000 (default 500)
    sender_name            the From display name, at most 80 (default = the brand name)
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Final

SETTINGS_KEY: Final = {'pk': 'SETTINGS', 'sk': 'engagement'}
MAX_DOMAINS: Final = 20
MAX_SENDER_NAME: Final = 80
DEFAULT_DAILY_CAP: Final = 500
MIN_DAILY_CAP: Final = 1
MAX_DAILY_CAP: Final = 5000
FALLBACK_SENDER_NAME: Final = 'Customer research'
_DOMAIN: Final = re.compile(r'^(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\Z')
_FIELDS: Final = ('company_domains', 'allow_external_people', 'daily_send_cap', 'sender_name')


def defaults(brand_name: str = '') -> dict[str, Any]:
    return {
        'company_domains': [],
        'allow_external_people': True,
        'daily_send_cap': DEFAULT_DAILY_CAP,
        'sender_name': (brand_name or FALLBACK_SENDER_NAME)[:MAX_SENDER_NAME],
    }


def _stored_domains(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, str) and _DOMAIN.match(entry)][:MAX_DOMAINS]


def _stored_cap(value: object) -> int:
    """The stored cap (DynamoDB answers a Decimal), clamped; the default for anything unreadable."""
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        return DEFAULT_DAILY_CAP
    return min(max(int(value), MIN_DAILY_CAP), MAX_DAILY_CAP)


def from_item(item: Mapping[str, Any] | None, brand_name: str = '') -> dict[str, Any]:
    """The effective settings: the stored row read leniently over the defaults."""
    settings = defaults(brand_name)
    if not item:
        return settings
    settings['company_domains'] = _stored_domains(item.get('company_domains'))
    if isinstance(item.get('allow_external_people'), bool):
        settings['allow_external_people'] = item['allow_external_people']
    settings['daily_send_cap'] = _stored_cap(item.get('daily_send_cap', DEFAULT_DAILY_CAP))
    sender = item.get('sender_name')
    if isinstance(sender, str) and sender.strip():
        settings['sender_name'] = sender.strip()[:MAX_SENDER_NAME]
    for meta in ('updated_at', 'updated_by'):
        if isinstance(item.get(meta), str):
            settings[meta] = item[meta]
    return settings


def load_settings(table: Any, brand_name: str = '') -> dict[str, Any]:
    return from_item(table.get_item(Key=SETTINGS_KEY).get('Item'), brand_name)


def validated_domains(value: object, field: str = 'company_domains', max_items: int = MAX_DOMAINS) -> list[str]:
    """A de-duplicated list of lower-case domains (a leading ``@`` dropped); ValueError otherwise.
    Also the rule of a feedback board's allowed domains (shared/feature_boards_audience.py)."""
    if not isinstance(value, list) or len(value) > max_items:
        raise ValueError(f'{field} must be a list of at most {max_items} domains')
    domains: list[str] = []
    for entry in value:
        domain = entry.strip().lower().removeprefix('@') if isinstance(entry, str) else ''
        if not _DOMAIN.match(domain):
            raise ValueError(f'{field} entries must be domains like example.com')
        if domain not in domains:
            domains.append(domain)
    return domains


def _validated_cap(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not MIN_DAILY_CAP <= value <= MAX_DAILY_CAP:
        raise ValueError(f'daily_send_cap must be a whole number from {MIN_DAILY_CAP} to {MAX_DAILY_CAP}')
    return value


def _validated_sender(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > MAX_SENDER_NAME:
        raise ValueError(f'sender_name must be 1-{MAX_SENDER_NAME} characters')
    return value.strip()


def validate_changes(body: object) -> dict[str, Any]:
    """The settings fields present in ``body``, validated; ValueError (a 400) otherwise."""
    if not isinstance(body, dict):
        raise ValueError('the request body must be a JSON object')
    unknown = sorted(set(body) - set(_FIELDS))
    if unknown:
        raise ValueError(f'unknown settings field: {unknown[0]}')
    changes: dict[str, Any] = {}
    if 'company_domains' in body:
        changes['company_domains'] = validated_domains(body['company_domains'])
    if 'allow_external_people' in body:
        if not isinstance(body['allow_external_people'], bool):
            raise ValueError('allow_external_people must be true or false')
        changes['allow_external_people'] = body['allow_external_people']
    if 'daily_send_cap' in body:
        changes['daily_send_cap'] = _validated_cap(body['daily_send_cap'])
    if 'sender_name' in body:
        changes['sender_name'] = _validated_sender(body['sender_name'])
    return changes


def domain_of(email_lc: str) -> str:
    return email_lc.rsplit('@', 1)[-1]


def is_company_email(settings: Mapping[str, Any], email_lc: str) -> bool:
    """Exact domain match (a subdomain is a different domain): the board's sign-up rule."""
    return domain_of(email_lc) in settings.get('company_domains', [])


def may_add_person(settings: Mapping[str, Any], email_lc: str) -> bool:
    return bool(settings.get('allow_external_people')) or is_company_email(settings, email_lc)


# ── The boards' sign-up audience (SETTINGS / board_audience) ─────────────────
# Rewritten by the engagement API (shared/feature_boards_audience.py) on every board save, archive
# and delete: the union over the NON-archived boards. ``company``: some board admits the company
# domains; ``anyone``: some board admits any verified email; ``domains`` / ``emails``: the union of
# the ``list`` boards' allowed domains and addresses.

BOARD_AUDIENCE_KEY: Final = {'pk': 'SETTINGS', 'sk': 'board_audience'}


def _strings(value: object) -> frozenset[str]:
    return frozenset(entry for entry in value if isinstance(entry, str)) if isinstance(value, list) else frozenset()


def audience_from_item(item: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The stored audience row read leniently; None when no board was ever saved (before boards:
    the one company board, so the company domains alone decide)."""
    if not item:
        return None
    return {'company': item.get('company') is True, 'anyone': item.get('anyone') is True,
            'domains': _strings(item.get('domains')), 'emails': _strings(item.get('emails'))}


def board_audience_admits(audience: Mapping[str, Any] | None, settings: Mapping[str, Any], email_lc: str) -> bool:
    """May ``email_lc`` sign up to the board pool: some non-archived board would admit it."""
    if audience is None:
        return is_company_email(settings, email_lc)
    if audience['anyone'] or email_lc in audience['emails'] or domain_of(email_lc) in audience['domains']:
        return True
    return bool(audience['company']) and is_company_email(settings, email_lc)
