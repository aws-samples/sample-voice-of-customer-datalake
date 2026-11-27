"""Feedback Forms, schema version 2 (docs/feedback-forms.md, "Schema v2"): a form's questions, logic, hidden fields
and endings, and the read-time migration of a version 1 form.

One definition shared by the form API's saves (``validate_definition``, ``validate_test_settings``), its public
config (``public_definition``), the public submit and the ingest (shared/forms_v2_responses.py) and the results
(shared/forms_v2_results.py). Pure: no AWS client, no I/O, no clock, so every rule here is unit-tested on its own.

A form's DEFINITION is the six fields a response is validated against (``DEFINITION_FIELDS``); everything else on a
form (its name, theme, routing, links, labels, test settings) can change without a new revision. A version 1 form
(no ``schema_version``) is migrated on every read (``definition_of``), losslessly, and written back as version 2 on
its next save (lambda/api/feedback_form_handler.py ``update_form``).
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Final
from urllib.parse import urlsplit

from shared import form_theme, forms_recall
from shared.dynamo_values import plain  # fv2.plain: DynamoDB's Decimals back into ints and floats, at any depth

# _v1_text(item, field): a version 1 text as the version 1 widget rendered it, trimmed; '' when absent or not a string.
from shared.dynamo_values import trimmed_text as _v1_text
from shared.exceptions import ConflictError, ValidationError

__all__ = [
    'DEFINITION_FIELDS',
    'FORM_LOCALES',
    'MATRIX',
    'SCHEMA_VERSION',
    'answer_shape',
    'definition_of',
    'imported_of',
    'is_v2',
    'language_assumed',
    'migrate_v1',
    'plain',
    'public_definition',
    'question_bounds',
    'reshaped_questions',
    'revision_of',
    'template_of',
    'test_settings_of',
    'validate_definition',
    'validate_imported',
    'validate_placeholders',
    'validate_publishable',
    'validate_template',
    'validate_test_settings',
]

SCHEMA_VERSION: Final = 2
#: The app's nine locales (frontend/public/locales; lockstepped by shared/test/test_forms_v2.py).
FORM_LOCALES: Final = ('en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko', 'pl')
DEFAULT_LOCALE: Final = 'en'
#: What a response is validated against: a change to any of them is a new revision.
DEFINITION_FIELDS: Final = ('language', 'languages', 'welcome', 'questions', 'hidden_fields', 'endings')
#: A version 1 form's own fields (``text_question`` and ``language`` since 7.54.00), removed when it is written back.
V1_FIELDS: Final = ('title', 'description', 'question', 'placeholder', 'rating_enabled', 'rating_type', 'rating_max',
                    'submit_button_text', 'success_message', 'collect_email', 'collect_name', 'text_question')

MIN_QUESTIONS: Final = 1
MAX_QUESTIONS: Final = 30
MAX_OPTIONS: Final = 50
MAX_RULES: Final = 20
MAX_HIDDEN_FIELDS: Final = 20
MAX_HIDDEN_VALUE_CHARS: Final = 200
MAX_HIDDEN_LABEL_CHARS: Final = 64
MAX_ENDINGS: Final = 5
MAX_MATRIX_ROWS: Final = 20
MIN_MATRIX_COLUMNS: Final = 2
MAX_MATRIX_COLUMNS: Final = 10
#: A matrix column's optional score is a whole number from -100 to 100 (the rows' averages in Results).
MATRIX_SCORE_LIMIT: Final = 100
MAX_OPEN_TEXT_CHARS: Final = 5000
MAX_OTHER_CHARS: Final = 1000
MAX_URL_CHARS: Final = 2048
MAX_CATEGORY_CHARS: Final = 128
#: The stored definition stays well inside DynamoDB's 400 KB item (the form row, and each revision's snapshot).
MAX_DEFINITION_BYTES: Final = 300_000
#: Removed question ids a form remembers so none is reused (the oldest are forgotten past this many).
MAX_RETIRED_IDS: Final = 1000

HEADLINE_CHARS: Final = 500
LONG_TEXT_CHARS: Final = 2000
LABEL_CHARS: Final = 200
BUTTON_CHARS: Final = 80
RULE_TEXT_CHARS: Final = 200

QUESTION_ID: Final = re.compile(r'q_[a-z0-9_]{1,40}')
OPTION_CODE: Final = re.compile(r'[a-z0-9_]{1,40}')
HIDDEN_ID: Final = re.compile(r'[a-z][a-z0-9_]{0,39}')
#: A hidden field's name as a query parameter, a ``group_by`` and a stored view's filter: ``hidden.<id>``.
HIDDEN_PREFIX: Final = 'hidden.'
ENDING_ID: Final = re.compile(r'end_[a-z0-9_]{1,40}')
#: A template's id (7.63.00: the app's templates, ``workshop``, ``nps``…) and the highest version a form may name.
TEMPLATE_ID: Final = re.compile(r'[a-z][a-z0-9_]{0,39}')
MAX_TEMPLATE_VERSION: Final = 1000
#: An imported form's provenance (7.67.00, the import wizard): the tool its export came from, when, and the file.
MAX_IMPORTED_FROM_CHARS: Final = 80
MAX_IMPORTED_FILENAME_CHARS: Final = 255
_IMPORTED_AT: Final = re.compile(r'\d{4}-\d{2}-\d{2}(T[0-9:.]{2,15}(Z|[+-]\d{2}:\d{2})?)?')
#: Names no hidden field may take: in the widget's script objects they are the object's own machinery (its
#: prototype), so the widget never fills them. A form stored before 7.58.00 with one reads as it is; only a save of
#: its definition refuses it.
RESERVED_HIDDEN_IDS: Final = frozenset({'__proto__', 'constructor', 'prototype'})
#: Nor may a matrix's row or column code (7.61.00): its answer is an object keyed by row code.
RESERVED_MATRIX_CODES: Final = RESERVED_HIDDEN_IDS

#: Reserved choice codes: the "Other" answer and the exclusive "None of these" (multi only), each reserved only
#: while the question enables it. A rule names them like any option code.
OTHER_CODE: Final = 'other'
NONE_CODE: Final = 'none'

OPEN_TEXT: Final = 'open_text'
SINGLE: Final = 'single_select'
MULTI: Final = 'multi_select'
RATING: Final = 'rating'
NPS: Final = 'nps'
CSAT: Final = 'csat'
CES: Final = 'ces'
STATEMENT: Final = 'statement'
CONSENT: Final = 'consent'
CONTACT: Final = 'contact_info'
#: Several rows rated on one scale, one choice per row (7.61.00): ``{rows: {<row code>: <column code>}}``.
MATRIX: Final = 'matrix'
QUESTION_TYPES: Final = (OPEN_TEXT, SINGLE, MULTI, RATING, NPS, CSAT, CES, STATEMENT, CONSENT, CONTACT, MATRIX)
SELECT_TYPES: Final = frozenset({SINGLE, MULTI})
SCALE_TYPES: Final = frozenset({RATING, NPS, CSAT, CES})
INPUT_TYPES: Final = ('text', 'email', 'number', 'phone', 'url')
SHUFFLES: Final = ('none', 'all', 'except_last')
DISPLAYS: Final = ('auto', 'list', 'dropdown', 'chips')
MATRIX_DISPLAYS: Final = ('auto', 'grid', 'stacked')
RATING_SCALES: Final = ('star', 'number', 'smiley')
RATING_RANGES: Final = (3, 4, 5, 7, 10)
#: The fixed scales of the presets: NPS 0-10, CSAT a 1-5 smiley, CES 1-7.
PRESET_BOUNDS: Final = {NPS: (0, 10), CSAT: (1, 5), CES: (1, 7)}
CONTACT_FIELDS: Final = ('name', 'email', 'phone', 'company')
TEST_RECORDS: Final = ('tag', 'drop')

_ANSWER_OPS: Final = frozenset({'submitted', 'skipped'})
_COMPARE_OPS: Final = frozenset({'lt', 'lte', 'gt', 'gte'})
#: The logic operators each type admits (a rule with any other is refused).
OPS_BY_TYPE: Final[Mapping[str, frozenset[str]]] = {
    OPEN_TEXT: _ANSWER_OPS | {'equals', 'not_equals'},
    SINGLE: _ANSWER_OPS | {'equals', 'not_equals', 'includes_any'},
    MULTI: _ANSWER_OPS | {'includes_any', 'includes_all'},
    **{kind: _ANSWER_OPS | _COMPARE_OPS | {'equals', 'not_equals'} for kind in (RATING, NPS, CSAT, CES)},
    CONSENT: _ANSWER_OPS,
    CONTACT: _ANSWER_OPS,
    MATRIX: _ANSWER_OPS,
    # A statement has no answer: it is always "submitted" once shown, so its rule is an unconditional jump.
    STATEMENT: frozenset({'submitted'}),
}

_COMMON_KEYS: Final = frozenset({'id', 'type', 'headline', 'subheader', 'required', 'button_label', 'logic'})
_LABEL_KEYS: Final = frozenset({'lower_label', 'upper_label'})
_TYPE_KEYS: Final[Mapping[str, frozenset[str]]] = {
    OPEN_TEXT: frozenset({'long', 'input_type', 'placeholder', 'max_chars'}),
    SINGLE: frozenset({'options', 'other', 'shuffle', 'display'}),
    MULTI: frozenset({'options', 'other', 'none', 'shuffle', 'display', 'min', 'max'}),
    RATING: frozenset({'scale', 'range'}) | _LABEL_KEYS,
    NPS: _LABEL_KEYS,
    CSAT: _LABEL_KEYS,
    CES: _LABEL_KEYS,
    STATEMENT: frozenset({'cta'}),
    CONSENT: frozenset({'label'}),
    CONTACT: frozenset({'fields'}),
    MATRIX: frozenset({'rows', 'columns', 'shuffle_rows', 'display', 'min_rows'}),
}

# The localized default copy the migration writes where a version 1 form had none (template copy is the editor's).
TELL_US_MORE: Final = {
    'en': 'Tell us more', 'es': 'Cuéntenos más', 'fr': 'Dites-nous en plus', 'de': 'Erzählen Sie uns mehr',
    'pt': 'Conte-nos mais', 'ja': '詳しく教えてください', 'zh': '请告诉我们更多', 'ko': '자세히 알려주세요',
    'pl': 'Powiedz nam więcej',
}
CONTACT_HEADLINE: Final = {
    'en': 'How can we reach you?', 'es': '¿Cómo podemos contactarle?', 'fr': 'Comment pouvons-nous vous joindre ?',
    'de': 'Wie können wir Sie erreichen?', 'pt': 'Como podemos entrar em contato com você?',
    'ja': 'ご連絡先を教えてください', 'zh': '我们如何联系您\uff1f', 'ko': '연락처를 알려주세요',
    'pl': 'Jak możemy się z Tobą skontaktować?',
}
RATE_US: Final = {
    'en': 'How was your experience?', 'es': '¿Cómo fue su experiencia?',
    'fr': "Comment s'est passée votre expérience ?", 'de': 'Wie war Ihre Erfahrung?',
    'pt': 'Como foi sua experiência?', 'ja': 'ご利用の感想はいかがでしたか\uff1f', 'zh': '您的体验如何\uff1f',
    'ko': '경험은 어떠셨나요?', 'pl': 'Jak oceniasz swoje doświadczenie?',
}
THANK_YOU: Final = {
    'en': 'Thank you!', 'es': '¡Gracias!', 'fr': 'Merci !', 'de': 'Vielen Dank!', 'pt': 'Obrigado!',
    'ja': 'ありがとうございました\uff01', 'zh': '谢谢\uff01', 'ko': '감사합니다!', 'pl': 'Dziękujemy!',
}
#: The ids the migration gives a version 1 form's steps.
V1_RATING_ID: Final = 'q_rating'
V1_TEXT_ID: Final = 'q_text'
V1_CONTACT_ID: Final = 'q_contact'
V1_ENDING_ID: Final = 'end_thanks'
_V1_SCALES: Final = {'stars': 'star', 'emoji': 'smiley', 'numeric': 'number'}

#: A version 1 form's defaults (the pre-7.55 DEFAULT_FORM_CONFIG), which a v1 create body and the migration fill in.
V1_DEFAULTS: Final[Mapping[str, Any]] = {
    'title': 'Share Your Feedback',
    'description': 'We value your opinion.',
    'question': 'How was your experience?',
    'placeholder': 'Tell us about your experience...',
    'rating_enabled': True,
    'rating_type': 'stars',
    'rating_max': 5,
    'submit_button_text': 'Submit Feedback',
    'success_message': 'Thank you for your feedback!',
    'collect_email': False,
    'collect_name': False,
}


# ── Reading stored values ────────────────────────────────────────────────────────────────────────────────────────


def is_v2(item: Mapping[str, Any]) -> bool:
    """True for a form stored as schema version 2."""
    return plain(item.get('schema_version')) == SCHEMA_VERSION


#: A form revision's snapshot row, ``FORMREV#{form_id}#{n:06d}`` beside the form's own row in its forms partition.
REVISION_PREFIX: Final = 'FORMREV#'
#: The one 409 of a form save that lost the race with another (the revision or the save counter it read moved).
CHANGED_MEANWHILE: Final = 'The form was changed by someone else: reload it, then save again'


def write_count(item: Mapping[str, Any]) -> int:
    """The form row's save counter (0 for a row written before 7.58.00, which has none)."""
    value = plain(item.get('write_count'))
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def canonical(definition: Mapping[str, Any]) -> str:
    """A definition as one comparable text: its keys sorted, DynamoDB's numbers as JSON's."""
    return json.dumps(plain(dict(definition)), sort_keys=True, ensure_ascii=False, default=str)


def revision_of(item: Mapping[str, Any]) -> int:
    """The form's current revision: its stored one, 1 for a version 1 form (served migrated as its first)."""
    revision = plain(item.get('revision'))
    return revision if isinstance(revision, int) and not isinstance(revision, bool) and revision >= 1 else 1


def definition_of(item: Mapping[str, Any], default_locale: str = DEFAULT_LOCALE) -> dict[str, Any]:
    """The form's definition as version 2: its stored one, or a version 1 form migrated (never validated here: a
    read serves what is stored). ``default_locale``: the primary language of a version 1 form that names none."""
    if is_v2(item):
        return {field: plain(item.get(field)) for field in DEFINITION_FIELDS}
    return migrate_v1(item, default_locale)


def validate_template(value: object) -> dict[str, Any]:
    """A create's ``template`` (7.63.00): ``{id, version}``, the app template the form was made from, so Compare can
    match the forms made from one template (their question ids are the template's). A 400 naming the field otherwise."""
    source = _object(value, 'template')
    _closed(source, {'id', 'version'}, 'template')
    template_id = source.get('id')
    if not isinstance(template_id, str) or not TEMPLATE_ID.fullmatch(template_id):
        raise _fail('template.id must be a template id (lower-case letters, digits and _, at most 40)')
    return {'id': template_id, 'version': _int(source.get('version', 1), 'template.version', 1, MAX_TEMPLATE_VERSION)}


def _imported_text(source: Mapping[str, Any], key: str, limit: int, *, required: bool) -> str:
    value = source.get(key, '')
    if not isinstance(value, str) or len(value.strip()) > limit or any(ord(ch) < 32 for ch in value):
        raise _fail(f'imported.{key} must be a text of at most {limit} characters')
    if required and not value.strip():
        raise _fail(f'imported.{key} is required')
    return value.strip()


def validate_imported(value: object) -> dict[str, str]:
    """A create's ``imported`` (7.67.00): ``{from, at, filename}``, the survey export the form was made from (the
    import wizard, docs/import-wizard.md). Such a form is Off for good and has no public link: its responses are the
    export's rows. ``from``: the tool, ``at``: when it was imported (an ISO 8601 date or time), ``filename``: the
    file's name without any folder. A 400 naming the field otherwise."""
    source = _object(value, 'imported')
    _closed(source, {'from', 'at', 'filename'}, 'imported')
    at = source.get('at')
    if not isinstance(at, str) or not _IMPORTED_AT.fullmatch(at):
        raise _fail('imported.at must be an ISO 8601 date or time')
    filename = _imported_text(source, 'filename', MAX_IMPORTED_FILENAME_CHARS, required=True)
    return {'from': _imported_text(source, 'from', MAX_IMPORTED_FROM_CHARS, required=False) or 'file', 'at': at,
            'filename': re.split(r'[/\\]', filename)[-1] or filename}


def imported_of(item: Mapping[str, Any]) -> dict[str, str] | None:
    """The provenance of an imported form (``{from, at, filename}``), None for every other form."""
    stored = plain(item.get('imported'))
    if not isinstance(stored, Mapping) or not isinstance(stored.get('filename'), str):
        return None
    return {key: str(stored.get(key) or '') for key in ('from', 'at', 'filename')}


def template_of(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """The template a stored form was made from (``{id, version}``), None for a form that names none (every form saved
    before 7.63.00, and a form made blank or by the AI)."""
    stored = plain(item.get('template'))
    if not isinstance(stored, Mapping) or not isinstance(stored.get('id'), str):
        return None
    version = stored.get('version')
    return {'id': stored['id'], 'version': version if isinstance(version, int) and not isinstance(version, bool) else 1}


def language_assumed(item: Mapping[str, Any]) -> bool:
    """A version 1 form whose language is empty or not one of the nine (7.54.00 let the browser pick): its migration
    assumed the deployment's language, for the author to confirm on the next save."""
    return not is_v2(item) and item.get('language') not in FORM_LOCALES


def test_settings_of(item: Mapping[str, Any]) -> dict[str, Any]:
    """``settings.test`` as stored, defaults filled: ``{link_enabled, record}`` plus the token fields when issued."""
    raw_settings = item.get('settings')
    settings: Mapping[str, Any] = plain(raw_settings) if isinstance(raw_settings, Mapping) else {}
    raw_test = settings.get('test')
    test: Mapping[str, Any] = raw_test if isinstance(raw_test, Mapping) else {}
    out: dict[str, Any] = {
        'link_enabled': test.get('link_enabled') is True,
        'record': test.get('record') if test.get('record') in TEST_RECORDS else 'tag',
    }
    for key in ('token', 'token_issued_at', 'token_issued_by'):
        if isinstance(test.get(key), str) and test[key]:
            out[key] = test[key]
    return out


# ── Version 1 → 2 (read-time, lossless) ──────────────────────────────────────────────────────────────────────────

def _v1_language(item: Mapping[str, Any], default_locale: str) -> str:
    language = item.get('language')
    if language in FORM_LOCALES:
        return str(language)
    return default_locale if default_locale in FORM_LOCALES else DEFAULT_LOCALE


def _i18n(locale: str, text: str) -> dict[str, str]:
    return {locale: text} if text else {}


def _v1_rating_range(item: Mapping[str, Any]) -> int:
    """The version 1 rating's scale as a version 2 range: numeric rendered 1..10, emoji 1..5, stars 1..rating_max
    (an odd maximum moves up to the next range the schema has; the original stays in the revision 1 snapshot)."""
    kind = item.get('rating_type', V1_DEFAULTS['rating_type'])
    if kind == 'numeric':
        return 10
    if kind == 'emoji':
        return 5
    return next((size for size in RATING_RANGES if size >= _v1_rating_max(item)), RATING_RANGES[-1])


def _v1_rating_max(item: Mapping[str, Any]) -> int:
    """The stored ``rating_max`` as the version 1 widget read it: a number (or numeric text) clamped to 1..10, else 5
    (a version 1 PUT stored whatever JSON it was sent)."""
    raw = item.get('rating_max', V1_DEFAULTS['rating_max'])
    if isinstance(raw, bool):
        return 5
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, ValueError):
        return 5
    return min(max(int(value), 1), 10) if value.is_finite() else 5


def _v1_questions(item: Mapping[str, Any], locale: str) -> list[dict[str, Any]]:
    rating_on = plain(item.get('rating_enabled', True)) is not False
    question = _v1_text(item, 'question')
    questions: list[dict[str, Any]] = []
    if rating_on:
        questions.append({
            'id': V1_RATING_ID, 'type': RATING, 'headline': _i18n(locale, question or RATE_US[locale]),
            'required': True, 'scale': _V1_SCALES.get(str(item.get('rating_type')), 'star'),
            'range': _v1_rating_range(item)})
    headline = (_v1_text(item, 'text_question') if rating_on else question) or TELL_US_MORE[locale]
    text: dict[str, Any] = {'id': V1_TEXT_ID, 'type': OPEN_TEXT, 'headline': _i18n(locale, headline),
                            'required': True, 'long': True, 'input_type': 'text'}
    if placeholder := _v1_text(item, 'placeholder'):
        text['placeholder'] = _i18n(locale, placeholder)
    questions.append(text)
    name, email = item.get('collect_name') is True, item.get('collect_email') is True
    if name or email:
        questions.append({
            'id': V1_CONTACT_ID, 'type': CONTACT, 'headline': _i18n(locale, CONTACT_HEADLINE[locale]),
            'required': True,
            'fields': {'name': {'show': name, 'required': name}, 'email': {'show': email, 'required': email},
                       'phone': {'show': False, 'required': False},
                       'company': {'show': False, 'required': False}}})
    return questions


def migrate_v1(item: Mapping[str, Any], default_locale: str = DEFAULT_LOCALE) -> dict[str, Any]:
    """A version 1 form's definition as version 2 (docs/feedback-forms.md, "Migration from version 1").

    ``rating_enabled`` becomes a rating question headed by ``question``; the text step an ``open_text`` with
    ``long: true`` headed, as 7.54.00 renders it, by ``text_question`` when the rating is on and by ``question`` when it
    is off (``text_question`` is then ignored), else the localized "Tell us more", keeping its placeholder;
    ``collect_name`` / ``collect_email`` a ``contact_info``; ``success_message`` the first ending; ``title`` /
    ``description`` the welcome screen. ``submit_button_text`` is not carried over (the version 1 widget never showed
    it, and its untouched English default would land on a form in another language); it stays in the revision 1
    snapshot with every other version 1 field.
    A form with no (or an unknown) ``language`` takes ``default_locale``, the deployment's (``language_assumed``).
    """
    locale = _v1_language(item, default_locale)
    welcome: dict[str, Any] = {'enabled': False}
    if title := _v1_text(item, 'title'):
        welcome = {'enabled': True, 'title': _i18n(locale, title)}
    if description := _v1_text(item, 'description'):
        welcome['description'] = _i18n(locale, description)
    ending = {'id': V1_ENDING_ID, 'title': _i18n(locale, _v1_text(item, 'success_message') or THANK_YOU[locale])}
    return {'language': locale, 'languages': [locale], 'welcome': welcome, 'questions': _v1_questions(item, locale),
            'hidden_fields': [], 'endings': [ending]}


def v1_source(item: Mapping[str, Any]) -> dict[str, Any]:
    """The version 1 fields a form carried (and its ``language``), as stored: kept in its revision 1 snapshot."""
    return {field: plain(item[field]) for field in (*V1_FIELDS, 'language') if field in item}


# ── Validation (every save) ──────────────────────────────────────────────────────────────────────────────────────

def _fail(message: str) -> ValidationError:
    return ValidationError(message)


def _object(value: object, where: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _fail(f'{where} must be an object')
    return value


def _closed(value: Mapping[str, Any], allowed: frozenset[str] | set[str], where: str) -> None:
    unknown = sorted(str(key)[:40] for key in value if key not in allowed)
    if unknown:
        raise _fail(f'{where} has unknown fields: {", ".join(unknown[:5])}')


def _bool(value: Mapping[str, Any], key: str, where: str, default: bool = False) -> bool:
    raw = value.get(key, default)
    if raw is None:
        return default
    if not isinstance(raw, bool):
        raise _fail(f'{where}.{key} must be true or false')
    return raw


def _choice(value: Mapping[str, Any], key: str, where: str, allowed: Sequence[Any], default: Any = None) -> Any:
    raw = value.get(key, default)
    if raw is None and default is not None:
        return default
    if isinstance(raw, bool) or raw not in allowed:
        raise _fail(f'{where}.{key} must be one of: {", ".join(str(a) for a in allowed)}')
    return raw


def _int(value: object, where: str, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise _fail(f'{where} must be a whole number from {low} to {high}')
    return value


def https_url(value: object, where: str) -> str:
    """An absolute ``https://`` URL with a host and no credentials, controls or spaces, at most 2048 characters."""
    if not isinstance(value, str) or not value or len(value) > MAX_URL_CHARS:
        raise _fail(f'{where} must be an https:// URL of at most {MAX_URL_CHARS} characters')
    if any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise _fail(f'{where} must not contain spaces or control characters')
    try:
        parts = urlsplit(value)
        host = parts.hostname
    except ValueError:
        raise _fail(f'{where} must be an https:// URL') from None
    if parts.scheme != 'https' or not host or parts.username is not None or parts.password is not None:
        raise _fail(f'{where} must be an https:// URL with a host (and no user name or password)')
    return value


@dataclass(frozen=True)
class _Locales:
    """The form's languages, for its I18nText fields."""

    primary: str
    languages: tuple[str, ...]

    def text(self, value: object, where: str, limit: int, *, required: bool = False) -> dict[str, str] | None:
        """An I18nText ``{locale: text}``: locales of the form only, the primary's text required (when ``required``,
        or once any translation is given); blank translations are dropped (they fall back to the primary)."""
        if value is None:
            if required:
                raise _fail(f'{where} is required')
            return None
        source = _object(value, where)
        out: dict[str, str] = {}
        for locale, text in source.items():
            if locale not in self.languages:
                raise _fail(f"{where}.{str(locale)[:10]} is not one of the form's languages")
            if not isinstance(text, str):
                raise _fail(f'{where}.{locale} must be a string')
            if len(text) > limit:
                raise _fail(f'{where}.{locale} must be at most {limit} characters')
            if text.strip():
                out[locale] = text.strip()
        if self.primary not in out:
            if required or out:
                raise _fail(f'{where}.{self.primary} (the primary language) is required')
            return None
        return out

    def put(self, out: dict[str, Any], source: Mapping[str, Any], key: str, where: str, limit: int) -> None:
        """Copy an optional I18nText ``key`` from ``source`` into ``out`` when it holds text."""
        text = self.text(source.get(key), f'{where}.{key}', limit)
        if text is not None:
            out[key] = text


def _locales(definition: Mapping[str, Any]) -> _Locales:
    primary = definition.get('language')
    if primary not in FORM_LOCALES:
        raise _fail(f'language must be one of: {", ".join(FORM_LOCALES)}')
    raw = definition.get('languages', [primary])
    if not isinstance(raw, list) or not raw or len(raw) > len(FORM_LOCALES):
        raise _fail('languages must be a list of the form\'s locales')
    if any(locale not in FORM_LOCALES for locale in raw) or len(set(raw)) != len(raw):
        raise _fail(f'languages must name each of {", ".join(FORM_LOCALES)} at most once')
    if primary not in raw:
        raise _fail('languages must include the primary language')
    return _Locales(primary, tuple(raw))


def _welcome(value: object, loc: _Locales) -> dict[str, Any]:
    source = _object(value if value is not None else {'enabled': False}, 'welcome')
    _closed(source, {'enabled', 'title', 'description', 'button_label'}, 'welcome')
    enabled = _bool(source, 'enabled', 'welcome')
    out: dict[str, Any] = {'enabled': enabled}
    title = loc.text(source.get('title'), 'welcome.title', HEADLINE_CHARS, required=enabled)
    if title is not None:
        out['title'] = title
    loc.put(out, source, 'description', 'welcome', LONG_TEXT_CHARS)
    loc.put(out, source, 'button_label', 'welcome', BUTTON_CHARS)
    return out


def _category(value: object, where: str) -> dict[str, str] | None:
    if value is None:
        return None
    source = _object(value, where)
    _closed(source, {'category', 'subcategory'}, where)
    category, subcategory = source.get('category'), source.get('subcategory', '')
    if not isinstance(category, str) or not category.strip() or len(category) > MAX_CATEGORY_CHARS:
        raise _fail(f'{where}.category must be a category name of at most {MAX_CATEGORY_CHARS} characters')
    if not isinstance(subcategory, str) or len(subcategory) > MAX_CATEGORY_CHARS:
        raise _fail(f'{where}.subcategory must be a string of at most {MAX_CATEGORY_CHARS} characters')
    out = {'category': category.strip()}
    if subcategory.strip():
        out['subcategory'] = subcategory.strip()
    return out


def _coded(entry: object, at: str, allowed: set[str], seen: set[str], loc: _Locales,
           reserved: frozenset[str] = frozenset()) -> tuple[Mapping[str, Any], dict[str, Any]]:
    """An option's (or a matrix row's or column's) ``{code, label}``: the code unique in ``seen`` and not ``reserved``,
    the label required. ``(the entry as sent, {code, label})``."""
    item = _object(entry, at)
    _closed(item, allowed, at)
    code = item.get('code')
    if isinstance(code, str) and code in reserved:
        raise _fail(f'{at}.code "{code}" is a reserved name; choose another')
    if not isinstance(code, str) or not OPTION_CODE.fullmatch(code):
        raise _fail(f'{at}.code must match [a-z0-9_]{{1,40}}')
    if code in seen:
        raise _fail(f'{at}.code "{code}" is used twice')
    seen.add(code)
    return item, {'code': code, 'label': loc.text(item.get('label'), f'{at}.label', LABEL_CHARS, required=True)}


def _options(source: Mapping[str, Any], where: str, loc: _Locales) -> list[dict[str, Any]]:
    raw = source.get('options')
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_OPTIONS:
        raise _fail(f'{where}.options must be a list of 1 to {MAX_OPTIONS} options')
    options: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        at = f'{where}.options[{index}]'
        option, out = _coded(entry, at, {'code', 'label', 'category'}, seen, loc)
        if (category := _category(option.get('category'), f'{at}.category')) is not None:
            out['category'] = category
        options.append(out)
    return options


def _toggle(source: Mapping[str, Any], key: str, where: str, loc: _Locales, texts: Sequence[str]) -> dict[str, Any]:
    """``other`` / ``none``: ``{enabled, label?, placeholder?}``, disabled when absent."""
    value = _object(source.get(key) if source.get(key) is not None else {'enabled': False}, f'{where}.{key}')
    _closed(value, {'enabled', *texts}, f'{where}.{key}')
    out: dict[str, Any] = {'enabled': _bool(value, 'enabled', f'{where}.{key}')}
    for text in texts:
        loc.put(out, value, text, f'{where}.{key}', LABEL_CHARS)
    return out


def _select(source: Mapping[str, Any], where: str, loc: _Locales, *, multi: bool) -> dict[str, Any]:
    options = _options(source, where, loc)
    out: dict[str, Any] = {
        'options': options,
        'other': _toggle(source, 'other', where, loc, ('label', 'placeholder')),
        'shuffle': _choice(source, 'shuffle', where, SHUFFLES, 'none'),
        'display': _choice(source, 'display', where, DISPLAYS, 'auto'),
    }
    codes = {option['code'] for option in options}
    reserved = [(OTHER_CODE, out['other']['enabled'])]
    if multi:
        out['none'] = _toggle(source, 'none', where, loc, ('label',))
        reserved.append((NONE_CODE, out['none']['enabled']))
        out.update(_selection_bounds(source, where, len(options) + int(out['other']['enabled'])))
    for code, enabled in reserved:
        if enabled and code in codes:
            raise _fail(f'{where}: the option code "{code}" is reserved while "{code}" is enabled')
    return out


def _selection_bounds(source: Mapping[str, Any], where: str, choices: int) -> dict[str, int]:
    out: dict[str, int] = {}
    for key in ('min', 'max'):
        if source.get(key) is not None:
            out[key] = _int(source[key], f'{where}.{key}', 1, choices)
    if out.get('min', 1) > out.get('max', choices):
        raise _fail(f'{where}.min must not be greater than {where}.max')
    return out


def _open_text(source: Mapping[str, Any], where: str, loc: _Locales) -> dict[str, Any]:
    long = _bool(source, 'long', where)
    input_type = _choice(source, 'input_type', where, INPUT_TYPES, 'text')
    # A long text is a text box whose answer is any text (the widget draws it so): never an email, number, phone or
    # web address, whatever input_type a client or an older save sent with it.
    out: dict[str, Any] = {'long': long, 'input_type': 'text' if long else input_type}
    loc.put(out, source, 'placeholder', where, LABEL_CHARS)
    if source.get('max_chars') is not None:
        out['max_chars'] = _int(source['max_chars'], f'{where}.max_chars', 1, MAX_OPEN_TEXT_CHARS)
    return out


def _scale_labels(source: Mapping[str, Any], where: str, loc: _Locales) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in sorted(_LABEL_KEYS):
        loc.put(out, source, key, where, LABEL_CHARS)
    return out


def _rating(source: Mapping[str, Any], where: str, loc: _Locales) -> dict[str, Any]:
    return {'scale': _choice(source, 'scale', where, RATING_SCALES, 'star'),
            'range': _choice(source, 'range', where, RATING_RANGES, 5), **_scale_labels(source, where, loc)}


def _statement(source: Mapping[str, Any], where: str, loc: _Locales) -> dict[str, Any]:
    if source.get('cta') is None:
        return {}
    cta = _object(source['cta'], f'{where}.cta')
    _closed(cta, {'label', 'url'}, f'{where}.cta')
    out: dict[str, Any] = {'label': loc.text(cta.get('label'), f'{where}.cta.label', BUTTON_CHARS, required=True)}
    if cta.get('url') is not None:
        out['url'] = https_url(cta['url'], f'{where}.cta.url')
    return {'cta': out}


def _consent(source: Mapping[str, Any], where: str, loc: _Locales) -> dict[str, Any]:
    return {'label': loc.text(source.get('label'), f'{where}.label', LONG_TEXT_CHARS, required=True)}


def _contact(source: Mapping[str, Any], where: str, _loc: _Locales) -> dict[str, Any]:
    fields = _object(source.get('fields'), f'{where}.fields')
    _closed(fields, set(CONTACT_FIELDS), f'{where}.fields')
    out: dict[str, dict[str, bool]] = {}
    for name in CONTACT_FIELDS:
        at = f'{where}.fields.{name}'
        entry = _object(fields.get(name, {'show': False, 'required': False}), at)
        _closed(entry, {'show', 'required'}, at)
        show, required = _bool(entry, 'show', at), _bool(entry, 'required', at)
        if required and not show:
            raise _fail(f'{at}: a required field must be shown')
        out[name] = {'show': show, 'required': required}
    if not any(entry['show'] for entry in out.values()):
        raise _fail(f'{where}.fields must show at least one field')
    return {'fields': out}


def _matrix_entries(source: Mapping[str, Any], key: str, where: str, loc: _Locales, bounds: tuple[int, int]
                    ) -> list[dict[str, Any]]:
    """A matrix's ``rows`` or ``columns``: ``bounds`` entries of ``{code, label}`` (a column also ``score?``), codes
    unique and never a reserved name."""
    raw = source.get(key)
    low, high = bounds
    if not isinstance(raw, list) or not low <= len(raw) <= high:
        raise _fail(f'{where}.{key} must be a list of {low} to {high} entries')
    allowed = {'code', 'label', 'score'} if key == 'columns' else {'code', 'label'}
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        at = f'{where}.{key}[{index}]'
        item, out = _coded(entry, at, allowed, seen, loc, RESERVED_MATRIX_CODES)
        if item.get('score') is not None:
            out['score'] = _int(item['score'], f'{at}.score', -MATRIX_SCORE_LIMIT, MATRIX_SCORE_LIMIT)
        entries.append(out)
    return entries


def _matrix(source: Mapping[str, Any], where: str, loc: _Locales) -> dict[str, Any]:
    """A matrix (7.61.00): 1-20 rows, 2-10 columns, ``shuffle_rows``, ``display``, and ``min_rows`` on an optional
    one only (a required matrix asks for every row)."""
    rows = _matrix_entries(source, 'rows', where, loc, (1, MAX_MATRIX_ROWS))
    out: dict[str, Any] = {
        'rows': rows,
        'columns': _matrix_entries(source, 'columns', where, loc, (MIN_MATRIX_COLUMNS, MAX_MATRIX_COLUMNS)),
        'shuffle_rows': _bool(source, 'shuffle_rows', where),
        'display': _choice(source, 'display', where, MATRIX_DISPLAYS, 'auto'),
    }
    if source.get('min_rows') is not None:
        if source.get('required') is True:
            raise _fail(f'{where}.min_rows is for an optional matrix (a required one needs every row)')
        out['min_rows'] = _int(source['min_rows'], f'{where}.min_rows', 1, len(rows))
    return out


_TYPE_VALIDATORS: Final[Mapping[str, Callable[[Mapping[str, Any], str, _Locales], dict[str, Any]]]] = {
    OPEN_TEXT: _open_text,
    SINGLE: lambda source, where, loc: _select(source, where, loc, multi=False),
    MULTI: lambda source, where, loc: _select(source, where, loc, multi=True),
    RATING: _rating,
    NPS: _scale_labels,
    CSAT: _scale_labels,
    CES: _scale_labels,
    STATEMENT: _statement,
    CONSENT: _consent,
    CONTACT: _contact,
    MATRIX: _matrix,
}


def _question(entry: object, index: int, loc: _Locales) -> dict[str, Any]:
    where = f'questions[{index}]'
    source = _object(entry, where)
    kind = source.get('type')
    if kind not in QUESTION_TYPES:
        raise _fail(f'{where}.type must be one of: {", ".join(QUESTION_TYPES)}')
    _closed(source, _COMMON_KEYS | _TYPE_KEYS[kind], where)
    qid = source.get('id')
    if not isinstance(qid, str) or not QUESTION_ID.fullmatch(qid):
        raise _fail(f'{where}.id must match q_[a-z0-9_]{{1,40}}')
    out: dict[str, Any] = {'id': qid, 'type': kind,
                           'headline': loc.text(source.get('headline'), f'{where}.headline', HEADLINE_CHARS,
                                                required=True),
                           'required': _bool(source, 'required', where) and kind != STATEMENT}
    loc.put(out, source, 'subheader', where, LONG_TEXT_CHARS)
    loc.put(out, source, 'button_label', where, BUTTON_CHARS)
    out.update(_TYPE_VALIDATORS[kind](source, where, loc))
    if source.get('logic') is not None:
        out['logic'] = source['logic']  # checked once every question and ending is known (_check_logic)
    return out


def _hidden_fields(value: object) -> list[dict[str, str]]:
    raw = [] if value is None else value
    if not isinstance(raw, list) or len(raw) > MAX_HIDDEN_FIELDS:
        raise _fail(f'hidden_fields must be a list of at most {MAX_HIDDEN_FIELDS} fields')
    fields, seen = [], set()
    for index, entry in enumerate(raw):
        at = f'hidden_fields[{index}]'
        source = _object(entry, at)
        _closed(source, {'id', 'label'}, at)
        hid, label = source.get('id'), source.get('label')
        if isinstance(hid, str) and hid in RESERVED_HIDDEN_IDS:
            raise _fail(f'{at}.id "{hid}" is a reserved name; choose another')
        if not isinstance(hid, str) or not HIDDEN_ID.fullmatch(hid):
            raise _fail(f'{at}.id must match [a-z][a-z0-9_]{{0,39}}')
        if hid in seen:
            raise _fail(f'{at}.id "{hid}" is used twice')
        seen.add(hid)
        out = {'id': hid}
        if label is not None:
            if not isinstance(label, str) or len(label) > MAX_HIDDEN_LABEL_CHARS:
                raise _fail(f'{at}.label must be a string of at most {MAX_HIDDEN_LABEL_CHARS} characters')
            if label.strip():
                out['label'] = label.strip()
        fields.append(out)
    return fields


def _ending(entry: object, index: int, loc: _Locales) -> dict[str, Any]:
    at = f'endings[{index}]'
    source = _object(entry, at)
    _closed(source, {'id', 'title', 'description', 'button'}, at)
    eid = source.get('id')
    if not isinstance(eid, str) or not ENDING_ID.fullmatch(eid):
        raise _fail(f'{at}.id must match end_[a-z0-9_]{{1,40}}')
    out: dict[str, Any] = {'id': eid, 'title': loc.text(source.get('title'), f'{at}.title', HEADLINE_CHARS,
                                                        required=True)}
    loc.put(out, source, 'description', at, LONG_TEXT_CHARS)
    if source.get('button') is not None:
        button = _object(source['button'], f'{at}.button')
        _closed(button, {'label', 'url'}, f'{at}.button')
        out['button'] = {'label': loc.text(button.get('label'), f'{at}.button.label', BUTTON_CHARS, required=True),
                         'url': https_url(button.get('url'), f'{at}.button.url')}
    return out


def _endings(value: object, loc: _Locales) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_ENDINGS:
        raise _fail(f'endings must be a list of 1 to {MAX_ENDINGS} endings')
    endings = [_ending(entry, index, loc) for index, entry in enumerate(value)]
    _unique([ending['id'] for ending in endings], 'endings')
    return endings


def _unique(ids: list[str], where: str) -> None:
    duplicates = sorted({value for value in ids if ids.count(value) > 1})
    if duplicates:
        raise _fail(f'{where}: the id "{duplicates[0]}" is used twice')


def question_bounds(question: Mapping[str, Any]) -> tuple[int, int] | None:
    """The answer range of a rating, NPS, CSAT or CES question (None for any other type)."""
    if question.get('type') == RATING:
        return 1, int(question.get('range') or 5)
    return PRESET_BOUNDS.get(str(question.get('type')))


def answer_shape(question: Mapping[str, Any]) -> tuple[object, tuple[int, int] | None]:
    """What a question's answers mean: its type and, for a scale, its range. Two revisions of a question with the same
    shape take the same answers (a 4 is the same 4); another type or range does not (a 5 of 5 stars is no NPS 5)."""
    return question.get('type'), question_bounds(question)


def _choice_codes(question: Mapping[str, Any]) -> set[str]:
    """The codes a rule may name for a choice question: its options, plus other / none while enabled."""
    codes = {option['code'] for option in question.get('options') or []}
    if (question.get('other') or {}).get('enabled'):
        codes.add(OTHER_CODE)
    if (question.get('none') or {}).get('enabled'):
        codes.add(NONE_CODE)
    return codes


def _rule_value(question: Mapping[str, Any], op: str, value: object, where: str) -> object:
    """The ``when.value`` ``op`` needs for ``question``'s type (absent for submitted / skipped)."""
    kind = question['type']
    if op in _ANSWER_OPS:
        if value is not None:
            raise _fail(f'{where}.value is not used by "{op}"')
        return None
    if kind in SELECT_TYPES:
        return _rule_codes(question, op, value, where)
    bounds = question_bounds(question)
    if bounds is not None:
        return _int(value, f'{where}.value', *bounds)
    if not isinstance(value, str) or not value.strip() or len(value) > RULE_TEXT_CHARS:
        raise _fail(f'{where}.value must be a text of 1 to {RULE_TEXT_CHARS} characters')
    return value.strip()


def _rule_codes(question: Mapping[str, Any], op: str, value: object, where: str) -> object:
    codes = _choice_codes(question)
    if op in {'equals', 'not_equals'}:
        if not isinstance(value, str) or value not in codes:
            raise _fail(f'{where}.value must be one of the question\'s option codes')
        return value
    if (not isinstance(value, list) or not 1 <= len(value) <= MAX_OPTIONS or len(set(map(str, value))) != len(value)
            or any(not isinstance(code, str) or code not in codes for code in value)):
        raise _fail(f'{where}.value must be a list of the question\'s option codes, each once')
    return list(value)


def _rule(raw: object, question: Mapping[str, Any], position: int, targets: Mapping[str, int], where: str
          ) -> dict[str, Any]:
    source = _object(raw, where)
    _closed(source, {'when', 'then'}, where)
    when, then = _object(source.get('when'), f'{where}.when'), _object(source.get('then'), f'{where}.then')
    _closed(when, {'op', 'value'}, f'{where}.when')
    _closed(then, {'jump_to'}, f'{where}.then')
    op = when.get('op')
    if op not in OPS_BY_TYPE[question['type']]:
        allowed = ', '.join(sorted(OPS_BY_TYPE[question['type']]))
        raise _fail(f'{where}.when.op must be one of {allowed} for a {question["type"]} question')
    target = then.get('jump_to')
    if not isinstance(target, str) or target not in targets:
        raise _fail(f'{where}.then.jump_to must name a question or an ending of this form')
    if targets[target] <= position:
        raise _fail(f'{where}.then.jump_to must jump forward (to a later question or an ending)')
    out: dict[str, Any] = {'when': {'op': op}, 'then': {'jump_to': target}}
    value = _rule_value(question, op, when.get('value'), f'{where}.when')
    if value is not None:
        out['when']['value'] = value
    return out


def _check_logic(questions: list[dict[str, Any]], endings: list[dict[str, Any]]) -> None:
    """Every rule in place: its op valid for its type, its value for the question, its target an existing later
    question or an ending (forward only, so no logic can loop)."""
    targets = {question['id']: index for index, question in enumerate(questions)}
    targets.update({ending['id']: len(questions) for ending in endings})
    for index, question in enumerate(questions):
        raw = question.get('logic')
        if raw is None:
            continue
        where = f'questions[{index}].logic'
        if not isinstance(raw, list) or len(raw) > MAX_RULES:
            raise _fail(f'{where} must be a list of at most {MAX_RULES} rules')
        rules = [_rule(rule, question, index, targets, f'{where}[{n}]') for n, rule in enumerate(raw)]
        if rules:
            question['logic'] = rules
        else:
            question.pop('logic')


def validate_definition(definition: Mapping[str, Any], *, retired: Sequence[str] = ()) -> dict[str, Any]:
    """The definition normalized (defaults filled, blank translations dropped), or a ValidationError naming the field.

    ``retired``: the question ids the form used before and removed, none of which may come back.
    """
    loc = _locales(definition)
    raw_questions = definition.get('questions')
    if not isinstance(raw_questions, list) or not MIN_QUESTIONS <= len(raw_questions) <= MAX_QUESTIONS:
        raise _fail(f'questions must be a list of {MIN_QUESTIONS} to {MAX_QUESTIONS} questions')
    questions = [_question(entry, index, loc) for index, entry in enumerate(raw_questions)]
    _unique([question['id'] for question in questions], 'questions')
    reused = sorted({question['id'] for question in questions} & set(retired))
    if reused:
        raise ValidationError(f'questions: the id "{reused[0]}" belonged to a removed question; ids are never reused',
                              code='question_id_reused', details={'question_id': reused[0]})
    endings = _endings(definition.get('endings'), loc)
    _check_logic(questions, endings)
    out = {'language': loc.primary, 'languages': list(loc.languages), 'welcome': _welcome(definition.get('welcome'), loc),
           'questions': questions, 'hidden_fields': _hidden_fields(definition.get('hidden_fields')),
           'endings': endings}
    # (7.63.00) A recall that cannot be filled is no refusal of a save: a draft keeps it while it is fixed, and the 409
    # ``unresolved_placeholder`` when the form would go live (``validate_placeholders``) is the one rule.
    if len(json.dumps(out, ensure_ascii=False).encode()) > MAX_DEFINITION_BYTES:
        raise _fail(f'the form definition must be at most {MAX_DEFINITION_BYTES // 1000} KB')
    return out


def retired_ids(previous: Mapping[str, Any], current: Mapping[str, Any], already: Sequence[str]) -> list[str]:
    """The question ids removed so far: ``already`` plus those ``previous`` had and ``current`` drops (the newest
    ``MAX_RETIRED_IDS``)."""
    kept = {question.get('id') for question in current.get('questions') or []}
    dropped = [question['id'] for question in previous.get('questions') or []
               if isinstance(question, Mapping) and isinstance(question.get('id'), str) and question['id'] not in kept]
    merged = [*[qid for qid in already if qid not in dropped], *dropped]
    return merged[-MAX_RETIRED_IDS:]


# ── The lock of an answered form ─────────────────────────────────────────────────────────────────────────────────
#
# Once a form has a real response (``has_responses``), its answers are stored under its question ids and option codes,
# and read on its questions' types and ranges. The builder never changes one in place (the code and id fields, the type
# select and a rating's points lock), and removes a question or an option only after saying that its answers stay in
# Results as removed. The server holds the same line (TENETS.md tenet 4): a save that drops a question id, or an option
# code from a question it keeps (a rename is a drop plus an add), must name each one in ``removes``, or it is a 409
# ``answers_locked`` naming what it would drop; a save that gives a question it keeps another type or range
# (``reshaped_questions``) is that 409 whatever it names, since its old answers would be read on the new scale (to
# ask it another way, remove it and add a new question). A named removal is kept as the builder keeps it (the question
# id retires for good, ``retired_ids``; the answers stay in Results under the removed question or option).

#: ``removes`` on a save: what the save takes away from an answered form, on purpose (``rows`` and ``columns``: a
#: matrix's, since 7.61.00, ``{question_id: [codes]}`` like ``options``).
_REMOVES_KEYS = frozenset({'questions', 'options', 'rows', 'columns'})
#: The per-question code lists of ``removes``, and each one's limit.
_REMOVED_CODES: Final = (('options', MAX_OPTIONS), ('rows', MAX_MATRIX_ROWS), ('columns', MAX_MATRIX_COLUMNS))


def _strings(value: object, where: str, limit: int) -> set[str]:
    """``value`` as a set of ids: a list of at most ``limit`` strings, else a 400 naming ``where``."""
    ids = value if isinstance(value, list) and len(value) <= limit else None
    if ids is None or any(not isinstance(item, str) for item in ids):
        raise _fail(f'{where} must be a list of at most {limit} ids')
    return set(ids)


def _removed_codes(source: Mapping[str, Any], key: str, limit: int) -> dict[str, set[str]]:
    codes = _object(source.get(key, {}), f'removes.{key}')
    if len(codes) > MAX_QUESTIONS:
        raise _fail(f'removes.{key} names at most {MAX_QUESTIONS} questions')
    return {str(qid): _strings(named, f'removes.{key}.{str(qid)[:40]}', limit) for qid, named in codes.items()}


def validate_removes(value: object) -> dict[str, Any]:
    """``removes`` from a save, as ``{questions: set, options: {question_id: set}, rows: {…}, columns: {…}}``
    (absent or null: nothing)."""
    if value is None:
        return {'questions': set(), **{key: {} for key, _limit in _REMOVED_CODES}}
    source = _object(value, 'removes')
    _closed(source, _REMOVES_KEYS, 'removes')
    return {'questions': _strings(source.get('questions', []), 'removes.questions', MAX_QUESTIONS),
            **{key: _removed_codes(source, key, limit) for key, limit in _REMOVED_CODES}}


def _option_codes(question: Mapping[str, Any], key: str = 'options') -> list[str]:
    """The codes of a question's ``options`` (or a matrix's ``rows`` / ``columns``), in order."""
    options = question.get(key)
    return [str(option['code']) for option in options or [] if isinstance(option, Mapping) and 'code' in option] \
        if isinstance(options, list) else []


def unnamed_removals(previous: Mapping[str, Any], proposed: Mapping[str, Any],
                     removes: Mapping[str, Any]) -> dict[str, Any]:
    """What ``proposed`` drops from ``previous`` without ``removes`` naming it: ``{questions: [ids], options:
    {question_id: [codes]}, rows: {…}, columns: {…}}`` (a matrix's row and column codes lock like option codes), each
    part present only when it is not empty (``{}``: the save may go on)."""
    kept = {question.get('id'): question for question in proposed.get('questions') or [] if isinstance(question, Mapping)}
    named_questions = removes.get('questions') or set()
    questions: list[str] = []
    codes: dict[str, dict[str, list[str]]] = {key: {} for key, _limit in _REMOVED_CODES}
    for question in previous.get('questions') or []:
        qid = question.get('id') if isinstance(question, Mapping) else None
        if not isinstance(qid, str):
            continue
        if qid not in kept:
            if qid not in named_questions:
                questions.append(qid)
            continue
        for key, _limit in _REMOVED_CODES:
            still, named = set(_option_codes(kept[qid], key)), (removes.get(key) or {}).get(qid, set())
            dropped = [code for code in _option_codes(question, key) if code not in still and code not in named]
            if dropped:
                codes[key][qid] = dropped
    return {**({'questions': questions} if questions else {}), **{key: found for key, found in codes.items() if found}}


def reshaped_questions(previous: Mapping[str, Any], proposed: Mapping[str, Any]) -> list[str]:
    """The ids of the questions ``proposed`` keeps from ``previous`` with another type or range (``answer_shape``), in
    ``previous``'s order: never allowed on an answered form, named or not."""
    kept = {question.get('id'): question for question in proposed.get('questions') or [] if isinstance(question, Mapping)}
    reshaped: list[str] = []
    for question in previous.get('questions') or []:
        qid = question.get('id') if isinstance(question, Mapping) else None
        if isinstance(qid, str) and qid in kept and answer_shape(question) != answer_shape(kept[qid]):
            reshaped.append(qid)
    return reshaped


def validate_test_settings(value: object, current: Mapping[str, Any]) -> dict[str, Any]:
    """``settings`` from a save: ``{test: {link_enabled, record}}`` over ``current`` (the stored test settings, whose
    token only the test-link route issues). The read-only fields the form API returns are accepted and ignored."""
    source = _object(value, 'settings')
    _closed(source, {'test'}, 'settings')
    test = _object(source.get('test', {}), 'settings.test')
    _closed(test, {'link_enabled', 'record', 'token_issued', 'token_issued_at'}, 'settings.test')
    out = dict(current)
    out['link_enabled'] = _bool(test, 'link_enabled', 'settings.test', current.get('link_enabled', False))
    out['record'] = _choice(test, 'record', 'settings.test', TEST_RECORDS, current.get('record', 'tag'))
    return out



# ── Publishing: what a live form must hold ───────────────────────────────────────────────────────────────────────

#: The 400 code of a save that would put (or keep) a form live whose text respondents cannot read (the editor maps
#: it onto its own problem, frontend pages/FeedbackForms/model/validateForm.ts ``themeUnreadable``).
THEME_UNREADABLE: Final = 'theme_unreadable'


def theme_publish_problems(theme: object) -> list[dict[str, Any]]:
    """Each palette respondents can be shown whose text is under 3:1 on its background, as ``{palette, ratio}``
    (shared/form_theme.py: one set of contrast rules with the editor and the widget). Empty: it can be published."""
    problems = []
    for name, palette in form_theme.shown_palettes(theme):
        ratio = form_theme.text_contrast_problem(palette)
        if ratio is not None:
            problems.append({'palette': name, 'ratio': round(ratio, 2)})
    return problems


def same_theme(a: object, b: object) -> bool:
    """Whether two themes draw the same form (each read with its defaults, as the API answers it)."""
    return form_theme.with_defaults(a) == form_theme.with_defaults(b)


def validate_publishable(theme: object, *, live: bool, was_live: bool = False, theme_changed: bool = True) -> list[str]:
    """The publish rule of a write whose form ends ``live`` (any writer: the editor, an API caller, the assistant), when
    text is under 3:1 on its background in a palette respondents can be shown:

    - 400 ``theme_unreadable`` when the write turns the form live (``was_live`` False: a new form, a draft or an Off
      form published), or changes a live form's theme (``theme_changed``): a colour change never leaves a live form
      unreadable;
    - otherwise ``['theme_unreadable']``, a warning the API answers with the save: a live form whose stored theme was
      already unreadable (saved before 7.55.01) can still be edited (its questions, Update live form with the theme
      as it is), while the widget's ``safeContrast`` keeps what respondents see readable.

    A form that stays, or goes, Off is always saved, without a warning, so nothing is lost while its colours are being
    fixed. ``[]``: nothing to say."""
    if not live:
        return []
    problems = theme_publish_problems(theme)
    if not problems:
        return []
    if was_live and not theme_changed:
        return [THEME_UNREADABLE]
    first = problems[0]
    raise ValidationError(
        f"The text on the {first['palette']} background is {first['ratio']:.1f}:1, under 3:1: respondents could not "
        'read it. Choose a text or background colour with more contrast to publish the form.',
        code=THEME_UNREADABLE, details={'palettes': problems, 'minimum': form_theme.TEXT_PUBLISH_MINIMUM})

#: The 409 code of a write that would leave a form live whose texts show a placeholder as written (7.61.00).
UNRESOLVED_PLACEHOLDER: Final = 'unresolved_placeholder'


def validate_placeholders(definition: Mapping[str, Any], *, live: bool) -> None:
    """The publish guard of a write whose form ends ``live``: a 409 ``unresolved_placeholder`` ``{texts: [{where,
    placeholder}]}`` while any text respondents can be shown holds a ``{{…}}`` they would see as written
    (shared/forms_recall.py ``unresolved_placeholders``). A form that stays, or goes, Off is always saved."""
    texts = forms_recall.unresolved_placeholders(definition) if live else []
    if texts:
        first = texts[0]
        raise ConflictError(
            f"{first['where']} shows {first['placeholder']} as written: a live form's texts may recall only a hidden "
            'field or an earlier score or single choice, and only in a welcome, headline, subheader or ending. Fix '
            'it to publish the form.',
            code=UNRESOLVED_PLACEHOLDER, details={'texts': texts})


# ── The public projection ────────────────────────────────────────────────────────────────────────────────────────

def _public_question(question: Mapping[str, Any]) -> dict[str, Any]:
    """A question as the widget needs it: an option's category mapping is routing, never published."""
    out = dict(question)
    if isinstance(question.get('options'), list):
        out['options'] = [{key: value for key, value in option.items() if key != 'category'}
                          for option in question['options'] if isinstance(option, Mapping)]
    return out


def public_definition(definition: Mapping[str, Any]) -> dict[str, Any]:
    """The definition the unauthenticated config route serves: no option categories, hidden fields by id only."""
    hidden = definition.get('hidden_fields') or []
    return {
        'language': definition.get('language') or DEFAULT_LOCALE,
        'languages': list(definition.get('languages') or [definition.get('language') or DEFAULT_LOCALE]),
        'welcome': definition.get('welcome') or {'enabled': False},
        'questions': [_public_question(q) for q in definition.get('questions') or [] if isinstance(q, Mapping)],
        'hidden_fields': [{'id': field['id']} for field in hidden if isinstance(field, Mapping) and 'id' in field],
        'endings': list(definition.get('endings') or []),
    }


def text_in(value: object, locale: str, primary: str) -> str:
    """An I18nText in ``locale``, the primary's text when that locale has none ('' for no text)."""
    if not isinstance(value, Mapping):
        return ''
    text = value.get(locale) or value.get(primary)
    return text if isinstance(text, str) else ''
