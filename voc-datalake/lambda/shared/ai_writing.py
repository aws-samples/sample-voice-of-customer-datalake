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

``require_autonomous_writing`` (7.104.00) is the same dial for what an autonomous caller
writes outside a document: the Product tab's product description (an MCP client's or an
agent's accept of an extract's proposal, an agent's, plan step's or MCP client's PUT of its
fields) is written only for people working AI-driven (403 ``ai_writing_refused``); a
person's own write (the Product tab, the assistant's approved card) is allowed in every
mode, as a hand-written document is. Both read a person's way of working one way
(``_mode_of``: no person is a refusal, an unreadable mode a ``ModeUnreadableError``), and
an autonomous write is for the people ``written_for`` names: the person it acts as, and
the project's owner when that is someone else.

The kind comes from the request's claims (``writing_kind``): an ``agent:`` or
``mcp:`` subject, or a plan step (``voc:principal`` = ``plan:…``), is autonomous;
API Gateway builds claims from the verified JWT alone, so a browser can produce
none of those. Everything else — the person in the SPA, and the assistant's
approved client tools, which the SPA executes with the person's own token — is
interactive.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared import ai_mode
from shared.exceptions import AuthorizationError
from shared.logging import logger
from shared.project_access import SYNTHETIC_SUBJECT_PREFIXES, claim_text, claims_from_event, is_synthetic_subject

KIND_INTERACTIVE: Final = 'interactive'
KIND_AUTONOMOUS: Final = 'autonomous'
GATED_DOC_TYPES: Final = ('prfaq', 'prd')
#: The product description, which an autonomous caller writes for its people only when they work AI-driven
#: (``require_autonomous_writing``): its label in the refusal.
PRODUCT_CONTEXT: Final = 'product_context'
#: The code of an autonomous write the dial refuses (``require_autonomous_writing``).
AI_WRITING_REFUSED: Final = 'ai_writing_refused'
#: The plan runtime's principal claim and prefix (agents/plan_identity.py sets them on every step).
PLAN_PRINCIPAL_CLAIM: Final = 'voc:principal'
PLAN_PRINCIPAL_PREFIX: Final = 'plan:'

_LABELS: Final = {'prfaq': 'PR/FAQ', 'prd': 'PRD', PRODUCT_CONTEXT: 'product description'}
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


def _refusal(doc_type: str, kind: str, code: str | None = None) -> AuthorizationError:
    label = _LABELS.get(doc_type, doc_type)
    if kind == KIND_AUTONOMOUS:
        return AuthorizationError(
            f'{AUTONOMOUS_REFUSAL_PREFIX} {label} only for people working AI-driven. '
            f'Write it in the editor, or ask an administrator to change your way of working.', code=code)
    return AuthorizationError(
        f'You work Human-driven on {label}s: you write, the AI coaches. Use "Coach me" or '
        f'"Review my draft", or ask an administrator to unlock "{label} with AI".')


class ModeUnreadableError(AuthorizationError):
    """The way of working could not be read: a refusal to retry, never a decision about the person."""


def _mode_of(table: Any, subject: str, refusal: AuthorizationError) -> ai_mode.AiMode:
    """``subject``'s way of working, the one read of it here: ``refusal`` when there is no person to evaluate (a blank
    or synthetic subject), a ``ModeUnreadableError`` when it cannot be read (fails closed, never a pass)."""
    if not subject or subject.startswith(SYNTHETIC_SUBJECT_PREFIXES):
        raise refusal
    try:
        return ai_mode.get_ai_mode(table, subject)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Way-of-working read failed; refusing AI writing')
        raise ModeUnreadableError('Could not check your way of working with AI. Please retry.') from exc


def written_for(subject: str, owner: object) -> tuple[str, ...]:
    """Whom an autonomous write is AI writing for: the person it acts as (``subject``), and the project's owner
    (``owner``, its ``META``'s ``owner_sub``) when that is someone else and a person (an agent hands its project to a
    category owner)."""
    if isinstance(owner, str) and owner and owner != subject and not is_synthetic_subject(owner):
        return subject, owner
    return (subject,)


def require_ai_writing(table: Any, subject: str, doc_type: object, kind: str) -> ai_mode.AiMode | None:
    """403 unless ``subject`` may have the AI write ``doc_type`` in a ``kind`` call.

    Answers the mode it read (None for an ungated type: nothing is read), so a caller that also
    needs the person's mode reads it once.
    """
    if not is_gated(doc_type):
        return None
    gated = str(doc_type)
    mode = _mode_of(table, subject, _refusal(gated, kind))
    if not allows(mode, gated, kind):
        raise _refusal(gated, kind)
    return mode


def require_autonomous_writing(table: Any, subjects: Iterable[str]) -> None:
    """403 ``ai_writing_refused`` unless every one of ``subjects`` (``written_for``) works AI-driven: an autonomous
    caller's write of the product description is AI writing for each of them, as a PR/FAQ's or a PRD's is
    (``require_ai_writing``). Fails closed (``_mode_of``)."""
    refusal = _refusal(PRODUCT_CONTEXT, KIND_AUTONOMOUS, AI_WRITING_REFUSED)
    for subject in subjects:
        if _mode_of(table, subject, refusal).mode != ai_mode.MODE_AI_DRIVEN:
            raise refusal
