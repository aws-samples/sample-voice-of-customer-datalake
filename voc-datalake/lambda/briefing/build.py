"""One user's brief, end to end (docs/briefing.md → "How a brief is built").

1. Re-check the reader in Cognito; resolve their category + source scope.
2. Org layer of their scope group (``BRIEFORG#{scope_hash}`` / UTC day): reused when
   fresh, else rebuilt — card providers (code) + ONE model call for the words, with
   SHARED grounding. The code-only alert cards are not sent to that call.
3. Personal layer: the "Things to do" cards (code), then ONE model call that re-words
   and orders everything for the reader in their language (PRIVATE grounding: their
   objectives, personal memories, project names and instructions).
4. Every card naming a category outside the scope is dropped (defence in depth).
5. Store ``BRIEF#{sub}`` / local day (card states kept); a scheduled build is mailed
   when the reader turned email on.
"""
from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Final

from boto3.dynamodb.conditions import Key

from briefing import mailer
from briefing.identity import lookup_reader
from briefing.providers import PROVIDERS, run_providers, within_scope
from briefing.signals import read_signals
from briefing.todos import TODO_PROVIDERS, PersonalTables, Reader
from briefing.writer import PersonalInput, Words, write_org, write_personal
from shared import briefing_prefs as prefs
from shared import briefing_store as store
from shared.brief_cards import SEVERITIES, BriefCard, BriefContext, CardAction, Severity
from shared.briefing_requests import REASON_SCHEDULED
from shared.category_access import CategoryScope
from shared.category_gate import scope_for_caller
from shared.grounding import POLICY_PRIVATE, POLICY_SHARED, build_grounding
from shared.indexes import PROJECTS_BY_TYPE_INDEX
from shared.logging import logger
from shared.memory_policy import parse_datetime
from shared.project_access import Caller

#: An org layer with new reviews since it was built is rebuilt after this long.
ORG_MAX_AGE: Final = timedelta(hours=3)
MAX_PROJECT_ROWS: Final = 200
ALERT_PREFIX: Final = 'alert_'
_SEVERITY_BY_NAME: Final[dict[str, Severity]] = {name: name for name in SEVERITIES}


@dataclass(frozen=True)
class Tables:
    feedback: Any
    aggregates: Any
    memory: Any = None
    agents: Any = None
    projects: Any = None
    radar: Any = None


@dataclass(frozen=True)
class OrgLayer:
    cards: list[BriefCard]
    summary: str
    model_calls: int


def to_dynamo(value: Any) -> Any:
    """JSON-safe values with floats as Decimal (DynamoDB refuses float)."""
    return json.loads(json.dumps(value, default=str), parse_float=Decimal)


def _text(value: object) -> str:
    return value if isinstance(value, str) else ''


def _strings(value: object) -> tuple[str, ...]:
    return tuple(v for v in value if isinstance(v, str)) if isinstance(value, list) else ()


def card_from_item(item: Mapping[str, Any]) -> BriefCard | None:
    """A stored card back as a ``BriefCard`` (lenient; None when it has no id or kind)."""
    card_id, kind = item.get('id'), item.get('kind')
    if not isinstance(card_id, str) or not isinstance(kind, str):
        return None
    severity = _SEVERITY_BY_NAME.get(str(item.get('severity')), 'info')
    actions = tuple(CardAction(label=_text(a.get('label')), prompt=_text(a.get('prompt')))
                    for a in item.get('actions') or [] if isinstance(a, Mapping))
    facts = item.get('facts')
    return BriefCard(
        id=card_id, kind=kind, layer='personal' if item.get('layer') == 'personal' else 'org',
        severity=severity, title=_text(item.get('title')), body=_text(item.get('body')),
        facts=store.plain(facts) if isinstance(facts, Mapping) else {}, actions=actions,
        feedback_ids=_strings(item.get('feedback_ids')), urls=_strings(item.get('urls')),
    )


def _cards_of(items: object) -> list[BriefCard]:
    cards = (card_from_item(i) for i in items if isinstance(i, Mapping)) if isinstance(items, list) else ()
    return [c for c in cards if c is not None]


def _org_is_fresh(row: Mapping[str, Any] | None, marker: str, now: datetime) -> bool:
    if not isinstance(row, Mapping):
        return False
    generated = parse_datetime(row.get('generated_at'))
    return generated is not None and (row.get('feedback_marker') == marker or now - generated < ORG_MAX_AGE)


def org_layer(tables: Tables, scope: CategoryScope, now: datetime, marker: str) -> OrgLayer:
    """The scope group's org cards: the stored layer when fresh, else built now (one model call)."""
    key = store.org_key(store.scope_hash(scope), now.astimezone(UTC).strftime('%Y-%m-%d'))
    row = tables.aggregates.get_item(Key=key).get('Item')
    if _org_is_fresh(row, marker, now) and isinstance(row, Mapping):
        return OrgLayer(_cards_of(row.get('cards')), _text(row.get('summary')), 0)
    ctx = BriefContext(feedback_table=tables.feedback, aggregates_table=tables.aggregates, scope=scope, now=now,
                       extra={'signals': read_signals(tables.feedback, tables.aggregates, scope, now),
                              'radar_table': tables.radar})
    cards = within_scope(run_providers(PROVIDERS, ctx), scope)
    alerts = [c for c in cards if c.kind.startswith(ALERT_PREFIX)]
    grounding = build_grounding(query='customer feedback trends, risks and opportunities this week',
                                policy=POLICY_SHARED, aggregates_table=tables.aggregates,
                                memory_table=tables.memory, scope=scope)
    words = write_org([c for c in cards if not c.kind.startswith(ALERT_PREFIX)], grounding.text, key['sk'])
    org = OrgLayer(alerts + words.cards + within_scope(words.extra, scope), words.summary, words.model_calls)
    tables.aggregates.put_item(Item=to_dynamo({
        **key, 'cards': [c.to_item() for c in org.cards], 'summary': org.summary,
        'generated_at': now.isoformat(), 'feedback_marker': marker, 'model_calls': org.model_calls,
        'memory_ids': grounding.memory_ids, 'company_context_included': grounding.company_context_included,
    }))
    return org


def my_project_names(projects_table: Any, sub: str) -> list[str]:
    """Names of the projects the reader owns or is a member of (newest first, bounded)."""
    if projects_table is None:
        return []
    page = projects_table.query(
        IndexName=PROJECTS_BY_TYPE_INDEX, KeyConditionExpression=Key('gsi1pk').eq('TYPE#PROJECT'),
        ScanIndexForward=False, Limit=MAX_PROJECT_ROWS,
        ProjectionExpression='#name, owner_sub, members', ExpressionAttributeNames={'#name': 'name'},
    )
    names = []
    for row in page.get('Items', []):
        members = row.get('members') if isinstance(row.get('members'), Mapping) else {}
        if (row.get('owner_sub') == sub or sub in members) and isinstance(row.get('name'), str):
            names.append(row['name'])
    return names


def _personal_cards(tables: Tables, reader: Reader, scope: CategoryScope, now: datetime) -> list[BriefCard]:
    ctx = BriefContext(feedback_table=tables.feedback, aggregates_table=tables.aggregates, scope=scope, now=now,
                       extra={'reader': reader,
                              'tables': PersonalTables(tables.agents, tables.memory, tables.projects)})
    return run_providers(TODO_PROVIDERS, ctx)


def _write_for_reader(tables: Tables, reader: Reader, scope: CategoryScope, cards: list[BriefCard],
                      settings: Mapping[str, Any], day: str) -> Words:
    instructions = str(settings['instructions'])
    grounding = build_grounding(query=instructions or 'what matters in customer feedback today',
                                policy=POLICY_PRIVATE, aggregates_table=tables.aggregates,
                                memory_table=tables.memory, caller_sub=reader.sub, scope=scope)
    return write_personal(PersonalInput(
        cards=cards, grounding_text=grounding.text, instructions=instructions, language=str(settings['language']),
        projects=my_project_names(tables.projects, reader.sub), day=day,
    ))


def _store_brief(tables: Tables, reader: Reader, day: str, fields: Mapping[str, Any]) -> None:
    names = {f'#{k}': k for k in fields}
    sets = ', '.join(f'#{k} = :{k}' for k in fields)
    tables.aggregates.update_item(
        Key=store.brief_key(reader.sub, day),
        UpdateExpression=f'SET {sets}, card_state = if_not_exists(card_state, :empty) REMOVE failed_at',
        ExpressionAttributeNames=names,
        ExpressionAttributeValues={**{f':{k}': v for k, v in to_dynamo(dict(fields)).items()}, ':empty': {}},
    )


def _deliver(reader: Reader, row: Mapping[str, Any], cards: Iterable[BriefCard], words: Words,
             settings: Mapping[str, Any], day: str, site_url: str) -> bool:
    """Mail a scheduled brief when the reader turned email on (SNS delivers only once confirmed)."""
    if not (settings['enabled'] and settings['email'] and row.get('subscription_arn')):
        return False
    subject, message = mailer.compose(cards=list(cards), headline=words.headline, summary=words.summary,
                                      language=str(settings['language']), day=day, site_url=site_url)
    mailer.publish(reader.sub, subject, message)
    return True


@dataclass(frozen=True)
class BuildRequest:
    sub: str
    username: str
    reason: str
    site_url: str = ''


def build_for_user(tables: Tables, request: BuildRequest, now: datetime) -> dict[str, Any]:
    """Build (and maybe mail) one reader's brief; ``{outcome, model_calls, cards}``."""
    row = tables.aggregates.get_item(Key=prefs.preferences_key(request.sub)).get('Item') or {}
    settings = prefs.stored_preferences(row)
    day = prefs.local_day(settings['time_zone'], now)
    reader = lookup_reader(request.username, request.sub, tables.aggregates)
    if reader is None:
        store.mark_failed(tables.aggregates, request.sub, day, now)
        return {'outcome': 'reader_gone', 'model_calls': 0, 'cards': 0}
    scope = scope_for_caller(Caller(subject=reader.sub, is_admin=reader.is_admin, username=reader.username),
                             tables.aggregates)
    marker = store.feedback_marker(tables.aggregates, now)
    org = org_layer(tables, scope, now, marker)
    words = _write_for_reader(tables, reader, scope, org.cards + _personal_cards(tables, reader, scope, now),
                              settings, day)
    cards = within_scope(words.cards + words.extra, scope)
    model_calls = org.model_calls + words.model_calls
    _store_brief(tables, reader, day, {
        'status': store.STATUS_READY, 'cards': [c.to_item() for c in cards],
        'headline': words.headline, 'summary': words.summary or org.summary, 'generated_at': now.isoformat(),
        'feedback_marker': marker, 'settings_marker': store.settings_marker(settings),
        'scope_hash': store.scope_hash(scope), 'language': settings['language'],
        'model_calls': model_calls, 'reason': request.reason,
    })
    mailed = request.reason == REASON_SCHEDULED and _deliver(
        reader, row, cards, words, settings, day, request.site_url)
    logger.info('Brief built', extra={'cards': len(cards), 'model_calls': model_calls,
                                      'reason': request.reason, 'mailed': mailed})
    return {'outcome': 'built', 'model_calls': model_calls, 'cards': len(cards)}
