"""What the author already typed, for the document wizard's two AI drafts.

`POST /projects/{id}/documents/suggest-brief` (title + description) and
`POST /projects/{id}/prfaq-autofill` (the five Working-Backwards answers) used to
draft from the project's feedback alone, so a person who had typed a title got a
different feature back. Both now send what is in the fields, and the prompt
treats it as the author's INTENT: keep the topic and meaning, fix and expand;
draft only what is empty. With every field empty the prompts are unchanged.

The typed text reaches the model only inside an ``<author_draft>`` DATA block
(shared/prompt_safety.py), never as instructions, and its size is capped here:
the routes call ``validate_brief_body`` / ``validate_autofill_body`` before the
assist job is created, so an oversized or mistyped body is a synchronous 400.
"""
from __future__ import annotations

from dataclasses import dataclass

from shared.exceptions import ValidationError
from shared.prompt_safety import data_block

# Caps, in characters (a title is a short name; a description or an answer is a
# few paragraphs). The wizard's inputs carry the same `maxLength`.
TITLE_MAX_CHARS = 200
DESCRIPTION_MAX_CHARS = 4000
ANSWER_MAX_CHARS = 4000
ANSWER_COUNT = 5

AUTHOR_DRAFT_TAG = 'author_draft'

# The five Working-Backwards questions, in the order the wizard shows them.
CUSTOMER_QUESTIONS = (
    'Who is the customer?',
    'What is the customer problem or opportunity?',
    'What is the most important customer benefit?',
    'How do you know what customers need or want? (cite the feedback/personas above)',
    'What does the customer experience look like?',
)

BRIEF_INTENT_RULE = (
    "The author has already started this brief: their words are in the "
    "<author_draft> block. Treat them as the author's intent. Keep their topic "
    "and meaning — never replace it with a different feature. Fix the wording "
    "and expand it: polish the title (keep it when it is already good), and turn "
    "the description into one or two clear, specific paragraphs grounded in the "
    "customer feedback. When one of the two is empty, write it for the feature "
    "the other one describes."
)

ANSWERS_INTENT_RULE = (
    "The <author_draft> block holds the feature (title and description) and any "
    "answers the author has already typed. Ground every answer in that feature. "
    "For an answer the author wrote: keep its meaning and facts, fix and expand it "
    "into 2-5 concrete sentences — never replace it with a different answer and "
    "never return it empty. Draft only the answers marked (empty)."
)


@dataclass(frozen=True)
class BriefDraft:
    """The wizard's title and description as typed (stripped; '' when empty)."""

    title: str
    description: str

    @property
    def has_text(self) -> bool:
        return bool(self.title or self.description)


def _text(value: object, label: str, cap: int) -> str:
    """``value`` stripped ('' when absent or null); 400 when not text or over ``cap``."""
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ValidationError(f'{label} must be text')
    if len(value) > cap:
        raise ValidationError(f'{label} is too long (at most {cap} characters)')
    return value.strip()


def _body(body: object) -> dict:
    return body if isinstance(body, dict) else {}


def brief_draft(body: object) -> BriefDraft:
    """The typed title (``title``) and description (``feature_idea``), validated."""
    data = _body(body)
    return BriefDraft(
        title=_text(data.get('title'), 'Title', TITLE_MAX_CHARS),
        description=_text(data.get('feature_idea'), 'Description', DESCRIPTION_MAX_CHARS),
    )


def typed_answers(body: object) -> tuple[str, ...]:
    """The five typed answers (``answers``, '' for an empty one), validated.

    Absent or null = none typed. A list longer than five, a non-text entry or an
    answer over the cap is a 400.
    """
    raw = _body(body).get('answers')
    if raw is None:
        return ('',) * ANSWER_COUNT
    if not isinstance(raw, list) or len(raw) > ANSWER_COUNT:
        raise ValidationError(f'answers must be a list of at most {ANSWER_COUNT} texts')
    answers = [
        _text(value, f'Answer {index + 1}', ANSWER_MAX_CHARS)
        for index, value in enumerate(raw)
    ]
    return tuple(answers + [''] * (ANSWER_COUNT - len(answers)))


def _validate_filters(body: dict) -> None:
    filters = body.get('filters')
    if filters is not None and not isinstance(filters, dict):
        raise ValidationError('filters must be an object')


def validate_brief_body(body: object) -> None:
    """The suggest-brief route's synchronous 400s (before any job is created)."""
    brief_draft(body)
    _validate_filters(_body(body))


def validate_autofill_body(body: object) -> None:
    """The prfaq-autofill route's synchronous 400s (before any job is created)."""
    brief_draft(body)
    typed_answers(body)
    _validate_filters(_body(body))


def brief_block(draft: BriefDraft) -> str:
    """The typed title + description as an ``<author_draft>`` DATA block ('' when both empty)."""
    if not draft.has_text:
        return ''
    return data_block(AUTHOR_DRAFT_TAG, (
        f"TITLE: {draft.title or '(empty)'}\n"
        f"DESCRIPTION: {draft.description or '(empty)'}"
    ))


def answers_block(draft: BriefDraft, answers: tuple[str, ...]) -> str:
    """The feature and every typed answer as an ``<author_draft>`` DATA block."""
    lines = [
        f"FEATURE TITLE: {draft.title or '(unspecified)'}",
        f"FEATURE DESCRIPTION: {draft.description or '(unspecified)'}",
        '',
    ]
    for number, (question, answer) in enumerate(zip(CUSTOMER_QUESTIONS, answers, strict=True), start=1):
        lines.append(f"ANSWER {number} ({question}): {answer or '(empty)'}")
    return data_block(AUTHOR_DRAFT_TAG, '\n'.join(lines))
