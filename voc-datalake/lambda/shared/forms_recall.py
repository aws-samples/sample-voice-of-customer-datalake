"""Recall in a feedback form's texts (docs/feedback-forms.md, "Recall"): ``{{id}}`` or ``{{id|fallback}}`` shows a
hidden field's value, or an earlier question's answer, where the placeholder stands.

ONE grammar, three implementations pinned by ``schemas/form-recall-cases.json``: this module (the server's checks),
frontend/src/pages/FeedbackForms/model/recall.ts (the builder's problems, its "Insert a value" menu and preview) and
lambda/api/static/feedback-widget.js (what respondents see). A placeholder is ``{{`` and ``}}`` around a text with no
brace in it; the text before its first ``|`` is the id (spaces trimmed), the rest the fallback.

Where recall works (``recall_texts``): the welcome title and description, every question's headline and subheader (a
statement's included) and every ending's title and description. An id there names a declared hidden field (looked up
first) or a question of a recallable type (a score: rating, NPS, CSAT, CES; or a single choice, its label) placed
BEFORE the text (the welcome has none before it; an ending has every question). Never an open text, a contact, a
multiple choice, a consent or a matrix answer, and never in an option label, a button, a placeholder or an address.

Before a form goes (or stays) live, ``unresolved_placeholders`` lists every ``{{…}}`` respondents would see as it is
written (the handler's 409 ``unresolved_placeholder``, the one rule since 7.63.00: a draft's save is never refused for
one): a recall text's placeholder that names nothing (``recall_unknown``), a question at or after the text
(``recall_not_before``) or one whose answer is never recalled (``recall_type``), and any placeholder in a text where
recall never works.
``shown_as_ids`` is how the server shows a text with placeholders to a reader of its results (a CSV header, an item's
text): ``[id]``, never a respondent's value. How a respondent sees a text is the widget's alone (the cases' ``render``).

Pure: no AWS client, no I/O.
"""
from __future__ import annotations

import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

__all__ = ['PLACEHOLDER', 'shown_as_ids', 'unresolved_placeholders']

#: ``{{`` and ``}}`` around a text without braces: one placeholder (``{{{x}}}`` holds ``{{x}}`` and two loose braces).
PLACEHOLDER: Final = re.compile(r'\{\{([^{}]*)\}\}')
#: The question types whose answer can be recalled: a score, or a single choice's label (shared/forms_v2.py's names).
RECALL_TYPES: Final = frozenset({'rating', 'nps', 'csat', 'ces', 'single_select'})
#: The texts the 409 ``unresolved_placeholder`` lists at most.
MAX_UNRESOLVED: Final = 20

RECALL_UNKNOWN: Final = 'recall_unknown'
RECALL_NOT_BEFORE: Final = 'recall_not_before'
RECALL_TYPE: Final = 'recall_type'

#: Each text field respondents can be shown, by where it is: the recall texts, then every other one (labels, buttons,
#: placeholders), in which a placeholder is never filled.
_WELCOME_RECALL: Final = ('title', 'description')
_QUESTION_RECALL: Final = ('headline', 'subheader')
_ENDING_RECALL: Final = ('title', 'description')
_QUESTION_OTHER: Final = ('button_label', 'placeholder', 'lower_label', 'upper_label', 'label')
_LISTS: Final = ('options', 'rows', 'columns')


@dataclass(frozen=True)
class Placeholder:
    """One ``{{…}}``: as written, its id (trimmed) and its fallback (trimmed; '' for none)."""

    raw: str
    id: str
    fallback: str


def placeholders(text: object) -> list[Placeholder]:
    """The placeholders in ``text``, in order ([] for a text without one, or for no text)."""
    if not isinstance(text, str) or '{{' not in text:
        return []
    found = []
    for match in PLACEHOLDER.finditer(text):
        inner = match.group(1)
        key, _bar, fallback = inner.partition('|')
        found.append(Placeholder(match.group(0), key.strip(), fallback.strip()))
    return found


def shown_as_ids(text: str) -> str:
    """``text`` with each placeholder shown as ``[id]``: a results reader's view, never a respondent's value."""
    return PLACEHOLDER.sub(lambda match: f"[{match.group(1).partition('|')[0].strip()}]", text)


def _texts(value: object) -> Iterator[tuple[str, str]]:
    """An I18nText's ``(locale, text)`` pairs (none for anything else)."""
    if isinstance(value, Mapping):
        for locale, text in value.items():
            if isinstance(text, str):
                yield str(locale), text


def _shown(part: object) -> bool:
    """Whether a part that can be switched off (the welcome, a choice's Other or None row) is on: one that is off is
    never shown, so its texts never block a publish (7.66.00)."""
    return isinstance(part, Mapping) and part.get('enabled') is True


def recall_texts(definition: Mapping[str, Any]) -> Iterator[tuple[str, int, Mapping[str, Any]]]:
    """Each recall text respondents can be shown: ``(where, before, i18n)``, ``before`` the number of questions placed
    before it (a welcome that is off has none)."""
    questions = [q for q in definition.get('questions') or [] if isinstance(q, Mapping)]
    welcome = definition.get('welcome')
    if isinstance(welcome, Mapping) and _shown(welcome):
        for key in _WELCOME_RECALL:
            yield f'welcome.{key}', 0, welcome.get(key) or {}
    for index, question in enumerate(questions):
        for key in _QUESTION_RECALL:
            yield f'questions[{index}].{key}', index, question.get(key) or {}
    for index, ending in enumerate(definition.get('endings') or []):
        if isinstance(ending, Mapping):
            for key in _ENDING_RECALL:
                yield f'endings[{index}].{key}', len(questions), ending.get(key) or {}


def _question_other_texts(at: str, question: Mapping[str, Any]) -> Iterator[tuple[str, object]]:
    """A question's texts where recall never works: its button, labels and placeholders, the Other and None rows (when
    on), its options, rows and columns, and its call to action."""
    for key in _QUESTION_OTHER:
        yield f'{at}.{key}', question.get(key)
    for toggle in ('other', 'none'):
        row = question.get(toggle)
        if isinstance(row, Mapping) and _shown(row):
            yield f'{at}.{toggle}.label', row.get('label')
            yield f'{at}.{toggle}.placeholder', row.get('placeholder')
    for listed in _LISTS:
        for n, entry in enumerate(question.get(listed) or []):
            if isinstance(entry, Mapping):
                yield f'{at}.{listed}[{n}].label', entry.get('label')
    cta = question.get('cta')
    if isinstance(cta, Mapping):
        yield f'{at}.cta.label', cta.get('label')
        yield f'{at}.cta.url', cta.get('url')


def _other_texts(definition: Mapping[str, Any]) -> Iterator[tuple[str, object]]:
    """Every other text respondents can be shown (``(where, I18nText or address)``): never a recall text."""
    welcome = definition.get('welcome')
    if isinstance(welcome, Mapping) and _shown(welcome):
        yield 'welcome.button_label', welcome.get('button_label')
    for index, question in enumerate(definition.get('questions') or []):
        if isinstance(question, Mapping):
            yield from _question_other_texts(f'questions[{index}]', question)
    for index, ending in enumerate(definition.get('endings') or []):
        button = ending.get('button') if isinstance(ending, Mapping) else None
        if isinstance(button, Mapping):
            yield f'endings[{index}].button.label', button.get('label')
            yield f'endings[{index}].button.url', button.get('url')


def _problem(definition: Mapping[str, Any], before: int, key: str) -> str | None:
    """What is wrong with recalling ``key`` in a text ``before`` questions in (None: it can be recalled there)."""
    hidden = {field.get('id') for field in definition.get('hidden_fields') or [] if isinstance(field, Mapping)}
    if key in hidden:
        return None
    questions = [q for q in definition.get('questions') or [] if isinstance(q, Mapping)]
    position = next((index for index, q in enumerate(questions) if q.get('id') == key), None)
    if position is None:
        return RECALL_UNKNOWN
    if position >= before:
        return RECALL_NOT_BEFORE
    return None if questions[position].get('type') in RECALL_TYPES else RECALL_TYPE


def _unfilled(definition: Mapping[str, Any]) -> Iterator[dict[str, str]]:
    for where, before, value in recall_texts(definition):
        for locale, text in _texts(value):
            for placeholder in placeholders(text):
                if _problem(definition, before, placeholder.id) is not None:
                    yield {'where': f'{where}.{locale}', 'placeholder': placeholder.raw[:60]}
    for where, value in _other_texts(definition):
        pairs: Sequence[tuple[str, str]] = [('', value)] if isinstance(value, str) else list(_texts(value))
        for locale, text in pairs:
            for placeholder in placeholders(text):
                yield {'where': f'{where}.{locale}' if locale else where, 'placeholder': placeholder.raw[:60]}


def unresolved_placeholders(definition: Mapping[str, Any]) -> list[dict[str, str]]:
    """Every ``{{…}}`` respondents would see as written (at most ``MAX_UNRESOLVED``): ``[{where, placeholder}]``."""
    out = []
    for entry in _unfilled(definition):
        out.append(entry)
        if len(out) == MAX_UNRESOLVED:
            break
    return out
