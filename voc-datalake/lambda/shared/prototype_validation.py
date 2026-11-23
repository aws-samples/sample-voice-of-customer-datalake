"""A prototype's validation questions, on its own pin form (7.68.00; docs/feedback-forms.md → Prototype pin forms).

The Validate step (shared/project_validation.py) asks real testers inside the prototype. The prototype's own pin form
(``pf_…``, shared/prototype_pins.py) gains a version 2 definition of **validation questions**: per task "Could you
do this?" (yes or no), one CES, a rating per success criterion, and "What was missing?". The pin widget
(static/prototype-pin-widget.js) shows them as a "Tell us how it went" card. The form id does not change, so the
prototype's CSP keeps its one ``connect-src``, its own submit URL (lib/utils/prototype-csp.ts): nothing here writes the
prototype's object or its metadata.

**The save** (``save_questions``, ``PUT /projects/{id}/validation/form``) is the pin form's next revision through
shared/forms_v2.py's own checks, as every forms save is: the definition validated (its retired ids never reused, no
unresolved placeholder on a live form), the revision it replaces kept first as its ``FORMREV#{form_id}#{n:06d}``
snapshot (a version 1 pin form's own fields with it), then the row written conditional on the revision and the save
count it read (a 409 otherwise), the version 1 fields removed. A question kept with another type or range on an
answered form is the forms' 409 ``answers_locked``. ``validation_open`` says whether the card is offered; moving the
card to a newer prototype version turns it off on the version it leaves (``close_card``).

**The submit** (``POST /feedback-forms/{form_id}/submit``, api/feedback_form_handler.py) hooks in here for a
``prototype_pin`` form. A body without ``answers`` is a pin, as before (``PINS#``, never queued). A version 2 body is
taken only when the form asks validation questions (``validation_form``; 400 ``validation_closed`` otherwise); an
empty ``answers`` asks for the card itself (``card_answer``: the widget opened on its own can reach nothing but this
one URL); any other then goes the way of every form's response: checked against the revision it answered, queued for
the processor as a ``feedback_form`` item of the form's own channel (form_ and the pin form's id), tagged
``prototype_validation``. The answers are customer feedback in the lake; pins never are.

**The results** (``real_rows``, ``real_summary``): the form's processed items, read through ``gsi5-by-channel``
(what the channel holds, never the brand's partition), each admitted by the reader's category and source access, and
scored per question against the revision each answered (shared/forms_v2_results.py).
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared import forms_v2 as fv2
from shared.aws import is_conditional_check_failure
from shared.batch_get import batch_get_all
from shared.category_access import CategoryScope, admits_item
from shared.dynamo_paging import iter_query
from shared.exceptions import ConflictError, NotFoundError, ServiceError, ValidationError
from shared.feedback_partitions import CHANNEL_INDEX_PARTITION, channel_partition
from shared.forms_v2_results import ResultRow, tally_results
from shared.indexes import FEEDBACK_BY_CHANNEL_INDEX
from shared.onboarding import FEEDBACK_FORM_PK
from shared.producer_labels import clean_tags
from shared.prototype_pins import FORM_TYPE_PROTOTYPE_PIN
from shared.scoped_query import iter_partition
from shared.timestamps import now_iso

#: The tag every validation answer carries in the lake (the channel stays the form's own: form_ and its pin form's id).
VALIDATION_TAG: Final = 'prototype_validation'
TASK_PREFIX: Final = 'q_vt_'
CRITERION_PREFIX: Final = 'q_vc_'
CES_ID: Final = 'q_v_ces'
MISSING_ID: Final = 'q_v_missing'
ENDING_ID: Final = fv2.V1_ENDING_ID   # (the forms' one thank-you ending)
#: Whether the card is offered and its answers taken (a form attribute beside the definition).
OPEN_FIELD: Final = 'validation_open'
CLOSED_CODE: Final = 'validation_closed'
CLOSED_MESSAGE: Final = 'This prototype asks no validation questions'
#: Real responses one read scores (newest first): far above a prototype test's testers.
MAX_RESPONSES: Final = 2000
#: The deployment's forms partition in voc-aggregates (a pin form is never a workspace's).
FORMS_PARTITION: Final = FEEDBACK_FORM_PK
_LOCKED: Final = ('This prototype has validation answers: a question they answered keeps its type and range. Add a new '
                  'task or criterion instead')
#: What the card's processed items are read with (``metadata`` holds the answers).
_ITEM_FIELDS: Final = ('feedback_id', 'metadata', 'source_created_at', 'sentiment_label', 'category', 'source_platform')

_COPY_KEYS: Final = ('title', 'description', 'task', 'yes', 'no', 'ces', 'ces_low', 'ces_high', 'criterion',
                     'rating_low', 'rating_high', 'missing', 'send', 'cancel', 'empty', 'failed')
#: The card's buttons and messages (the widget's own words around the questions).
CARD_LABELS: Final = ('send', 'cancel', 'empty', 'failed')
#: The card's own words in each of the nine locales (a task's and a criterion's text stay as the person wrote them).
COPY: Final[Mapping[str, Mapping[str, str]]] = {
    'en': dict(zip(_COPY_KEYS, (
        'Tell us how it went', 'A few questions about what you tried. It takes about a minute.',
        'Could you do this?', 'Yes', 'No', 'How easy was it to do what you wanted to do?', 'Very difficult',
        'Very easy', 'How well does the prototype do this?', 'Not at all', 'Completely', 'What was missing?',
        'Send', 'Cancel', 'Answer at least one question.', 'Your answers could not be sent. Please try again.'),
        strict=True)),
    'es': dict(zip(_COPY_KEYS, (
        'Cuéntenos cómo le fue', 'Unas preguntas sobre lo que probó. Le llevará un minuto.',
        '¿Pudo hacerlo?', 'Sí', 'No', '¿Qué tan fácil le resultó hacer lo que quería?', 'Muy difícil',
        'Muy fácil', '¿Qué tan bien lo cumple el prototipo?', 'Nada', 'Por completo', '¿Qué echó en falta?',
        'Enviar', 'Cancelar', 'Responda al menos una pregunta.', 'No se pudieron enviar sus respuestas. Inténtelo de nuevo.'),
        strict=True)),
    'fr': dict(zip(_COPY_KEYS, (
        'Dites-nous comment cela s\u2019est passé', 'Quelques questions sur ce que vous avez essayé. Une minute environ.',
        'Avez-vous pu le faire ?', 'Oui', 'Non', 'Était-il facile de faire ce que vous vouliez ?', 'Très difficile',
        'Très facile', 'Dans quelle mesure le prototype y répond-il ?', 'Pas du tout', 'Complètement',
        'Qu\u2019est-ce qui manquait ?',
        'Envoyer', 'Annuler', 'Répondez à au moins une question.', 'Vos réponses n\u2019ont pas pu être envoyées. Réessayez.'), strict=True)),
    'de': dict(zip(_COPY_KEYS, (
        'Erzählen Sie uns, wie es lief', 'Ein paar Fragen zu dem, was Sie ausprobiert haben. Etwa eine Minute.',
        'Konnten Sie das tun?', 'Ja', 'Nein', 'Wie einfach war es, das zu tun, was Sie wollten?', 'Sehr schwer',
        'Sehr einfach', 'Wie gut erfüllt der Prototyp das?', 'Gar nicht', 'Vollständig', 'Was hat gefehlt?',
        'Senden', 'Abbrechen', 'Beantworten Sie mindestens eine Frage.', 'Ihre Antworten konnten nicht gesendet werden. Bitte versuchen Sie es erneut.'),
        strict=True)),
    'pt': dict(zip(_COPY_KEYS, (
        'Conte-nos como foi', 'Algumas perguntas sobre o que você experimentou. Leva cerca de um minuto.',
        'Você conseguiu fazer isso?', 'Sim', 'Não', 'Quão fácil foi fazer o que você queria?', 'Muito difícil',
        'Muito fácil', 'Quão bem o protótipo faz isso?', 'Nada', 'Completamente', 'O que faltou?',
        'Enviar', 'Cancelar', 'Responda a pelo menos uma pergunta.', 'Não foi possível enviar suas respostas. Tente novamente.'), strict=True)),
    'ja': dict(zip(_COPY_KEYS, (
        'ご感想をお聞かせください', '試していただいた内容について少しお尋ねします。1分ほどで終わります。',
        'これはできましたか\uff1f', 'はい', 'いいえ', 'やりたいことはどのくらい簡単にできましたか\uff1f', 'とても難しい',
        'とても簡単', 'プロトタイプはこれをどの程度満たしていますか\uff1f', 'まったく', '完全に', '足りなかったものは何ですか\uff1f',
        '送信', 'キャンセル', '少なくとも1つの質問に答えてください。', '回答を送信できませんでした。もう一度お試しください。'),
        strict=True)),
    'zh': dict(zip(_COPY_KEYS, (
        '告诉我们使用情况', '关于您刚才尝试的内容的几个问题\uff0c大约需要一分钟。',
        '您能完成这项操作吗\uff1f', '能', '不能', '完成您想做的事有多容易\uff1f', '非常困难', '非常容易',
        '原型在这方面做得如何\uff1f', '完全没有', '完全做到', '缺少了什么\uff1f',
        '发送', '取消', '请至少回答一个问题。', '无法发送您的回答\uff0c请重试。'), strict=True)),
    'ko': dict(zip(_COPY_KEYS, (
        '어떠셨는지 알려 주세요', '사용해 보신 내용에 대한 몇 가지 질문입니다. 1분 정도 걸립니다.',
        '이 작업을 할 수 있었나요?', '예', '아니요', '원하는 일을 하기가 얼마나 쉬웠나요?', '매우 어려움', '매우 쉬움',
        '프로토타입이 이것을 얼마나 잘 해내나요?', '전혀', '완전히', '무엇이 부족했나요?',
        '보내기', '취소', '질문에 하나 이상 답해 주세요.', '답변을 보내지 못했습니다. 다시 시도해 주세요.'), strict=True)),
    'pl': dict(zip(_COPY_KEYS, (
        'Powiedz nam, jak poszło', 'Kilka pytań o to, co wypróbowałeś. To zajmie około minuty.',
        'Czy udało Ci się to zrobić?', 'Tak', 'Nie', 'Jak łatwo było zrobić to, co chciałeś?', 'Bardzo trudno',
        'Bardzo łatwo', 'Jak dobrze prototyp to spełnia?', 'Wcale', 'W pełni', 'Czego brakowało?',
        'Wyślij', 'Anuluj', 'Odpowiedz na co najmniej jedno pytanie.', 'Nie udało się wysłać odpowiedzi. Spróbuj ponownie.'), strict=True)),
}


def task_question_id(task_id: str) -> str:
    return f'{TASK_PREFIX}{task_id}'


def criterion_question_id(criterion_id: str) -> str:
    return f'{CRITERION_PREFIX}{criterion_id}'


def is_validation_question(question_id: object) -> bool:
    return isinstance(question_id, str) and (question_id.startswith((TASK_PREFIX, CRITERION_PREFIX))
                                             or question_id in (CES_ID, MISSING_ID))


def definition_for(tasks: Sequence[Mapping[str, Any]], criteria: Sequence[Mapping[str, Any]],
                   language: str) -> dict[str, Any]:
    """The card's version 2 definition (before shared/forms_v2.py validates it): the tasks' yes/no, one CES, a 1-5
    rating per criterion and an open "What was missing?", in ``language`` (one of the nine)."""
    if language not in COPY:
        raise ValidationError(f'language must be one of: {", ".join(COPY)}')
    copy = COPY[language]

    def text(value: str) -> dict[str, str]:
        return {language: value}

    questions: list[dict[str, Any]] = [{
        'id': task_question_id(task['id']), 'type': fv2.SINGLE, 'headline': text(task['text']),
        'subheader': text(copy['task']), 'required': False, 'display': 'chips',
        'options': [{'code': 'yes', 'label': text(copy['yes'])}, {'code': 'no', 'label': text(copy['no'])}],
    } for task in tasks]
    questions.append({'id': CES_ID, 'type': fv2.CES, 'headline': text(copy['ces']), 'required': False,
                      'lower_label': text(copy['ces_low']), 'upper_label': text(copy['ces_high'])})
    questions.extend({
        'id': criterion_question_id(criterion['id']), 'type': fv2.RATING, 'headline': text(criterion['text']),
        'subheader': text(copy['criterion']), 'required': False, 'scale': 'number', 'range': 5,
        'lower_label': text(copy['rating_low']), 'upper_label': text(copy['rating_high']),
    } for criterion in criteria)
    questions.append({'id': MISSING_ID, 'type': fv2.OPEN_TEXT, 'headline': text(copy['missing']), 'required': False,
                      'long': True})
    return {'language': language, 'languages': [language],
            'welcome': {'enabled': True, 'title': text(copy['title']), 'description': text(copy['description'])},
            'questions': questions, 'hidden_fields': [],
            'endings': [{'id': ENDING_ID, 'title': text(fv2.THANK_YOU[language])}]}


# ── The save: the pin form's next revision ─────────────────────────────────────────────────────────────────────

def form_key(form_id: str) -> dict[str, str]:
    return {'pk': FORMS_PARTITION, 'sk': f'FORM#{form_id}'}


def revision_key(form_id: str, revision: int) -> dict[str, str]:
    return {'pk': FORMS_PARTITION, 'sk': f'{fv2.REVISION_PREFIX}{form_id}#{revision:06d}'}


def read_pin_form(table: Any, form_id: str) -> dict[str, Any]:
    """The pin form's row (strongly consistent); 404 for no form, or one that is not a prototype's pin form."""
    item = table.get_item(Key=form_key(form_id), ConsistentRead=True).get('Item')
    if not item or item.get('form_type') != FORM_TYPE_PROTOTYPE_PIN:
        raise NotFoundError("This prototype has no feedback form: build a new version of it first")
    return item


def _snapshot(form_id: str, revision: int, definition: Mapping[str, Any], v1: Mapping[str, Any] | None) -> dict:
    """The ``FORMREV#`` row of the revision a save replaces (a version 1 form's own fields with it, as stored)."""
    return {**revision_key(form_id, revision), 'form_id': form_id, 'revision': revision,
            'schema_version': fv2.SCHEMA_VERSION, 'snapshot_at': now_iso(), **definition, **({'v1': dict(v1)} if v1 else {})}


def _conditional(stored: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """The condition on the revision and the save count the save read (none stored: none may appear meanwhile)."""
    values: dict[str, Any] = {}
    parts = ['attribute_exists(sk)']
    for name, placeholder in (('revision', ':expected'), ('write_count', ':writes')):
        if name in stored:
            parts.append(f'#{name} = {placeholder}')
            values[placeholder] = stored[name]
        else:
            parts.append(f'attribute_not_exists(#{name})')
    return ' AND '.join(parts), values


def _checked(stored: Mapping[str, Any],
             proposed: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str], bool]:
    """``proposed`` through every check of the save against the stored row: ``(definition, current, retired ids,
    changed)``; a 400 or the 409 ``answers_locked`` otherwise."""
    current = fv2.definition_of(stored)
    retired = [qid for qid in fv2.plain(stored.get('retired_ids') or []) if isinstance(qid, str)]
    definition = fv2.validate_definition(proposed, retired=retired)
    fv2.validate_placeholders(definition, live=stored.get('enabled') is True)
    changed = fv2.canonical(definition) != fv2.canonical(current)
    if changed and stored.get('has_responses') is True and fv2.reshaped_questions(current, definition):
        raise ConflictError(_LOCKED, code='answers_locked',
                            details={'changed': fv2.reshaped_questions(current, definition)})
    return definition, current, retired, changed


def check_questions(table: Any, form_id: str, proposed: Mapping[str, Any]) -> dict[str, Any]:
    """The definition ``save_questions`` would write, every check of it made and nothing written (a 404, 400 or 409
    first): the Validate step checks the card before it writes the project's block."""
    return _checked(read_pin_form(table, form_id), proposed)[0]


def save_questions(table: Any, form_id: str, proposed: Mapping[str, Any], *, open_card: bool,
                   actor_sub: str) -> dict[str, Any]:
    """Write ``proposed`` as the pin form's definition (a new revision when it changes it) and ``validation_open``;
    the row as written."""
    stored = read_pin_form(table, form_id)
    definition, current, retired, changed = _checked(stored, proposed)
    revision = fv2.revision_of(stored)
    sets: dict[str, Any] = {**definition, 'schema_version': fv2.SCHEMA_VERSION, 'revision': revision + int(changed),
                            'write_count': fv2.write_count(stored) + 1, 'updated_at': now_iso(), 'updated_by': actor_sub,
                            OPEN_FIELD: open_card}
    if changed:
        sets['retired_ids'] = fv2.retired_ids(current, definition, retired)
    v1 = None if fv2.is_v2(stored) else fv2.v1_source(stored)
    removes = [name for name in fv2.V1_FIELDS if name in stored]
    condition, values = _conditional(stored)
    names = {'#revision': 'revision', '#write_count': 'write_count', **{f'#s{i}': n for i, n in enumerate(sets)},
             **{f'#r{i}': n for i, n in enumerate(removes)}}
    values.update({f':s{i}': value for i, value in enumerate(sets.values())})
    expression = 'SET ' + ', '.join(f'#s{i} = :s{i}' for i in range(len(sets)))
    if removes:
        expression += ' REMOVE ' + ', '.join(f'#r{i}' for i in range(len(removes)))
    try:
        if changed or v1 is not None:
            table.put_item(Item=_snapshot(form_id, revision, current, v1))
        response = table.update_item(Key=form_key(form_id), UpdateExpression=expression, ConditionExpression=condition,
                                     ExpressionAttributeNames=names, ExpressionAttributeValues=values,
                                     ReturnValues='ALL_NEW')
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise ConflictError(fv2.CHANGED_MEANWHILE, code='revision_conflict') from error
        raise
    return response.get('Attributes') or {}


def close_card(table: Any, form_id: str, *, actor_sub: str) -> None:
    """Stop offering the card on ``form_id`` (``validation_open`` false, a save counted; its questions and answers
    stay): the card moved to a newer prototype version, whose testers answer there. A form gone since is left alone."""
    try:
        table.update_item(
            Key=form_key(form_id), ConditionExpression='attribute_exists(sk) AND #type = :pin',
            UpdateExpression='SET #open = :closed, #updated_at = :now, #updated_by = :by, '
                             '#write_count = if_not_exists(#write_count, :zero) + :one',
            ExpressionAttributeNames={'#type': 'form_type', '#open': OPEN_FIELD, '#updated_at': 'updated_at',
                                      '#updated_by': 'updated_by', '#write_count': 'write_count'},
            ExpressionAttributeValues={':pin': FORM_TYPE_PROTOTYPE_PIN, ':closed': False, ':now': now_iso(),
                                       ':by': actor_sub, ':zero': 0, ':one': 1})
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise


def form_state(form: Mapping[str, Any]) -> dict[str, Any]:
    """What the Validation tab shows of the form: its id, revision, whether the card is open and how many it asks."""
    asks = [q for q in fv2.definition_of(form).get('questions') or [] if is_validation_question(q.get('id'))]
    return {'form_id': form.get('form_id'), 'revision': fv2.revision_of(form), 'open': asks_questions(form),
            'questions': len(asks), 'has_responses': form.get('has_responses') is True}


# ── The public submit's hook ─────────────────────────────────────────────────────────────────────────────────────

def asks_questions(form: Mapping[str, Any]) -> bool:
    """A version 2 pin form whose card is open and whose definition holds validation questions."""
    return (fv2.is_v2(form) and form.get(OPEN_FIELD) is True
            and any(is_validation_question(q.get('id')) for q in fv2.definition_of(form).get('questions') or []))


def validation_form(form: Mapping[str, Any]) -> dict[str, Any]:
    """The form a version 2 body on a pin form is taken against, tagged ``prototype_validation`` (the item's tags are
    the form's: api/feedback_form_handler.py ``_ingest``); a 400 ``validation_closed`` when it asks none."""
    if not asks_questions(form):
        raise ValidationError(CLOSED_MESSAGE, code=CLOSED_CODE)
    return {**form, 'tags': clean_tags([*(form.get('tags') or []), VALIDATION_TAG])}


#: What a request for the card may carry besides its empty ``answers``.
_CARD_REQUEST_KEYS: Final = frozenset({'answers', 'language', 'form_id'})


def card_answer(form: Mapping[str, Any], body: Mapping[str, Any]) -> dict[str, Any] | None:
    """The card when ``body`` asks for it (``answers: {}`` and nothing to answer), else None: an empty response is
    never one (shared/forms_v2_responses.py refuses it), so the two cannot be confused."""
    if body.get('answers') != {} or set(body) - _CARD_REQUEST_KEYS:
        return None
    return {'success': True, 'card': public_card(form)}


def _flat(value: object, language: str) -> str:
    return fv2.text_in(value, language, language)


def _card_question(question: Mapping[str, Any], language: str) -> dict[str, Any]:
    out: dict[str, Any] = {'id': question['id'], 'type': question['type'],
                           'headline': _flat(question.get('headline'), language)}
    for key in ('subheader', 'lower_label', 'upper_label'):
        if question.get(key):
            out[key] = _flat(question[key], language)
    if question.get('options'):
        out['options'] = [{'code': o['code'], 'label': _flat(o.get('label'), language)} for o in question['options']]
    bounds = fv2.question_bounds(question)
    if bounds is not None:
        out['range'] = list(bounds)
    return out


def public_card(form: Mapping[str, Any]) -> dict[str, Any]:
    """The card as the widget draws it: the revision it answers, its language, its welcome words and its validation
    questions with their texts in that language (nothing the public config route would not serve)."""
    definition = fv2.definition_of(form)
    language = str(definition.get('language') or fv2.DEFAULT_LOCALE)
    welcome = definition.get('welcome') or {}
    endings = definition.get('endings') or [{}]
    return {'form_id': form.get('form_id'), 'revision': fv2.revision_of(form), 'language': language,
            'title': _flat(welcome.get('title'), language), 'description': _flat(welcome.get('description'), language),
            'questions': [_card_question(q, language) for q in definition.get('questions') or []
                          if is_validation_question(q.get('id'))],
            'thanks': _flat(endings[0].get('title'), language),
            'labels': {key: COPY.get(language, COPY[fv2.DEFAULT_LOCALE])[key] for key in CARD_LABELS}}


# ── The results: real testers' answers ───────────────────────────────────────────────────────────────────────

def revisions_of(table: Any, form_id: str) -> dict[int, dict[str, Any]]:
    """The form's earlier revisions' definitions by number (its ``FORMREV#`` snapshots)."""
    rows = iter_query(table, {'KeyConditionExpression': Key('pk').eq(FORMS_PARTITION)
                              & Key('sk').begins_with(f'{fv2.REVISION_PREFIX}{form_id}#')})
    out: dict[int, dict[str, Any]] = {}
    for row in rows:
        number = fv2.plain(row.get('revision'))
        if isinstance(number, int) and not isinstance(number, bool):
            out[number] = {name: fv2.plain(row.get(name)) for name in fv2.DEFINITION_FIELDS}
    return out


def _as_row(item: Mapping[str, Any]) -> ResultRow | None:
    metadata = fv2.plain(item.get('metadata')) if isinstance(item.get('metadata'), Mapping) else {}
    answers = metadata.get('form_answers')
    if not isinstance(answers, Mapping):
        return None
    path = metadata.get('form_path')
    revision = metadata.get('form_revision')
    return ResultRow(answers, [str(qid) for qid in path] if isinstance(path, list) else list(answers),
                     metadata.get('form_ending_id'), str(item.get('source_created_at') or ''),
                     response_id=str(item.get('feedback_id') or ''),
                     revision=revision if isinstance(revision, int) else None,
                     sentiment=item.get('sentiment_label') or None)


def real_rows(feedback_table: Any, form_id: str, scope: CategoryScope) -> list[ResultRow]:
    """The form's processed responses the reader may see (category and source access), newest first, at most
    ``MAX_RESPONSES``: keys from ``gsi5-by-channel`` (``CHANNEL#form_{form_id}``), then the items themselves."""
    index_rows = iter_partition(None, feedback_table, CHANNEL_INDEX_PARTITION, channel_partition(None, f'form_{form_id}'),
                                IndexName=FEEDBACK_BY_CHANNEL_INDEX, ScanIndexForward=False, max_items=MAX_RESPONSES)
    keys = [{'pk': row['pk'], 'sk': row['sk']} for row in index_rows if admits_item(scope, row)]
    if not keys:
        return []
    names = {f'#a{i}': name for i, name in enumerate(_ITEM_FIELDS)}
    items = batch_get_all(feedback_table, keys, failure=ServiceError('Failed to read the validation answers'),
                          read_options={'ProjectionExpression': ', '.join(names),
                                        'ExpressionAttributeNames': names, 'ConsistentRead': False})
    rows = [row for item in items if admits_item(scope, item) and (row := _as_row(item)) is not None]
    return sorted(rows, key=lambda row: row.created_at, reverse=True)


def _question(tally: Mapping[str, Any], question_id: str) -> Mapping[str, Any]:
    return next((q for q in tally.get('questions') or [] if q.get('id') == question_id), {})


def real_summary(definition: Mapping[str, Any], rows: Iterable[ResultRow], revisions: Mapping[int, Mapping[str, Any]],
                 tasks: Sequence[Mapping[str, Any]], criteria: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """``{responses, last_response_at, tasks: {id: {n, yes, no, rate}}, ces: {n, average, score}, criteria: {id:
    {n, average, histogram}}, missing: [{text, at, response_id}], missing_count, feedback_ids}`` over the real rows:
    ``missing`` the newest answers to "What was missing?" (at most the tally's ``LATEST_ANSWERS``), ``missing_count``
    how many answered it."""
    kept = list(rows)
    tally = tally_results(definition, kept, revisions=revisions)
    task_out: dict[str, Any] = {}
    for task in tasks:
        options = _question(tally, task_question_id(task['id'])).get('options') or {}
        yes, no = int(options.get('yes', 0)), int(options.get('no', 0))
        task_out[task['id']] = {'n': yes + no, 'yes': yes, 'no': no,
                                'rate': round(yes / (yes + no), 4) if yes + no else None}
    criteria_out = {}
    for criterion in criteria:
        question = _question(tally, criterion_question_id(criterion['id']))
        criteria_out[criterion['id']] = {'n': int(question.get('answered') or 0), 'average': question.get('average'),
                                         'histogram': question.get('histogram') or {}}
    ces = _question(tally, CES_ID)
    missing_question = _question(tally, MISSING_ID)
    missing = missing_question.get('latest') or []
    return {
        'responses': tally['responses'], 'last_response_at': tally['last_response_at'], 'tasks': task_out,
        'ces': {'n': int(ces.get('answered') or 0), 'average': ces.get('average'),
                'score': (ces.get('ces') or {}).get('score')},
        'criteria': criteria_out,
        'missing': [{'text': entry.get('value'), 'at': entry.get('created_at'), 'response_id': entry.get('response_id')}
                    for entry in missing],
        'missing_count': int(missing_question.get('count') or 0),
        'feedback_ids': [row.response_id for row in kept if row.response_id],
    }
