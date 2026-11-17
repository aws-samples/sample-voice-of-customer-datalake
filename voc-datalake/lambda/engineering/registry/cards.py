"""Registry cards made from a skill (7.52.00): an agent an administrator names, on a role's accepted skill version.

A card (``voc-registry-card/1``) is a role (``base_role``) on one accepted version of its skill, with a name, a
purpose and caps: what the Registry lists beside the roles' own cards, and what the Flows palette drops into a flow as
an agent step (``node_of``): ``{role: base_role, skill_version: 'v<n>', model, card: '<id>@v<version>'}``. The run
launches the role (IAM stays per role) on the pinned skill version, so a card's model, tools and harness are its skill
version's, read when the card is made and never chosen: a card says what runs. Its caps are recorded with it, at most
the role's template's (``caps`` of the bundled ``voc-agent-card/1``).

Checked when a card is made (``CardError``, a ``kind`` for the route's status):

- the id is ``<role>-<slug>`` (at most 64 characters, never a role's own id), the purpose and the title short text;
- the skill version is the role's, in the scope named (a connection's, or ``''`` for the shared skills), and ACCEPTED
  (a person accepted it: a proposal never makes a card);
- its model is one of ``ALLOWED_MODEL_IDS`` (a ``model`` given must be it: a new skill version changes a model), its
  tools a subset of what the role may have (``role_specs``);
- each cap one of the template's, above 0 and at most the template's.

Rows (voc-engineering, D1/D4 as for skills, ``engineering/skills/store.py``)::

    WS#<ws>#AGENTCARD#<id> / HEAD                    versions (the counter), current_version, base_role
    WS#<ws>#AGENTCARD#<id> / VER#<version:06d>       the card's record at that version (create-only)
    WS#<ws>#AGENTCARD#<id> / LOG#<version:06d>#created   who and when (create-only)
    WS#<ws>#AGENTCARD#_list / CARD#<id>              the card's current record, for the Registry's one listing Query

A card's next version names the version it was made from (``expected_version``): one that moved since is refused, so
two administrators never overwrite each other unseen. Every write is one transaction; nothing is ever deleted.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from engineering.connectors.connections import CONNECTION_ID
from engineering.connectors.identity import WORKSPACE
from engineering.rows import create_only, get_row, partition_rows, string_attr, transact_or_refuse
from engineering.skills.store import ACCEPTED, SkillVersion

SCHEMA: Final = 'voc-registry-card/1'
#: The listing partition's id (never a card's: a card's id starts with a role).
LIST: Final = '_list'
CARD_ID: Final = re.compile(r'[a-z][a-z0-9-]{0,63}\Z')
SLUG: Final = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\Z')
MAX_TITLE: Final = 80
MAX_PURPOSE: Final = 300
MAX_VERSION: Final = 999_999
#: The most cards a listing reads, and the most versions or events a card's page reads.
MAX_CARDS: Final = 200
MAX_PAGE: Final = 50
BODY_KEYS: Final = frozenset({'from_skill', 'slug', 'title', 'purpose', 'model', 'caps', 'expected_version'})
SKILL_KEYS: Final = frozenset({'role', 'connection', 'version'})
SHAPE: Final = ('the body is {from_skill: {role, connection?, version}, slug, purpose, title?, model?, caps?, '
                'expected_version?}')
CHANGED: Final = 'the card changed since you read it: read it again'
EXISTS: Final = ('a card with that id exists: name the version you read (expected_version) to make its next '
                 'version, or pick another slug')


class CardError(ValueError):
    """A card refused; ``kind`` (``invalid``, ``not_found``, ``conflict``) is the route's status."""

    def __init__(self, message: str, kind: str = 'invalid') -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class CardRequest:
    """A card to make: from which skill version, its id, words and caps, and the version it follows (0: a new card)."""

    role: str
    connection: str
    skill_version: int
    card_id: str
    title: str
    purpose: str
    model: str | None
    caps: Mapping[str, Any]
    expected_version: int


def _whole(value: object, label: str, high: int = MAX_VERSION) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= high:
        raise CardError(f'{label} is a whole number from 1 to {high}')
    return value


def _text(value: object, label: str, most: int, *, required: bool) -> str:
    text = value.strip() if isinstance(value, str) else ''
    if value is not None and not isinstance(value, str):
        raise CardError(f'{label} is text')
    if (required and not text) or len(text) > most or not text.isprintable():
        raise CardError(f'{label} is {"1" if required else "0"} to {most} characters of plain text')
    return text


def card_id(role: str, slug: object) -> str:
    """``<role>-<slug>``: lowercase letters, digits and dashes (a role's 15 characters at most and a slug's 40 keep it
    within ``CARD_ID``'s 64)."""
    if not isinstance(slug, str) or not SLUG.fullmatch(slug):
        raise CardError('slug is 1 to 40 lowercase letters, digits and dashes (not at either end)')
    return f'{role}-{slug}'


def check_request(body: Mapping[str, Any], roles: Sequence[str]) -> CardRequest:
    """The route's body as a ``CardRequest`` (``roles``: the roles a card may be of, the launchable ones)."""
    if not set(body) <= BODY_KEYS or not isinstance(body.get('from_skill'), Mapping):
        raise CardError(SHAPE)
    skill = body['from_skill']
    if not set(skill) <= SKILL_KEYS:
        raise CardError(SHAPE)
    role = skill.get('role')
    if role not in roles:
        raise CardError(f'from_skill.role is one of the roles a card is made of: {", ".join(roles)}')
    connection = skill.get('connection', '')
    if not isinstance(connection, str) or (connection and not CONNECTION_ID.fullmatch(connection)):
        raise CardError('from_skill.connection is a connection id, or empty for the shared skills')
    model = body.get('model')
    if model is not None and (not isinstance(model, str) or not model.strip()):
        raise CardError('model is a model id')
    caps = body.get('caps', {})
    if not isinstance(caps, Mapping):
        raise CardError('caps is an object of the template\'s caps, each at most the template\'s')
    expected = body.get('expected_version')
    identity = card_id(str(role), body.get('slug'))
    return CardRequest(
        role=str(role), connection=connection, skill_version=_whole(skill.get('version'), 'from_skill.version'),
        card_id=identity, title=_text(body.get('title'), 'title', MAX_TITLE, required=False) or identity,
        purpose=_text(body.get('purpose'), 'purpose', MAX_PURPOSE, required=True), model=model, caps=dict(caps),
        expected_version=0 if expected is None else _whole(expected, 'expected_version'))


def _caps(given: Mapping[str, Any], template: Mapping[str, Any]) -> dict[str, Any]:
    """The template's caps with the given ones over them, each a cap of the template's, above 0 and at most it."""
    unknown = sorted(set(given) - set(template))
    if unknown:
        raise CardError(f'caps are the template\'s: {", ".join(sorted(template))}; not {", ".join(unknown)}')
    for name, value in given.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= template[name]:
            raise CardError(f'caps.{name} is above 0 and at most the template\'s {template[name]}')
    return {**template, **given}


def compose(request: CardRequest, skill: SkillVersion, template: Mapping[str, Any], *, allowed_models: frozenset[str],
            role_tools: frozenset[str], version: int, by: str, at: str) -> dict[str, Any]:
    """The card's record: ``skill`` (the version the request names, read), the role's bundled ``template`` card, the
    allowed models and the tools the role may have. ``CardError`` for anything the module refuses."""
    if skill.status != ACCEPTED:
        raise CardError(f'{skill.label} is {skill.status}: only an accepted skill version makes a card', 'conflict')
    content = skill.skill.content
    if content.model not in allowed_models:
        raise CardError(f'{skill.label} runs {content.model}, which is not an allowed model: a card runs an allowed '
                        'one', 'conflict')
    if request.model is not None and request.model != content.model:
        raise CardError(f'a card runs its skill version\'s model ({content.model}): a new skill version changes it')
    foreign = sorted(set(content.tool_policy) - role_tools)
    if foreign:
        raise CardError(f'{skill.label} names tools the {request.role} may not have: {", ".join(foreign)}', 'conflict')
    return {
        'schema': SCHEMA, 'id': request.card_id, 'version': version, 'base_role': request.role,
        'title': request.title, 'purpose': request.purpose,
        'skill': {'connection': request.connection, 'version': skill.version, 'label': skill.label,
                  'provenance': skill.provenance, 'template_version': skill.template_version},
        'model': content.model, 'tools': list(content.tool_policy), 'harness': content.harness,
        'caps': _caps(request.caps, template['caps']),
        'inputs': list(template['inputs']), 'outputs': list(template['outputs']), 'trust': dict(template['trust']),
        'template': {'version': template['version'], 'label': template['label'], 'digest': template['digest']},
        'created_by': by, 'created_at': at,
    }


def node_of(record: Mapping[str, Any]) -> dict[str, Any]:
    """The agent step a card makes in a flow (the Flows palette's drop; shared/workflow_engineering.py ``card``)."""
    return {'type': 'agent', 'data': {'title': record['title'], 'params': {
        'role': record['base_role'], 'skill_version': f'v{record["skill"]["version"]}', 'model': record['model'],
        'card': f'{record["id"]}@v{record["version"]}'}}}


def card_view(record: Mapping[str, Any]) -> dict[str, Any]:
    """A card as the Registry answers it: its record, ``kind: card`` and its node."""
    return {'kind': 'card', **record, 'node': node_of(record)}


def _pk(card: str) -> str:
    return f'WS#{WORKSPACE}#AGENTCARD#{card}'


def _found(item: Mapping[str, Any] | None, missing: str) -> Mapping[str, Any]:
    """``item``, read; ``CardError`` not_found (``missing``: what it says) when there was none."""
    if item is None:
        raise CardError(missing, 'not_found')
    return item


def _record(item: Mapping[str, Any]) -> dict[str, Any]:
    try:
        record = json.loads(string_attr(item, 'record'))
    except ValueError as exc:
        raise CardError(f'a stored card is not readable: {exc}', 'conflict') from exc
    if not isinstance(record, dict) or record.get('schema') != SCHEMA:
        raise CardError(f'a stored card is not {SCHEMA}', 'conflict')
    return record


@dataclass(frozen=True)
class AgentCardStore:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str

    def _key(self, card: str, sk: str) -> dict[str, Any]:
        return {'pk': {'S': _pk(card)}, 'sk': {'S': sk}}

    def current_version(self, card: str) -> int:
        head = get_row(self.client, self.table, self._key(card, 'HEAD')) or {}
        return int(head.get('current_version', {}).get('N', '0'))

    def version(self, card: str, version: int) -> dict[str, Any]:
        """The card's record at ``version`` (``CardError`` not_found for none)."""
        return _record(_found(get_row(self.client, self.table, self._key(card, f'VER#{version:06d}')),
                              f'the Registry has no card {card} at v{version}'))

    def _newest(self, card: str, prefix: str) -> list[dict[str, Any]]:
        """The card's rows under ``prefix``, newest first: one Query of at most ``MAX_PAGE``."""
        return self.client.query(
            TableName=self.table, ConsistentRead=True, ScanIndexForward=False, Limit=MAX_PAGE,
            KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
            ExpressionAttributeValues={':pk': {'S': _pk(card)}, ':p': {'S': prefix}}).get('Items', [])

    def versions(self, card: str) -> list[dict[str, Any]]:
        """The card's records, newest first (at most ``MAX_PAGE``)."""
        return [_record(row) for row in self._newest(card, 'VER#')]

    def events(self, card: str) -> list[dict[str, Any]]:
        """Who made each version and when, newest first (at most ``MAX_PAGE``)."""
        return [{'version': int(row.get('version', {}).get('N', '0')), 'event': string_attr(row, 'event'),
                 'by': string_attr(row, 'username'), 'at': string_attr(row, 'at')}
                for row in self._newest(card, 'LOG#')]

    def listing(self) -> list[dict[str, Any]]:
        """Every card's current record, by id (at most ``MAX_CARDS``)."""
        return [_record(row) for row in partition_rows(self.client, self.table, _pk(LIST), 'CARD#',
                                                       max_items=MAX_CARDS)]

    def save(self, record: Mapping[str, Any], *, expected_version: int, by: str, username: str) -> None:
        """Write ``record`` (its version ``expected_version + 1``) with its log row and the listing's, in one
        transaction; ``CardError`` conflict when the card exists and its version is not ``expected_version``."""
        card, version, at = str(record['id']), int(record['version']), str(record['created_at'])
        text = json.dumps(record, sort_keys=True, ensure_ascii=False)
        head_values = {':next': {'N': str(version)}, ':at': {'S': at}, ':by': {'S': by}}
        if expected_version:
            head: dict[str, Any] = {'Update': {
                'TableName': self.table, 'Key': self._key(card, 'HEAD'),
                'UpdateExpression': 'SET versions = :next, current_version = :next, updated_at = :at, updated_by = :by',
                'ConditionExpression': 'versions = :expected',
                'ExpressionAttributeValues': {**head_values, ':expected': {'N': str(expected_version)}}}}
        else:
            head = create_only({**self._key(card, 'HEAD'), 'versions': head_values[':next'],
                                'current_version': head_values[':next'], 'base_role': {'S': record['base_role']},
                                'updated_at': head_values[':at'], 'updated_by': head_values[':by']}, self.table)
        items = [
            head,
            create_only({**self._key(card, f'VER#{version:06d}'), 'version': {'N': str(version)},
                         'record': {'S': text}, 'created_at': {'S': at}, 'created_by': {'S': by}}, self.table),
            create_only({**self._key(card, f'LOG#{version:06d}#created'), 'version': {'N': str(version)},
                         'event': {'S': 'created'}, 'by': {'S': by}, 'username': {'S': username}, 'at': {'S': at}},
                        self.table),
            {'Put': {'TableName': self.table, 'Item': {**self._key(LIST, f'CARD#{card}'), 'id': {'S': card},
                                                       'current_version': {'N': str(version)}, 'record': {'S': text},
                                                       'updated_at': {'S': at}}}},
        ]
        transact_or_refuse(self.client, items, CardError(CHANGED if expected_version else EXISTS, 'conflict'))
