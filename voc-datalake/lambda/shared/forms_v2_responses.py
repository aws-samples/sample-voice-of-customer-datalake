"""A response to a version 2 feedback form (docs/feedback-forms.md, "Responses"): checked answer by answer against the
revision it answered, then turned into the feedback item the processor enriches.

``check_envelope`` bounds the public submit's body before any read; ``validate_response`` checks it against the
form's definition (shared/forms_v2.py): the type, required answers, ranges, option codes, the character and selection
limits, the hidden fields, and the logic path (``logic_path``: no answer to a question the logic skipped). The ingest
helpers then build the item: ``response_text`` (the open-text answers, each under its headline in the primary
language), ``answer_category`` (the first answered option that maps one), ``item_rating`` and ``contact_of``.

Pure: no AWS client, no I/O, no clock.
"""
from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urlsplit

from shared.exceptions import ValidationError
from shared.forms_recall import shown_as_ids
from shared.forms_v2 import (
    CONSENT,
    CONTACT,
    CONTACT_FIELDS,
    CSAT,
    FORM_LOCALES,
    HIDDEN_ID,
    MATRIX,
    MAX_HIDDEN_FIELDS,
    MAX_HIDDEN_VALUE_CHARS,
    MAX_OPEN_TEXT_CHARS,
    MAX_OTHER_CHARS,
    MAX_QUESTIONS,
    MULTI,
    NONE_CODE,
    OPEN_TEXT,
    OTHER_CODE,
    QUESTION_ID,
    RATING,
    SCALE_TYPES,
    SELECT_TYPES,
    SINGLE,
    STATEMENT,
    question_bounds,
    text_in,
)

__all__ = [
    'answer_category',
    'check_envelope',
    'contact_of',
    'headline_of',
    'is_v2_response',
    'item_rating',
    'matrix_label',
    'response_text',
    'validate_response',
]

#: The keys a version 2 submission may carry; anything else is refused.
RESPONSE_KEYS: Final = frozenset({'answers', 'hidden', 'form_revision', 'language', 'ending_id', 'test', 'form_id',
                                  'page_url', 'dimensions', 'participant_token', 'custom_fields', 'session', 'channel'})
#: How the widget that sent a response runs (7.04.00, the forms list's "Link · Website script · Embedded"): the API's
#: own page opened as it is, that page framed in another (the iframe snippet), or a script embed. Optional: a widget
#: from before 7.04.00 sends none.
CHANNELS: Final = ('link', 'iframe', 'script')
#: The widget's random id of one visit (never stored with anything that names a person): the funnel leaves out a
#: ``left`` beacon of a session that submitted.
SESSION_ID: Final = re.compile(r'[A-Za-z0-9_-]{8,64}')
#: All the free text of one response together (open-text and "Other" answers): the item stays far inside 400 KB.
MAX_RESPONSE_TEXT_CHARS: Final = 20_000
MAX_TEST_TOKEN_CHARS: Final = 64
_MAX_ID_CHARS: Final = 44
_CONTACT_LIMITS: Final = {'name': 200, 'email': 254, 'phone': 40, 'company': 200}
_EMAIL: Final = re.compile(r'[^@\s]+@[^@\s]+\.[^@\s]+')
_PHONE: Final = re.compile(r'\+?[0-9 ().\-/]{3,40}')


#: The ``code`` of each refusal (docs/feedback-forms.md "Refusals"): the widget words it in the respondent's language
#: and, with ``question_id``, goes back to that question. The English ``error`` is for logs and integrators.
ANSWER_INVALID: Final = 'answer_invalid'
ANSWER_REQUIRED: Final = 'answer_required'
ANSWER_SKIPPED: Final = 'answer_skipped'
ANSWER_UNKNOWN: Final = 'answer_unknown'
SELECTION_COUNT: Final = 'selection_count'
EMPTY_RESPONSE: Final = 'empty_response'
RESPONSE_TOO_LONG: Final = 'response_too_long'
HIDDEN_UNKNOWN: Final = 'hidden_unknown'
HIDDEN_INVALID: Final = 'hidden_invalid'
LANGUAGE_INVALID: Final = 'language_invalid'
ENDING_MISMATCH: Final = 'ending_mismatch'
SUBMISSION_INVALID: Final = 'submission_invalid'


def _fail(message: str, code: str = SUBMISSION_INVALID, question_id: str | None = None) -> ValidationError:
    return ValidationError(message, code=code, details={'question_id': question_id} if question_id else None)


def _bad(question: Mapping[str, Any], message: str, code: str = ANSWER_INVALID) -> ValidationError:
    """A refusal of ``question``'s answer, naming it (``answers.<id>``) and carrying its id."""
    return _fail(f"answers.{question['id']}{message}", code, str(question['id']))


def is_v2_response(body: Mapping[str, Any]) -> bool:
    """A version 2 submission names its ``answers``; a body without them is the version 1 widget's ``text``."""
    return 'answers' in body


def _optional_str(body: Mapping[str, Any], key: str, limit: int) -> None:
    value = body.get(key)
    if value is not None and (not isinstance(value, str) or len(value) > limit):
        raise _fail(f'{key} must be a string of at most {limit} characters')


def check_envelope(body: Mapping[str, Any]) -> None:
    """The submission's shape, before the form is read: known keys only, ``answers`` an object of at most 30
    entries, ``hidden`` one of at most 20, ``form_revision`` a whole number, the short fields bounded."""
    unknown = sorted(str(key)[:40] for key in body if key not in RESPONSE_KEYS)
    if unknown:
        raise _fail(f'the submission has unknown fields: {", ".join(unknown[:5])}')
    answers = body.get('answers')
    if not isinstance(answers, Mapping) or len(answers) > MAX_QUESTIONS:
        raise _fail(f'answers must be an object of at most {MAX_QUESTIONS} answers')
    stray = sorted(str(key)[:44] for key in answers if not (isinstance(key, str) and QUESTION_ID.fullmatch(key)))
    if stray:
        raise _fail(f'answers.{stray[0]} is not a question id', ANSWER_UNKNOWN, stray[0])
    hidden = body.get('hidden')
    if hidden is not None and (not isinstance(hidden, Mapping) or len(hidden) > MAX_HIDDEN_FIELDS or any(
            not (isinstance(key, str) and HIDDEN_ID.fullmatch(key)) or not (value is None or isinstance(value, str))
            for key, value in hidden.items())):
        raise _fail(f'hidden must be an object of at most {MAX_HIDDEN_FIELDS} hidden-field ids to texts', HIDDEN_INVALID)
    revision = body.get('form_revision')
    if revision is not None and (isinstance(revision, bool) or not isinstance(revision, int) or revision < 1):
        raise _fail('form_revision must be a whole number from 1')
    if body.get('language') is not None and body['language'] not in FORM_LOCALES:
        raise _fail(f'language must be one of: {", ".join(FORM_LOCALES)}', LANGUAGE_INVALID)
    _optional_str(body, 'ending_id', _MAX_ID_CHARS)
    _optional_str(body, 'test', MAX_TEST_TOKEN_CHARS)
    session = body.get('session')
    if session is not None and not (isinstance(session, str) and SESSION_ID.fullmatch(session)):
        raise _fail('session must be 8 to 64 letters, digits, _ or -')
    if body.get('channel') is not None and body['channel'] not in CHANNELS:
        raise _fail(f'channel must be one of: {", ".join(CHANNELS)}')
    _optional_str(body, 'form_id', 64)


# ── One answer ──────────────────────────────────────────────────────────────────────────────────────────────────

def _check_input(question: Mapping[str, Any], text: str) -> None:
    """The open-text ``input_type``'s format (text: any; a long text is always text, as the widget draws it)."""
    kind = 'text' if question.get('long') is True else question.get('input_type')
    if kind == 'email' and (len(text) > _CONTACT_LIMITS['email'] or not _EMAIL.fullmatch(text)):
        raise _bad(question, ' must be an email address')
    if kind == 'phone' and (not _PHONE.fullmatch(text) or sum(ch.isdigit() for ch in text) < 3):
        raise _bad(question, ' must be a phone number')
    if kind == 'number':
        try:
            number = float(text)
        except ValueError:
            raise _bad(question, ' must be a number') from None
        if not math.isfinite(number):
            raise _bad(question, ' must be a number')
    if kind == 'url':
        try:
            parts = urlsplit(text)
        except ValueError:
            raise _bad(question, ' must be a web address') from None
        if parts.scheme not in {'http', 'https'} or not parts.netloc or any(ch.isspace() for ch in text):
            raise _bad(question, ' must be a web address')


def _open_text(question: Mapping[str, Any], value: object) -> str | None:
    if not isinstance(value, str):
        raise _bad(question, ' must be a string')
    text = value.strip()
    if not text:
        return None
    limit = question.get('max_chars') or MAX_OPEN_TEXT_CHARS
    if len(text) > limit:
        raise _bad(question, f' must be at most {limit} characters')
    _check_input(question, text)
    return text


def _other_text(question: Mapping[str, Any], value: object) -> str | None:
    if not (question.get('other') or {}).get('enabled'):
        raise _bad(question, '.other: this question has no "Other" answer')
    if not isinstance(value, str) or len(value.strip()) > MAX_OTHER_CHARS:
        raise _bad(question, f'.other must be a string of at most {MAX_OTHER_CHARS} characters')
    return value.strip() or None


def _codes(question: Mapping[str, Any]) -> list[str]:
    return [option['code'] for option in question.get('options') or []]


def _single(question: Mapping[str, Any], value: object) -> dict[str, str] | None:
    if not isinstance(value, Mapping) or set(value) not in ({'code'}, {'other'}):
        raise _bad(question, ' must be {"code": …} or {"other": …}')
    if 'other' in value:
        other = _other_text(question, value['other'])
        return {'other': other} if other else None
    if value['code'] not in _codes(question):
        raise _bad(question, '.code is not an option of this question')
    return {'code': value['code']}


def _multi_codes(question: Mapping[str, Any], raw: object) -> list[str]:
    allowed = _codes(question) + ([NONE_CODE] if (question.get('none') or {}).get('enabled') else [])
    if not isinstance(raw, list) or len(raw) > len(allowed):
        raise _bad(question, ".codes must be a list of the question's option codes")
    if any(not isinstance(code, str) or code not in allowed for code in raw) or len(set(raw)) != len(raw):
        raise _bad(question, '.codes must name options of this question, each once')
    return [code for code in allowed if code in raw]


def _multi(question: Mapping[str, Any], value: object) -> dict[str, Any] | None:
    if not isinstance(value, Mapping) or not set(value) <= {'codes', 'other'}:
        raise _bad(question, ' must be {"codes": […], "other"?: …}')
    codes = _multi_codes(question, value.get('codes', []))
    other = _other_text(question, value['other']) if value.get('other') is not None else None
    if NONE_CODE in codes and (len(codes) > 1 or other) and (question.get('none') or {}).get('enabled'):
        raise _bad(question, ': "None of these" cannot be chosen with another answer')
    if not codes and not other:
        return None
    count = len(codes) + int(other is not None)
    if codes != [NONE_CODE] and not question.get('min', 1) <= count <= question.get('max', count):
        raise _bad(question, f' must choose from {question.get("min", 1)} to {question.get("max", count)} answers',
                   SELECTION_COUNT)
    return {'codes': codes, **({'other': other} if other else {})}


def _scale(question: Mapping[str, Any], value: object) -> int:
    low, high = question_bounds(question) or (0, 0)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise _bad(question, f' must be a whole number from {low} to {high}')
    return value


def _consent(question: Mapping[str, Any], value: object) -> bool | None:
    if not isinstance(value, bool):
        raise _bad(question, ' must be true or false')
    return True if value else None


def _contact_value(question: Mapping[str, Any], name: str, value: object) -> str:
    limit = _CONTACT_LIMITS[name]
    if not isinstance(value, str) or len(value.strip()) > limit:
        raise _bad(question, f'.{name} must be a string of at most {limit} characters')
    text = value.strip()
    if text and name == 'email' and not _EMAIL.fullmatch(text):
        raise _bad(question, '.email must be an email address')
    return text


def _contact(question: Mapping[str, Any], value: object) -> dict[str, str] | None:
    fields = question.get('fields') or {}
    shown = {name for name in CONTACT_FIELDS if (fields.get(name) or {}).get('show')}
    if not isinstance(value, Mapping) or not set(value) <= shown:
        raise _bad(question, f' may hold only the fields this question shows: {", ".join(sorted(shown))}')
    out = {name: text for name, raw in value.items() if (text := _contact_value(question, name, raw))}
    if not out:
        return None
    missing = [name for name in CONTACT_FIELDS if (fields.get(name) or {}).get('required') and name not in out]
    if missing:
        raise _bad(question, f'.{missing[0]} is required', ANSWER_REQUIRED)
    return out


def _statement(question: Mapping[str, Any], _value: object) -> None:
    raise _bad(question, ': a statement takes no answer')


def _codes_in(question: Mapping[str, Any], key: str) -> list[str]:
    return [str(entry['code']) for entry in question.get(key) or [] if isinstance(entry, Mapping)]


def _matrix(question: Mapping[str, Any], value: object) -> dict[str, Any] | None:
    """``{rows: {row: column}}``: known rows and columns only, kept in the question's row order (a row given ``null``
    is unanswered); every row when it is required, at least ``min_rows`` once any is answered."""
    if not isinstance(value, Mapping) or set(value) != {'rows'} or not isinstance(value['rows'], Mapping):
        raise _bad(question, ' must be {"rows": {row code: column code}}')
    rows, columns, given = _codes_in(question, 'rows'), set(_codes_in(question, 'columns')), value['rows']
    unknown = sorted(str(key)[:40] for key in given if key not in rows)
    if unknown:
        raise _bad(question, f'.rows.{unknown[0]} is not a row of this question')
    stray = [str(row) for row, column in given.items() if column is not None and column not in columns]
    if stray:
        raise _bad(question, f'.rows.{stray[0]} must name a column of this question')
    answered = {row: given[row] for row in rows if given.get(row) is not None}
    if not answered:
        return None
    if question.get('required') is True and len(answered) < len(rows):
        missing = next(row for row in rows if row not in answered)
        raise _bad(question, f'.rows.{missing} is required: answer every row', ANSWER_REQUIRED)
    least = question.get('min_rows')
    if isinstance(least, int) and len(answered) < least:
        raise _bad(question, f' must answer at least {least} rows', SELECTION_COUNT)
    return {'rows': answered}


_NORMALIZERS: Final[Mapping[str, Callable[[Mapping[str, Any], object], Any]]] = {
    OPEN_TEXT: _open_text, SINGLE: _single, MULTI: _multi, **dict.fromkeys(SCALE_TYPES, _scale),
    CONSENT: _consent, CONTACT: _contact, STATEMENT: _statement, MATRIX: _matrix,
}


def _answer(question: Mapping[str, Any], value: object) -> Any:
    """``value`` as stored for ``question``, None for no answer (null, blank, no choice, a declined consent)."""
    if value is None:
        return None
    return _NORMALIZERS[question['type']](question, value)


# ── The logic path ──────────────────────────────────────────────────────────────────────────────────────────────

def _chosen(answer: object) -> set[str]:
    """The codes a choice answer names (``other`` for an "Other" text)."""
    if not isinstance(answer, Mapping):
        return set()
    chosen = set(answer.get('codes') or []) | ({answer['code']} if 'code' in answer else set())
    return chosen | ({OTHER_CODE} if answer.get('other') else set())


def _codes_of(value: object) -> set[str]:
    """A rule's list of codes as a set (anything else: none)."""
    return {code for code in value if isinstance(code, str)} if isinstance(value, list) else set()


def _equals(question: Mapping[str, Any], value: object, answer: object) -> bool:
    if question['type'] in SELECT_TYPES:
        return _chosen(answer) == {value}
    if question['type'] == OPEN_TEXT:
        # Ignoring case as the widget does (JavaScript's toLowerCase, which str.lower matches): the path the widget
        # took is the path checked here. casefold would also fold ß to ss, which the widget does not.
        return isinstance(answer, str) and isinstance(value, str) and answer.lower() == value.lower()
    return answer == value


def _compare(op: str) -> Callable[[Mapping[str, Any], object, object], bool]:
    def compare(_question: Mapping[str, Any], value: object, answer: object) -> bool:
        if not isinstance(answer, int) or not isinstance(value, int):
            return False
        return {'lt': answer < value, 'lte': answer <= value, 'gt': answer > value, 'gte': answer >= value}[op]
    return compare


_MATCHERS: Final[Mapping[str, Callable[[Mapping[str, Any], object, object], bool]]] = {
    'equals': _equals,
    'not_equals': lambda question, value, answer: not _equals(question, value, answer),
    'includes_any': lambda _question, value, answer: bool(_chosen(answer) & _codes_of(value)),
    'includes_all': lambda _question, value, answer: _codes_of(value) <= _chosen(answer),
    **{op: _compare(op) for op in ('lt', 'lte', 'gt', 'gte')},
}


def rule_matches(question: Mapping[str, Any], when: Mapping[str, Any], answer: object) -> bool:
    """Whether a rule's condition holds for ``answer`` (None: unanswered; a statement always counts as submitted)."""
    op = when.get('op')
    answered = answer is not None or question['type'] == STATEMENT
    if op == 'submitted':
        return answered
    if op == 'skipped':
        return not answered
    if answer is None or op not in _MATCHERS:
        return False
    return _MATCHERS[str(op)](question, when.get('value'), answer)


def _jump(question: Mapping[str, Any], answer: object) -> str | None:
    """The first matching rule's target, None to go on to the next question."""
    for rule in question.get('logic') or []:
        if rule_matches(question, rule.get('when') or {}, answer):
            return (rule.get('then') or {}).get('jump_to')
    return None


def logic_path(definition: Mapping[str, Any], answers: Mapping[str, Any]) -> tuple[list[str], str]:
    """The questions a respondent with ``answers`` is shown, in order, and the ending they reach (the first ending
    when they run past the last question). The first matching rule of a question wins; jumps only go forward."""
    questions = list(definition.get('questions') or [])
    position = {question['id']: index for index, question in enumerate(questions)}
    endings = [ending['id'] for ending in definition.get('endings') or []]
    path: list[str] = []
    index = 0
    while index < len(questions):
        question = questions[index]
        path.append(question['id'])
        target = _jump(question, answers.get(question['id']))
        if target in position and position[target] > index:
            index = position[target]
        elif target in endings:
            return path, str(target)
        else:
            index += 1
    return path, endings[0] if endings else ''


# ── The whole response ──────────────────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Response:
    """A checked response: its answers (only the given, on-path ones), hidden values, the path it took, its ending
    and its language."""

    answers: dict[str, Any]
    hidden: dict[str, str]
    path: list[str]
    ending_id: str
    language: str


def _answers(definition: Mapping[str, Any], raw: Mapping[str, Any]) -> dict[str, Any]:
    questions = {question['id']: question for question in definition.get('questions') or []}
    unknown = sorted(str(key)[:44] for key in raw if key not in questions)
    if unknown:
        raise _fail(f'answers.{unknown[0]} is not a question of this form', ANSWER_UNKNOWN, unknown[0])
    answers: dict[str, Any] = {}
    for qid, value in raw.items():
        normalized = _answer(questions[qid], value)
        if normalized is not None:
            answers[qid] = normalized
    return answers


def _free_text(question: Mapping[str, Any], answer: object) -> str | None:
    """The customer's own words in an answer: an open text, or a choice's "Other"."""
    if question['type'] == OPEN_TEXT and isinstance(answer, str):
        return answer
    if question['type'] in SELECT_TYPES and isinstance(answer, Mapping) and isinstance(answer.get('other'), str):
        return answer['other']
    return None


def _check_path(definition: Mapping[str, Any], answers: Mapping[str, Any], path: Sequence[str]) -> None:
    questions = {question['id']: question for question in definition.get('questions') or []}
    skipped = [qid for qid in answers if qid not in path]
    if skipped:
        raise _fail(f"answers.{skipped[0]}: the form's logic skips this question for these answers", ANSWER_SKIPPED,
                    skipped[0])
    missing = [qid for qid in path if questions[qid].get('required') and qid not in answers]
    if missing:
        raise _fail(f'answers.{missing[0]} is required', ANSWER_REQUIRED, missing[0])
    if not answers:
        raise _fail('Answer at least one question', EMPTY_RESPONSE)
    total = sum(len(text) for qid, answer in answers.items() if (text := _free_text(questions[qid], answer)))
    if total > MAX_RESPONSE_TEXT_CHARS:
        raise _fail(f'the answers hold more than {MAX_RESPONSE_TEXT_CHARS} characters of text together', RESPONSE_TOO_LONG)


def _hidden(definition: Mapping[str, Any], raw: object) -> dict[str, str]:
    """The hidden values: declared ids only, each a string of at most 200 characters (blank ones dropped)."""
    declared = {field['id'] for field in definition.get('hidden_fields') or []}
    source = raw if isinstance(raw, Mapping) else {}
    unknown = sorted(str(key)[:40] for key in source if key not in declared)
    if unknown:
        raise _fail(f'hidden.{unknown[0]} is not a hidden field of this form', HIDDEN_UNKNOWN)
    out: dict[str, str] = {}
    for key, value in source.items():
        if value is None:
            continue
        if not isinstance(value, str) or len(value.strip()) > MAX_HIDDEN_VALUE_CHARS:
            raise _fail(f'hidden.{key} must be a string of at most {MAX_HIDDEN_VALUE_CHARS} characters', HIDDEN_INVALID)
        if value.strip():
            out[key] = value.strip()
    return out


def validate_response(definition: Mapping[str, Any], body: Mapping[str, Any]) -> Response:
    """``body`` (``check_envelope`` passed) checked against ``definition``, the revision it answered."""
    answers = _answers(definition, body.get('answers') or {})
    path, ending = logic_path(definition, answers)
    _check_path(definition, answers, path)
    language = body.get('language') or definition.get('language')
    if language not in (definition.get('languages') or [definition.get('language')]):
        raise _fail("language must be one of the form's languages", LANGUAGE_INVALID)
    if body.get('ending_id') is not None and body['ending_id'] != ending:
        raise _fail("ending_id is not the ending the form's logic reaches for these answers", ENDING_MISMATCH)
    return Response(answers, _hidden(definition, body.get('hidden')), path, ending, str(language))


# ── The feedback item ───────────────────────────────────────────────────────────────────────────────────────────

def _label(question: Mapping[str, Any], code: str, primary: str) -> str:
    if code == NONE_CODE and (question.get('none') or {}).get('enabled'):
        return text_in((question.get('none') or {}).get('label'), primary, primary) or 'None of these'
    for option in question.get('options') or []:
        if option['code'] == code:
            return text_in(option.get('label'), primary, primary) or code
    return code


def _summary(question: Mapping[str, Any], answer: object, primary: str) -> str:
    """A structured answer as words, for a response with no free text (contact details never appear)."""
    kind = question['type']
    if kind in SELECT_TYPES and isinstance(answer, Mapping):
        labels = [_label(question, code, primary) for code in answer.get('codes') or [answer.get('code')] if code]
        return ', '.join(labels)
    if kind in SCALE_TYPES:
        return f'{answer}/{(question_bounds(question) or (0, 0))[1]}'
    return '✓'


def matrix_label(question: Mapping[str, Any], key: str, code: str, primary: str) -> str:
    """A matrix row's or column's label in the primary language (its code when it has none, or no longer exists)."""
    for entry in question.get(key) or []:
        if isinstance(entry, Mapping) and entry.get('code') == code:
            return text_in(entry.get('label'), primary, primary) or code
    return code


def headline_of(question: Mapping[str, Any], primary: str) -> str:
    """A question's headline in the primary language as a reader of its answers sees it (placeholders as ``[id]``)."""
    return shown_as_ids(text_in(question.get('headline'), primary, primary))


def _summary_lines(question: Mapping[str, Any], answer: object, primary: str) -> list[str]:
    """``headline: answer``, or for a matrix one ``headline — row: column`` line per answered row."""
    headline = headline_of(question, primary)
    if question['type'] == MATRIX and isinstance(answer, Mapping):
        return [f'{headline} — {matrix_label(question, "rows", str(row), primary)}: '
                f'{matrix_label(question, "columns", str(column), primary)}'
                for row, column in (answer.get('rows') or {}).items()]
    return [f'{headline}: {_summary(question, answer, primary)}']


def response_text(definition: Mapping[str, Any], response: Response) -> str:
    """The item's text: each free-text answer under its headline in the primary language, in path order; a
    response without free text gets its structured answers as ``headline: answer`` lines instead (a matrix one
    ``headline — row: column`` line per row). A headline's placeholders read ``[id]``, never a respondent's value."""
    primary = str(definition.get('language'))
    questions = {question['id']: question for question in definition.get('questions') or []}
    answered = [(questions[qid], response.answers[qid]) for qid in response.path if qid in response.answers]
    blocks = [f'{headline_of(q, primary)}\n{text}' for q, a in answered if (text := _free_text(q, a))]
    if blocks:
        return '\n\n'.join(blocks)
    return '\n'.join(line for q, a in answered for line in _summary_lines(q, a, primary))


def answer_category(definition: Mapping[str, Any], response: Response) -> dict[str, str] | None:
    """The category of the first answered option (in path order, then the options' order) that maps one."""
    questions = {question['id']: question for question in definition.get('questions') or []}
    for qid in response.path:
        question, answer = questions[qid], response.answers.get(qid)
        if question['type'] not in SELECT_TYPES or not isinstance(answer, Mapping):
            continue
        chosen = _chosen(answer)
        for option in question.get('options') or []:
            if option['code'] in chosen and isinstance(option.get('category'), Mapping):
                return dict(option['category'])
    return None


def item_rating(definition: Mapping[str, Any], response: Response) -> int | None:
    """The item's ``rating`` (what the dashboards and form cards average): the first answered rating question, else
    the first CSAT. NPS and CES are not ratings and stay in ``form_answers``."""
    questions = {question['id']: question for question in definition.get('questions') or []}
    for kind in (RATING, CSAT):
        for qid in response.path:
            if questions[qid]['type'] == kind and isinstance(response.answers.get(qid), int):
                return int(response.answers[qid])
    return None


def contact_of(definition: Mapping[str, Any], response: Response) -> dict[str, str]:
    """The first contact_info answer (``{name?, email?, phone?, company?}``), {} when none."""
    questions = {question['id']: question for question in definition.get('questions') or []}
    for qid in response.path:
        if questions[qid]['type'] == CONTACT and isinstance(response.answers.get(qid), Mapping):
            return dict(response.answers[qid])
    return {}
