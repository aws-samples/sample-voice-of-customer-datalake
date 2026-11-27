"""A person's erasure from the agents' memory (TENETS.md D5), on its own so that voc-retention can run it.

The store's ``erase_person_memories`` (store.py, an administrator's call) and voc-retention's erasure by email
(jobs/retention/agent_memory.py, since 7.84.00) both erase through ``erase_person_rows``, which imports nothing but
engineering/rows.py and shared/: the retention worker's bundle holds these three files of the engineering tree and
no other (lib/stacks/retention-worker.ts).

The rows (store.py's module docstring has the whole layout)::

    WS#<ws>#AMEM#PERSON#<user>   / ...                       the person's own partition: deleted whole
                                 / REF#<partition>           a partition whose rows name them: de-identified
    AUDIT#tombstone#agent_memory_person / <sha256 of the user id>   written first, once (a re-run keeps the first)
    AUDIT#delete                 / <iso>#<random>            the erasure's delete record, one per run

In order: the tombstone (who, the legal basis, when; the person only as a hash; kept when there is one already); then,
when any row of theirs is found (none is recorded where nothing is deleted, 7.84.00), the delete record, every row naming the person in another partition names one random ``erased-…`` id of this run
instead (a confirmation row is re-keyed: its key hashes its source), then every row of the person's own partition is
deleted. A run cut short is finished by the next: it reads what is left of the partition and the partitions its
``REF#`` rows still name (each one already de-identified before any row is deleted). Nothing else is ever deleted.
"""
from __future__ import annotations

import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.rows import text_value as _text
from engineering.rows import whole_partition
from shared.delete_audit import AUDIT_PK
from shared.digests import sha256_hex
from shared.ids import is_key_collision
from shared.legal_basis import required_legal_basis

TOMBSTONE_PK: Final = 'AUDIT#tombstone#agent_memory_person'
ERASED_KIND: Final = 'agent_memory_person'
#: The attributes of a version, log or memory row that name a person.
PERSON_ATTRS: Final = ('author', 'prov_person', 'approved_by', 'by')
#: A confirmation row's attributes (store.py ``_confirmation_item``): the only ones a re-keyed confirmation is put with
#: (the retention worker's PutItem on the memory partitions is held to them, lib/stacks/retention-worker.ts).
CONFIRMATION_ATTRIBUTES: Final = ('pk', 'sk', 'source', 'comment_url', 'at')


@dataclass(frozen=True)
class Erasure:
    """What an erasure did: the person's rows deleted, the rows elsewhere de-identified, and in how many
    partitions."""

    deleted: int
    deidentified: int
    partitions: int


def person_partition(ws: str, person: str) -> str:
    """A person's own partition (model.py ``Scope('person', person=…).partition``, held equal by a test)."""
    return f'WS#{ws}#AMEM#PERSON#{person}'


def erase_person_rows(client: Any, table: str, ws: str, person: str, *, actor: Mapping[str, str], legal_basis: str,
                      now: datetime) -> Erasure:
    """Erase ``person`` from the agents' memory of scope ``ws`` (the module docstring), for a legal obligation:
    ``actor`` (string fields: who erases, as the tombstone and the delete record name them), ``legal_basis`` (checked:
    ValueError for an empty one or one that holds personal data). ``client``: a low-level DynamoDB client on
    ``table``. Re-running it after a failure finishes it."""
    basis = required_legal_basis(legal_basis)
    rows = whole_partition(client, table, person_partition(ws, person))
    partitions = sorted({_text(row.get('partition')) for row in rows if _text(row.get('sk')).startswith('REF#')})
    at, hashed = now.isoformat(), sha256_hex(person)
    recorded = {'M': {name: {'S': str(value)} for name, value in actor.items()}}
    try:
        client.put_item(TableName=table, ConditionExpression='attribute_not_exists(pk)', Item={
            'pk': {'S': TOMBSTONE_PK}, 'sk': {'S': hashed}, 'legal_basis': {'S': basis}, 'actor': recorded,
            'deleted_at': {'S': at}})
    except ClientError as exc:
        if not is_key_collision(exc):
            raise   # an erasure re-run keeps the first tombstone
    if not rows:
        # Nothing of theirs is kept (never was, or a finished erasure removed it): the tombstone stands as the lasting
        # refusal (the memory never learns them again), and no delete is recorded where nothing is deleted (7.84.00).
        return Erasure(0, 0, 0)
    client.put_item(TableName=table, ConditionExpression='attribute_not_exists(pk)', Item={
        'pk': {'S': AUDIT_PK}, 'sk': {'S': f'{at}#{secrets.token_hex(16)}'}, 'kind': {'S': ERASED_KIND},
        'target': {'M': {'ws': {'S': ws}, 'person_hash': {'S': hashed}, 'rows': {'S': str(len(rows))},
                         'partitions': {'S': str(len(partitions))}}},
        'actor': recorded, 'reason': {'S': basis}, 'deleted_at': {'S': at}})
    alias = f'erased-{secrets.token_hex(8)}'
    deidentified = sum(_deidentify(client, table, partition, person, alias) for partition in partitions)
    for row in rows:
        client.delete_item(TableName=table, Key={'pk': row['pk'], 'sk': row['sk']})
    return Erasure(len(rows), deidentified, len(partitions))


def _deidentify(client: Any, table: str, partition: str, person: str, alias: str) -> int:
    """Every row of ``partition`` naming ``person`` names ``alias`` instead; their confirmation rows are re-keyed (the
    key is a hash of the source). Returns how many rows changed."""
    changed = 0
    for item in whole_partition(client, table, partition):
        if _text(item.get('source')) == f'person:{person}':
            source = f'person:{alias}'
            memory_id = _text(item.get('sk')).split('#')[1]
            kept = {name: item[name] for name in CONFIRMATION_ATTRIBUTES if name in item}
            client.put_item(TableName=table, Item={
                **kept, 'sk': {'S': f'CONF#{memory_id}#{sha256_hex(source)[:24]}'}, 'source': {'S': source}})
            client.delete_item(TableName=table, Key={'pk': item['pk'], 'sk': item['sk']})
            changed += 1
            continue
        named = [attr for attr in PERSON_ATTRS if _text(item.get(attr)) == person]
        if named:
            client.update_item(
                TableName=table, Key={'pk': item['pk'], 'sk': item['sk']},
                UpdateExpression='SET ' + ', '.join(f'#a{i} = :alias' for i in range(len(named))),
                ExpressionAttributeNames={f'#a{i}': attr for i, attr in enumerate(named)},
                ExpressionAttributeValues={':alias': {'S': alias}})
            changed += 1
    return changed
