"""The inbox router: the one Lambda every event on the engineering bus goes to (one fixed rule, never one per run).

For each event it checks the schema and the sender (``senders.judge``), writes the message to the run's
conversation, then fans it out (``routing.route``): a posted task to its role's queue, a message for an agent or the
run conductor to the delivery function. Anything refused is dropped and journalled with its reason (never its
content): a malformed message, a sender that may not send it, a run that does not exist, an event id reused for
other content. A redelivered message (the bus is at-least-once) is fanned out again, since the first attempt may have
stopped before its fan-out; the receivers are idempotent (the event id, the lease epoch).
"""
from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from engineering.bus.routing import DELIVERY, ROLE_QUEUE, route
from engineering.bus.schema import Message, MessageError, parse
from engineering.bus.senders import judge
from engineering.conversation.store import NEW, REDELIVERED, REUSED, UNKNOWN_RUN, ConversationStore
from shared.logging import logger

DROP_REASONS = {REUSED: 'the event id is already in the conversation with other content',
                UNKNOWN_RUN: 'the run does not exist'}


@dataclass(frozen=True)
class Routed:
    status: str
    reason: str = ''
    seq: int | None = None


def _dropped(source: str, reason: str, message: Message | None = None) -> Routed:
    extra = {'source': source, 'reason': reason}
    if message is not None:
        extra |= {'type': message.type, 'run_id': message.run_id, 'event_id': message.event_id}
    logger.warning('engineering bus: dropped a message', extra=extra)
    return Routed('dropped', reason)


class Router:
    def __init__(self, conversation: ConversationStore, *, to_role_queue: Callable[[str, Message], None],
                 deliver: Callable[[Message], None]) -> None:
        self.conversation = conversation
        self.to_role_queue = to_role_queue
        self.deliver = deliver

    def route_event(self, source: str, detail: Any) -> Routed:
        try:
            message = parse(detail)
        except MessageError as exc:
            return _dropped(source, str(exc))
        verdict = judge(message, source)
        if not verdict.allowed:
            return _dropped(source, verdict.reason, message)
        appended = self.conversation.append_to_conversation(message)
        if appended.status not in {NEW, REDELIVERED}:
            return _dropped(source, DROP_REASONS[appended.status], message)
        for destination in route(message):
            if destination.kind == ROLE_QUEUE:
                self.to_role_queue(destination.role, message)
            elif destination.kind == DELIVERY:
                self.deliver(message)
        return Routed('routed' if appended.status == NEW else REDELIVERED, seq=appended.seq)


def _from_environment() -> Router:
    from shared.aws import get_dynamodb_client, get_sqs_client, invoke_lambda_async

    # {role: queue URL}, one queue per role of ``schema.ROLES`` (lib/stacks/engineering-bus.ts): a posted task is
    # always for one of them (``schema.parse``), so a missing role is a deployment error and raises.
    queues: dict[str, str] = json.loads(os.environ['ENGINEERING_ROLE_QUEUE_URLS'])
    delivery = os.environ['ENGINEERING_DELIVERY_FUNCTION']

    def to_role_queue(role: str, message: Message) -> None:
        get_sqs_client().send_message(QueueUrl=queues[role], MessageBody=message.to_json())

    def deliver(message: Message) -> None:
        invoke_lambda_async(delivery, message.to_dict())

    store = ConversationStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'])
    return Router(store, to_role_queue=to_role_queue, deliver=deliver)


_router: Router | None = None


def handler(event: Mapping[str, Any], context: Any) -> dict[str, Any]:
    """EventBridge target: ``{source, detail-type, detail}``."""
    global _router   # the warm container's clients, built once
    if _router is None:
        _router = _from_environment()
    routed = _router.route_event(str(event.get('source', '')), event.get('detail'))
    return {'status': routed.status, 'reason': routed.reason, 'seq': routed.seq}
