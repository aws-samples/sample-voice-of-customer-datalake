"""A ``needs_human`` agent run and the decision a human takes on it (pure, no AWS).

When the conductor (``agents/conductor/handler.py``) ends a run as ``needs_human`` it
writes, in the SAME update as the status, a ``needs_human`` payload::

    {reason, node_id, node_title, loop_index?, max_rounds?,
     verdicts?: [{name, score, blocking, objections: [≤5 strings of ≤400 chars]}]}

``reason`` is one of :data:`NEEDS_HUMAN_REASONS`. An admin then decides
(``POST /agents/{agent_id}/runs/{run_id}/decision``, ``shared.agent_run_resume``):

- ``accept``         continue past the gate as if it had passed;
- ``another_round``  run the loop exactly once more (only for a gate inside a loop);
- ``stop``           close the run as ``completed`` with no further work.

The decision is stored on the run as ``{decision, note, by_username, by_sub, at}``;
the run view shows all of it except ``by_sub``.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, TypeGuard

from shared.exceptions import ValidationError

DECISION_ACCEPT: Final = 'accept'
DECISION_ANOTHER_ROUND: Final = 'another_round'
DECISION_STOP: Final = 'stop'
DECISIONS: Final = (DECISION_ACCEPT, DECISION_ANOTHER_ROUND, DECISION_STOP)

REASON_LOOP_EXHAUSTED: Final = 'loop_exhausted'
REASON_NO_FAIL_PATH: Final = 'no_fail_path'
REASON_END_NODE: Final = 'end_node'
REASON_BUDGET: Final = 'budget'
REASON_VERIFICATION: Final = 'verification'
NEEDS_HUMAN_REASONS: Final = (REASON_LOOP_EXHAUSTED, REASON_NO_FAIL_PATH, REASON_END_NODE, REASON_BUDGET,
                              REASON_VERIFICATION)
# The two reasons a gate review raised: a human may let the run continue.
GATE_REASONS: Final = frozenset({REASON_LOOP_EXHAUSTED, REASON_NO_FAIL_PATH})

# Executed nodes per run, loops included; a resumed run gets this many more.
MAX_STEPS_PER_RUN: Final = 120
# The model-call budget per run when the agent sets none (agents/store.max_calls_for).
DEFAULT_MAX_MODEL_CALLS_PER_RUN: Final = 150
MAX_MODEL_CALLS_CEILING: Final = 1000

# The note carries the objections a human ticked plus their own instructions.
MAX_NOTE_CHARS: Final = 6000
MAX_VERDICTS: Final = 12
# As many, and as long, as the persona panel keeps (agents/persona_panel/handler.py).
MAX_OBJECTIONS: Final = 5
MAX_OBJECTION_CHARS: Final = 400
MAX_VERDICT_NAME_CHARS: Final = 120
MAX_TITLE_CHARS: Final = 200

_RUN_NEEDS_HUMAN: Final = 'needs_human'


def max_calls_per_run(agent: Mapping[str, Any]) -> int:
    """The agent's model-call budget per run (``budget.max_model_calls_per_run``, else the default)."""
    budget = agent.get('budget')
    value = budget.get('max_model_calls_per_run') if isinstance(budget, Mapping) else None
    if not _is_whole(value) or not 0 < value <= MAX_MODEL_CALLS_CEILING:
        return DEFAULT_MAX_MODEL_CALLS_PER_RUN
    return value


def _objections(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [text.strip()[:MAX_OBJECTION_CHARS] for text in raw if isinstance(text, str) and text.strip()][
        :MAX_OBJECTIONS]


def _is_whole(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _verdict(raw: object) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    score = raw.get('score')
    return {
        'name': str(raw.get('name') or 'Persona')[:MAX_VERDICT_NAME_CHARS],
        'score': score if isinstance(score, (int, float)) and not isinstance(score, bool) else None,
        'blocking': raw.get('blocking') is True,
        'objections': _objections(raw.get('objections')),
    }


def compact_verdicts(raw: object) -> list[dict[str, Any]]:
    """The persona verdicts a human needs, bounded (``context.last_verdicts`` in, at most 12 out)."""
    if not isinstance(raw, list):
        return []
    return [verdict for item in raw[:MAX_VERDICTS] if (verdict := _verdict(item)) is not None]


def needs_human_payload(reason: str, node_id: str, node_title: str, *, loop_index: int | None = None,
                        max_rounds: int | None = None, verdicts: object = None) -> dict[str, Any]:
    """The ``needs_human`` attribute the conductor writes with the status."""
    if reason not in NEEDS_HUMAN_REASONS:
        raise ValueError(f'unknown needs_human reason: {reason}')
    payload: dict[str, Any] = {'reason': reason, 'node_id': node_id, 'node_title': node_title[:MAX_TITLE_CHARS]}
    if loop_index is not None and max_rounds is not None:
        payload['loop_index'] = loop_index
        payload['max_rounds'] = max_rounds
    if reason in GATE_REASONS:
        payload['verdicts'] = compact_verdicts(verdicts)
    return payload


def needs_human_view(run: Mapping[str, Any]) -> dict[str, Any] | None:
    """The run's ``needs_human`` payload while it waits for a human, else None."""
    payload = run.get('needs_human')
    if run.get('status') != _RUN_NEEDS_HUMAN or not isinstance(payload, Mapping):
        return None
    return dict(payload)


def decision_view(run: Mapping[str, Any]) -> dict[str, Any] | None:
    """``{decision, note, by_username, at}`` of the last decision, else None."""
    decision = run.get('decision')
    if not isinstance(decision, Mapping):
        return None
    return {key: decision.get(key) for key in ('decision', 'note', 'by_username', 'at')}


def allowed_actions(run: Mapping[str, Any]) -> list[str]:
    """The decisions a human may take on ``run`` now ([] unless it waits for one).

    A gate review that stopped the run may continue; ``another_round`` only when
    the gate is inside a loop (the payload names the loop). Any other reason —
    including a run that ended as needs_human before payloads existed — can only
    be closed. ``run`` is a ``plain`` row (ints, not DynamoDB Decimals).
    """
    if run.get('status') != _RUN_NEEDS_HUMAN or isinstance(run.get('decision'), Mapping):
        return []
    payload = run.get('needs_human')
    if not isinstance(payload, Mapping) or payload.get('reason') not in GATE_REASONS:
        return [DECISION_STOP]
    if _is_whole(payload.get('loop_index')):
        return [DECISION_ACCEPT, DECISION_ANOTHER_ROUND, DECISION_STOP]
    return [DECISION_ACCEPT, DECISION_STOP]


def parse_decision(body: Mapping[str, Any]) -> tuple[str, str | None]:
    """``(decision, note)`` from the request body; 400 on anything else."""
    decision = body.get('decision')
    if not isinstance(decision, str) or decision not in DECISIONS:
        raise ValidationError(f"decision must be one of {', '.join(DECISIONS)}")
    note = body.get('note')
    if note is None:
        return decision, None
    if not isinstance(note, str):
        raise ValidationError('note must be a string')
    note = note.strip()
    if len(note) > MAX_NOTE_CHARS:
        raise ValidationError(f'note must be at most {MAX_NOTE_CHARS} characters')
    return decision, note or None
