"""The inbox router: the one Lambda every event on the engineering bus goes to (one fixed rule, never one per run).

For each event it checks the schema and the sender (``senders.judge``), writes the message to the run's
conversation, then fans it out (``routing.route``): a posted task, and a message for an agent or the run conductor, to
the delivery function, with the message's conversation seq (``{"message": …, "seq": N}``: the delivery function keeps
it on its ``INBOX#`` row and refuses a payload without one). Anything refused is dropped and journalled with its reason (never its
content): a malformed message, a sender that may not send it, a run that does not exist, an event id reused for
other content. A redelivered message (the bus is at-least-once) is fanned out again under the seq it was first written with, since
the first attempt may have stopped before its fan-out; the delivery function's once-per-event marker makes it write
nothing (only the wake repeats).
"""
from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from engineering.bus.routing import DELIVERY, route
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
    def __init__(self, conversation: ConversationStore, *, deliver: Callable[[Message, int], None]) -> None:
        """``deliver(message, seq)`` hands a message to the delivery function under its conversation seq."""
        self.conversation = conversation
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
        seq = appended.seq
        if seq is None:   # (NEW and REDELIVERED always carry one)
            raise RuntimeError('the conversation answered without a seq')
        if any(destination.kind == DELIVERY for destination in route(message)):
            self.deliver(message, seq)
        return Routed('routed' if appended.status == NEW else REDELIVERED, seq=appended.seq)


def _from_environment() -> Router:
    from shared.aws import get_dynamodb_client, invoke_lambda_async

    delivery = os.environ['ENGINEERING_DELIVERY_FUNCTION']

    def deliver(message: Message, seq: int) -> None:
        invoke_lambda_async(delivery, {'message': message.to_dict(), 'seq': seq})

    store = ConversationStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'])
    return Router(store, deliver=deliver)


_router: Router | None = None


def handler(event: Mapping[str, Any], context: Any) -> dict[str, Any]:
    """EventBridge target: ``{source, detail-type, detail}``."""
    global _router   # the warm container's clients, built once
    if _router is None:
        _router = _from_environment()
    routed = _router.route_event(str(event.get('source', '')), event.get('detail'))
    return {'status': routed.status, 'reason': routed.reason, 'seq': routed.seq}
