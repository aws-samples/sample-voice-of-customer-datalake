"""Who a voice session talks to (7.104.00; docs/voice-personas.md → The product interviewer): a project's persona
(7.69.00) or the product team's own product, through a neutral AI interviewer that asks about the Product tab's
fields.

shared/voice_sessions.py runs both on the same checks, limits and budget; this module holds what differs:

* **The subject** (``VoiceSubject``): its kind, the session row's and its project pointer's ``kind``
  (``persona_interview``, the kind of a row written before 7.104.00, or ``product_interview``), and the persona's id
  (none for the product). A session is answered only through the routes of its own subject (``matches``).
* **The product interview's input** (``product_interview``): the questions it asks, the person's own (``questions`` of
  the start, as the Product tab's gaps panel shows them) or else one for every empty field (an empty ``question``:
  the relay asks the field's default, lambda/stream/src/assistant/tools/product-interview.ts), and what the form
  already says (``known``), read from the project's ``PRODUCT_CONTEXT`` row by its one reader
  (shared/product_proposals.py ``context_state``: a list stored under the old schema reads as its lines). The fields
  and the question cap come from shared/product_fields.py, their one Python home.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal

from shared.exceptions import ValidationError
from shared.product_fields import ALL_FIELDS, MAX_QUESTION_CHARS
from shared.product_proposals import FIELD_ORDER, context_state

__all__ = [
    'PERSONA_INTERVIEW', 'PRODUCT', 'VoiceSubject', 'kind_of', 'matches', 'persona', 'product_interview',
    'requested_questions', 'subject_of',
]

SessionKind = Literal['persona_interview', 'product_interview']

PERSONA_INTERVIEW: Final = 'persona_interview'
PRODUCT_INTERVIEW: Final = 'product_interview'
#: A start's questions: at most one asked per field (the first), each at most ``MAX_QUESTION_CHARS``
#: (shared/product_fields.py: an extract's question's cap), asked in their order; with none, the empty fields are
#: asked in ``FIELD_ORDER``, the PRD / PR-FAQ block's.
MAX_QUESTIONS: Final = len(ALL_FIELDS)
#: One known value as the interviewer reads it (the form's own caps go up to 4,000).
MAX_KNOWN_CHARS: Final = 500


@dataclass(frozen=True)
class VoiceSubject:
    """A session's subject: a project's persona (its id) or the project's product (no id)."""

    kind: SessionKind
    persona_id: str | None = None

    @property
    def is_product(self) -> bool:
        return self.kind == PRODUCT_INTERVIEW

    def job_fields(self) -> dict[str, str]:
        """What the transcript job's config says of the subject (a config without ``kind`` is a persona's)."""
        return {'kind': PRODUCT_INTERVIEW} if self.is_product else {'persona_id': str(self.persona_id)}


def persona(persona_id: str) -> VoiceSubject:
    return VoiceSubject(PERSONA_INTERVIEW, persona_id)


PRODUCT: Final = VoiceSubject(PRODUCT_INTERVIEW)


def kind_of(item: Mapping[str, Any]) -> SessionKind:
    """A session row's, a pointer's or a job config's kind: a persona's unless it says the product's."""
    return PRODUCT_INTERVIEW if item.get('kind') == PRODUCT_INTERVIEW else PERSONA_INTERVIEW


def subject_of(item: Mapping[str, Any]) -> VoiceSubject:
    """The subject a session row, its pointer or its transcript job's config names."""
    if kind_of(item) == PRODUCT_INTERVIEW:
        return PRODUCT
    return persona(str(item.get('persona_id') or ''))


def matches(item: Mapping[str, Any], subject: VoiceSubject) -> bool:
    """Whether a session row or pointer is ``subject``'s: its kind, and its persona (none for the product)."""
    return kind_of(item) == subject.kind and item.get('persona_id') == subject.persona_id


def _question(value: object) -> tuple[str, str]:
    field = value.get('field') if isinstance(value, Mapping) else None
    if not isinstance(value, Mapping) or not isinstance(field, str) or field not in ALL_FIELDS:
        raise ValidationError('Each question names one of the product fields', code='invalid_questions')
    text = value.get('question', '')
    if not isinstance(text, str) or len(text) > MAX_QUESTION_CHARS:
        raise ValidationError(f'A question is text of at most {MAX_QUESTION_CHARS} characters',
                              code='invalid_questions')
    return field, text.strip()


def requested_questions(value: object) -> tuple[tuple[str, str], ...]:
    """A start's ``questions`` (``[{field, question}]``, optional): at most ``MAX_QUESTIONS``, each naming a product
    field, and only the first for each field is asked (7.104.00 round 2: a proposal stored before its extract kept one
    question a field may hold two, and still starts the interview). None (absent, null or empty) leaves the interview
    to the empty fields. Anything else is a 400 ``invalid_questions``."""
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > MAX_QUESTIONS:
        raise ValidationError(f'questions is a list of at most {MAX_QUESTIONS}', code='invalid_questions')
    first: dict[str, str] = {}
    for field, text in (_question(one) for one in value):
        first.setdefault(field, text)
    return tuple(first.items())


def _context(projects: Any, project_id: str) -> dict[str, str]:
    """The project's product context, each field's value as text ('' when unset or the row is missing): the
    deployment's, as every voice session is (shared/voice_sessions.py ``mint`` refused a workspace first)."""
    values = context_state(projects, project_id, workspace=None).values
    return {field: values[field].strip() for field in FIELD_ORDER}


def product_interview(projects: Any, project_id: str,
                      requested: tuple[tuple[str, str], ...]) -> dict[str, Any]:
    """The product interview's ``questions`` and ``known`` (evidence.json): the person's questions as asked, else one
    for each empty field (every field when none is empty), each ``''`` for the relay's default; the filled fields'
    values, clipped."""
    context = _context(projects, project_id)
    if requested:
        questions = [{'field': field, 'question': text} for field, text in requested]
    else:
        empty = [field for field in FIELD_ORDER if not context[field]] or list(FIELD_ORDER)
        questions = [{'field': field, 'question': ''} for field in empty]
    known = {field: value[:MAX_KNOWN_CHARS] for field, value in context.items() if value}
    return {'questions': questions, 'known': known}
