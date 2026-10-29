"""The server-side gate on AI writing of PR/FAQs and PRDs (docs/ways-of-working.md).

``require_ai_writing(table, subject, doc_type, kind)`` raises 403 with a coaching
message unless the person's way of working (shared/ai_mode.py) allows the AI to
write ``doc_type`` for them in that ``kind`` of call:

- ``human_driven``: interactive (editor, chat) only with the type unlocked; autonomous never;
- ``ai_assisted``: interactive yes; autonomous (agents, plans, MCP) never;
- ``ai_driven``: both.

Only ``prfaq`` and ``prd`` are gated; every other document type is unchanged.
It fails closed: no person to evaluate (a legacy MCP token without a minter) or an
unreadable mode row is a refusal, never a pass.

The kind comes from the request's claims (``writing_kind``): an ``agent:`` or
``mcp:`` subject, or a plan step (``voc:principal`` = ``plan:…``), is autonomous;
API Gateway builds claims from the verified JWT alone, so a browser can produce
none of those. Everything else — the person in the SPA, and the assistant's
approved client tools, which the SPA executes with the person's own token — is
interactive.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared import ai_mode
from shared.exceptions import AuthorizationError
from shared.logging import logger
from shared.project_access import SYNTHETIC_SUBJECT_PREFIXES, claim_text, claims_from_event

KIND_INTERACTIVE: Final = 'interactive'
KIND_AUTONOMOUS: Final = 'autonomous'
GATED_DOC_TYPES: Final = ('prfaq', 'prd')
#: The plan runtime's principal claim and prefix (agents/plan_identity.py sets them on every step).
PLAN_PRINCIPAL_CLAIM: Final = 'voc:principal'
PLAN_PRINCIPAL_PREFIX: Final = 'plan:'

_LABELS: Final = {'prfaq': 'PR/FAQ', 'prd': 'PRD'}
#: How every autonomous refusal starts; the agents runtime recognises it (agents/nodes/documents.py).
AUTONOMOUS_REFUSAL_PREFIX: Final = 'Agents and plans write a'


def writing_kind(event: Mapping[str, Any]) -> str:
    """``autonomous`` for an agent, MCP token or plan step; ``interactive`` otherwise."""
    claims = claims_from_event(event)
    if claim_text(claims, 'sub').startswith(SYNTHETIC_SUBJECT_PREFIXES):
        return KIND_AUTONOMOUS
    if claim_text(claims, PLAN_PRINCIPAL_CLAIM).startswith(PLAN_PRINCIPAL_PREFIX):
        return KIND_AUTONOMOUS
    return KIND_INTERACTIVE


def is_gated(doc_type: object) -> bool:
    return doc_type in GATED_DOC_TYPES


def allows(mode: ai_mode.AiMode, doc_type: str, kind: str) -> bool:
    """The rules in the module docstring."""
    if not is_gated(doc_type) or mode.mode == ai_mode.MODE_AI_DRIVEN:
        return True
    if kind != KIND_INTERACTIVE:
        return False
    return mode.mode == ai_mode.MODE_AI_ASSISTED or doc_type in mode.unlocked


def _refusal(doc_type: str, kind: str) -> AuthorizationError:
    label = _LABELS.get(doc_type, doc_type)
    if kind == KIND_AUTONOMOUS:
        return AuthorizationError(
            f'{AUTONOMOUS_REFUSAL_PREFIX} {label} only for people working AI-driven. '
            f'Write it in the editor, or ask an administrator to change your way of working.')
    return AuthorizationError(
        f'You work Human-driven on {label}s: you write, the AI coaches. Use "Coach me" or '
        f'"Review my draft", or ask an administrator to unlock "{label} with AI".')


def require_ai_writing(table: Any, subject: str, doc_type: object, kind: str) -> None:
    """403 unless ``subject`` may have the AI write ``doc_type`` in a ``kind`` call."""
    if not is_gated(doc_type):
        return
    gated = str(doc_type)
    if not subject or subject.startswith(SYNTHETIC_SUBJECT_PREFIXES):
        raise _refusal(gated, kind)
    try:
        mode = ai_mode.get_ai_mode(table, subject)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Way-of-working read failed; refusing AI writing')
        raise AuthorizationError('Could not check your way of working with AI. Please retry.') from exc
    if not allows(mode, gated, kind):
        raise _refusal(gated, kind)
