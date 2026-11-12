"""The conversation's storage in the ``voc-engineering`` table: one row per message, never changed (D1).

The inbox router is its only writer (agents never write it); each row keeps the whole message, its ``from`` the
actor and its ``at`` the time (D4).

``WS#<ws>#RUN#<run>`` / ``MSG#<seq:08d>``, the sequence from an atomic counter on the run's ``META`` row, which must
exist (the run's start writes it, with the run's caps): a message for an unknown run is refused, never a phantom run. The bus is
at-least-once, so a message's ``EVT#<event_id>`` marker (with the message's digest) and its row are written in one
transaction, each only if absent. A redelivered message changes nothing; an event id reused for other content is
reported, so it is never delivered without its record.

Readers: the sequence has gaps (a redelivery or a failed write uses a number) and two writers may commit their
numbers out of order, so a reader that follows the tail re-reads a short window behind the last number it saw.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from botocore.exceptions import ClientError

from engineering.bus.schema import Message
from engineering.rows import run_pk
from shared.aws import is_conditional_check_failure
from shared.dynamo_paging import query_all
from shared.ids import is_key_collision

SEQ_DIGITS = 8
NEW, REDELIVERED, REUSED, UNKNOWN_RUN = 'new', 'redelivered', 'reused', 'unknown_run'


@dataclass(frozen=True)
class Appended:
    status: str
    seq: int | None = None


class ConversationStore:
    def __init__(self, client: Any, table: str) -> None:
        """``client`` is a low-level DynamoDB client (boto3's, or a test's)."""
        self.client = client
        self.table = table

    def page(self, ws: str, run_id: str, *, after: int, limit: int) -> list[dict[str, Any]]:
        """The conversation from ``after`` on, in order: ``{seq, message}`` (the message as voc-msg/1 data).

        Up to ``limit`` messages, following ``LastEvaluatedKey``: DynamoDB cuts a query's page at 1 MB, and a page cut
        short must not read as the tail (fewer than ``limit`` messages means the conversation has no more now).
        """
        items = query_all(self.client, {
            'TableName': self.table, 'ConsistentRead': True, 'Limit': limit,
            'KeyConditionExpression': 'pk = :pk AND sk BETWEEN :from AND :to',
            'ExpressionAttributeValues': {':pk': {'S': run_pk(ws, run_id)},
                                          ':from': {'S': f'MSG#{after + 1:0{SEQ_DIGITS}d}'},
                                          ':to': {'S': f'MSG#{10 ** SEQ_DIGITS - 1}'}}}, max_items=limit)
        return [{'seq': int(item['sk']['S'].removeprefix('MSG#')), 'event_id': item['event_id']['S'],
                 'type': item['type']['S'], 'at': item['at']['S'], 'message': json.loads(item['message']['S'])}
                for item in items]

    def append_to_conversation(self, message: Message) -> Appended:
        pk = run_pk(message.ws, message.run_id)
        try:
            counter = self.client.update_item(
                TableName=self.table, Key={'pk': {'S': pk}, 'sk': {'S': 'META'}},
                UpdateExpression='ADD msg_seq :one', ConditionExpression='attribute_exists(pk)',
                ExpressionAttributeValues={':one': {'N': '1'}}, ReturnValues='UPDATED_NEW')
        except ClientError as exc:
            if is_conditional_check_failure(exc):
                return Appended(UNKNOWN_RUN)
            raise
        seq = int(counter['Attributes']['msg_seq']['N'])
        body = message.to_json()
        digest = hashlib.sha256(body.encode('utf-8')).hexdigest()
        marker = {'pk': {'S': pk}, 'sk': {'S': f'EVT#{message.event_id}'}}
        absent = 'attribute_not_exists(pk)'
        try:
            self.client.transact_write_items(TransactItems=[
                {'Put': {'TableName': self.table, 'ConditionExpression': absent,
                         'Item': {**marker, 'seq': {'N': str(seq)}, 'digest': {'S': digest}}}},
                {'Put': {'TableName': self.table, 'ConditionExpression': absent, 'Item': {
                    'pk': {'S': pk}, 'sk': {'S': f'MSG#{seq:0{SEQ_DIGITS}d}'}, 'event_id': {'S': message.event_id},
                    'type': {'S': message.type}, 'at': {'S': message.at}, 'message': {'S': body}}}},
            ])
        except ClientError as exc:
            if not is_key_collision(exc, put_index=0):   # the event's marker, the first item, is already there
                raise
            stored = self.client.get_item(TableName=self.table, Key=marker, ConsistentRead=True).get('Item', {})
            same = stored.get('digest', {}).get('S') == digest
            return Appended(REDELIVERED if same else REUSED)
        return Appended(NEW, seq)
