"""Who a feedback board is for (docs/feature-requests.md -> Audiences), and the sign-up row it feeds.

A board's ``audience`` is ``{mode, domains, emails}``: ``company`` (the engagement settings'
company domains), ``list`` (an allowed domain OR an exact address) or ``anyone`` (any address
that verifies itself through the emailed sign-in code). ``domains`` / ``emails`` are kept for
every mode (switching back to ``list`` keeps them) but only a ``list`` board reads them.

The board pool's PreSignUp trigger cannot read the boards (its bundle and its one-item grant on
the participants table stay as they are), so every board save, archive and delete rewrites ONE
derived row in the PARTICIPANTS table, ``SETTINGS`` / ``board_audience`` (layout and reader:
``shared.participants_settings``): the union over the non-archived boards.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from shared.engagement_common import normalize_email
from shared.exceptions import ValidationError
from shared.participants_settings import BOARD_AUDIENCE_KEY, validated_domains
from shared.timestamps import now_iso

MODES: Final = ('company', 'list', 'anyone')
MAX_AUDIENCE_DOMAINS: Final = 50
MAX_AUDIENCE_EMAILS: Final = 500
# The derived row's bounds (an item is at most 400 KB): a save that would pass them is refused.
MAX_UNION_DOMAINS: Final = 1000
MAX_UNION_EMAILS: Final = 5000
DEFAULT_AUDIENCE: Final = {'mode': 'company', 'domains': [], 'emails': []}


def _domains(raw: object) -> list[str]:
    if raw is None:
        return []
    try:
        return validated_domains(raw, 'audience.domains', MAX_AUDIENCE_DOMAINS)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def audience_emails(raw: object, limit: int = MAX_AUDIENCE_EMAILS) -> list[str]:
    """``audience.emails`` lower-cased and de-duplicated (None = none), or a 400. Also a review link's."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > limit:
        raise ValidationError(f'audience.emails must be a list of at most {limit} addresses')
    emails: list[str] = []
    for entry in raw:
        try:
            email_lc = normalize_email(entry)[1]
        except ValueError as exc:
            raise ValidationError('audience.emails entries must be email addresses') from exc
        if email_lc not in emails:
            emails.append(email_lc)
    return emails


def validate_audience(raw: object) -> dict[str, Any]:
    if not isinstance(raw, Mapping) or set(raw) - {'mode', 'domains', 'emails'}:
        raise ValidationError('audience must be {mode, domains?, emails?}')
    mode = raw.get('mode')
    if mode not in MODES:
        raise ValidationError(f'audience.mode must be one of: {", ".join(MODES)}')
    return {'mode': mode, 'domains': _domains(raw.get('domains')), 'emails': audience_emails(raw.get('emails'))}


def audience_of(board: Mapping[str, Any]) -> dict[str, Any]:
    """The stored audience read leniently (unreadable = company, the narrowest shared default)."""
    try:
        return validate_audience(board.get('audience'))
    except ValidationError:
        return dict(DEFAULT_AUDIENCE)


def audience_admits(audience: Mapping[str, Any], email_lc: str, company_domains: Iterable[str]) -> bool:
    """Does this audience admit a verified ``email_lc``?"""
    domain = email_lc.rsplit('@', 1)[-1]
    if audience['mode'] == 'anyone':
        return True
    if audience['mode'] == 'list':
        return domain in audience['domains'] or email_lc in audience['emails']
    return domain in set(company_domains)


def derived_row(boards: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The sign-up row over the non-archived ``boards``; ValidationError past the row's bounds."""
    company = anyone = False
    domains: dict[str, None] = {}  # insertion-ordered sets
    emails: dict[str, None] = {}
    for board in boards:
        if board.get('archived') is True:
            continue
        audience = audience_of(board)
        company = company or audience['mode'] == 'company'
        anyone = anyone or audience['mode'] == 'anyone'
        if audience['mode'] == 'list':
            domains.update(dict.fromkeys(audience['domains']))
            emails.update(dict.fromkeys(audience['emails']))
    if len(domains) > MAX_UNION_DOMAINS or len(emails) > MAX_UNION_EMAILS:
        raise ValidationError(f'All boards together may list at most {MAX_UNION_DOMAINS} domains and '
                              f'{MAX_UNION_EMAILS} addresses')
    return {'company': company, 'anyone': anyone, 'domains': list(domains), 'emails': list(emails)}


def write_derived_row(participants: Any, row: Mapping[str, Any]) -> None:
    participants.put_item(Item={**BOARD_AUDIENCE_KEY, **row, 'updated_at': now_iso()})
