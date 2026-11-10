"""Ask personas to review a PR/FAQ or PRD (docs/document-review.md -> Persona review).

The work behind ``POST /projects/{id}/documents/{doc}/persona-review`` (an assist job of the
projects API, run by its 15-minute twin). At most ``MAX_REVIEW_PERSONAS`` of the project's
personas, ``PERSONA_CONCURRENCY`` at a time, ONE model call each on the ``documents`` surface
(``shared.converse``; the model comes from ``shared.model_config``). Each persona answers a
verdict and at most ``MAX_COMMENTS_PER_PERSONA`` comments, each quoting the document.

The server keeps only quotes found VERBATIM (whitespace collapsed) in the document's plain text
(``shared.document_series.plain_text``) and files them as persona comment threads anchored by that
quote; the verdict becomes a persona's comment on the whole document. It never edits the
document, so it runs in every way of working with AI. A re-run on the same version files nothing
twice (same persona, version and quote).
"""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Final

from boto3.dynamodb.conditions import Key

from shared import document_comments as comments
from shared.converse import converse
from shared.document_series import collapse, plain_text
from shared.dynamo_paging import iter_query
from shared.exceptions import ValidationError
from shared.logging import logger
from shared.memory_store import parse_json_object
from shared.persona_context import persona_prompt_block
from shared.prompt_safety import DATA_NOTICE, data_block

MAX_REVIEW_PERSONAS: Final = 6
PERSONA_CONCURRENCY: Final = 3
MAX_COMMENTS_PER_PERSONA: Final = 8
PERSONA_MAX_TOKENS: Final = 2000
MIN_QUOTE_CHARS: Final = 8
MAX_QUOTE_CHARS: Final = comments.MAX_EXACT_CHARS
MAX_PERSONA_COMMENT_CHARS: Final = 800
MAX_VERDICT_CHARS: Final = 800
MAX_DOCUMENT_CHARS: Final = 60_000
CONTEXT_CHARS: Final = 32
STANCES: Final = ('positive', 'mixed', 'negative')
SURFACE: Final = 'documents'

_TYPE_LABELS: Final = {'prfaq': 'PR/FAQ (press release and FAQ)', 'prd': 'product requirements document (PRD)'}

_INSTRUCTIONS: Final = (
    'Review the document as yourself: your goals, frustrations and context. You review; you never '
    'rewrite the document or write replacement text. Answer with ONE JSON object only: '
    '{"stance": "positive"|"mixed"|"negative", "verdict": "your overall reaction in at most 3 sentences", '
    '"comments": [{"quote": "a short passage copied EXACTLY from the document", '
    '"comment": "what you think about that passage, as this customer"}]}. At most '
    f'{MAX_COMMENTS_PER_PERSONA} comments; quote 1 to 3 sentences each, character for character, '
    'without markdown symbols. ' + DATA_NOTICE
)


def validate_persona_ids(body: Mapping[str, Any]) -> list[str] | None:
    """``{persona_ids?: [≤6 ids]}``; None = the project's first personas."""
    if set(body) - {'persona_ids'}:
        raise ValidationError('body must be {persona_ids?}')
    raw = body.get('persona_ids')
    if raw is None:
        return None
    if (not isinstance(raw, list) or not raw or len(raw) > MAX_REVIEW_PERSONAS
            or not all(isinstance(p, str) and 0 < len(p) <= 64 for p in raw)):
        raise ValidationError(f'persona_ids must be a list of 1 to {MAX_REVIEW_PERSONAS} persona ids')
    return list(dict.fromkeys(raw))


def project_personas(table: Any, project_id: str) -> list[dict[str, Any]]:
    query = {'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}') & Key('sk').begins_with('PERSONA#'),
             'ConsistentRead': True}
    return [row for row in iter_query(table, query) if isinstance(row.get('persona_id'), str)]


def pick_personas(personas: Sequence[dict[str, Any]], wanted: list[str] | None) -> list[dict[str, Any]]:
    if wanted is None:
        return list(personas[:MAX_REVIEW_PERSONAS])
    by_id = {p['persona_id']: p for p in personas}
    return [by_id[pid] for pid in wanted if pid in by_id]


def system_prompt(persona: Mapping[str, Any], document_type: str) -> str:
    label = _TYPE_LABELS.get(document_type, 'document')
    return (f'You are a synthetic customer persona asked to review a {label}. Stay in character.\n\n'
            f'{data_block("reference", persona_prompt_block(dict(persona)))}\n\n{_INSTRUCTIONS}')


def locate_quote(quote: object, text: str) -> dict[str, str] | None:
    """The text-quote anchor of ``quote`` in ``text`` (both collapsed), or None when not verbatim."""
    if not isinstance(quote, str):
        return None
    exact = collapse(quote).strip('"\u201c\u201d ')
    if not MIN_QUOTE_CHARS <= len(exact) <= MAX_QUOTE_CHARS:
        return None
    start = text.find(exact)
    if start < 0:
        return None
    end = start + len(exact)
    return {'exact': exact, 'prefix': text[max(0, start - CONTEXT_CHARS):start],
            'suffix': text[end:end + CONTEXT_CHARS], 'heading': ''}


def parse_review(reply: str, text: str) -> dict[str, Any] | None:
    """``{stance, verdict, comments: [{anchor, text}], dropped}``; None for an unreadable reply."""
    answer = parse_json_object(reply)
    if not answer:
        return None
    stance = answer.get('stance') if answer.get('stance') in STANCES else 'mixed'
    verdict = answer.get('verdict')
    listed = answer.get('comments')
    raw_comments = listed if isinstance(listed, list) else []
    kept: list[dict[str, Any]] = []
    dropped = 0
    for entry in raw_comments[:MAX_COMMENTS_PER_PERSONA]:
        body = entry.get('comment') if isinstance(entry, Mapping) else None
        anchor = locate_quote(entry.get('quote'), text) if isinstance(entry, Mapping) else None
        if anchor is None or not isinstance(body, str) or not body.strip():
            dropped += 1
            continue
        kept.append({'anchor': anchor, 'text': body.strip()[:MAX_PERSONA_COMMENT_CHARS]})
    verdict_text = verdict.strip()[:MAX_VERDICT_CHARS] if isinstance(verdict, str) else ''
    return {'stance': stance, 'verdict': verdict_text, 'comments': kept, 'dropped': dropped}


Invoke = Callable[[str, str], str]


def _default_invoke(prompt: str, system: str) -> str:
    return converse(prompt=prompt, system_prompt=system, max_tokens=PERSONA_MAX_TOKENS, temperature=None,
                    surface=SURFACE, step_name='document_persona_review')


def _consult(persona: Mapping[str, Any], document_type: str, prompt: str, text: str,
             invoke: Invoke) -> dict[str, Any] | None:
    try:
        reply = invoke(prompt, system_prompt(persona, document_type))
    except Exception as exc:  # noqa: BLE001 - one persona failing must not sink the review
        logger.warning('Persona review call failed', extra={'error_type': type(exc).__name__})
        return None
    return parse_review(reply, text)


def _dedupe_key(persona_id: str, document_id: str, exact: str) -> tuple[str, str, str]:
    return persona_id, document_id, exact


def _existing_keys(threads: Sequence[Mapping[str, Any]]) -> set[tuple[str, str, str]]:
    keys: set[tuple[str, str, str]] = set()
    for thread in threads:
        author = thread.get('author')
        if not isinstance(author, Mapping) or author.get('kind') != comments.AUTHOR_PERSONA:
            continue
        anchor = thread.get('anchor')
        exact = anchor.get('exact', '') if isinstance(anchor, Mapping) else ''
        keys.add(_dedupe_key(str(author.get('persona_id')), str(thread.get('document_id')), str(exact)))
    return keys


def _file(table: Any, *, project_id: str, series_id: str, document: Mapping[str, Any], persona: Mapping[str, Any],
          review: Mapping[str, Any], seen: set[tuple[str, str, str]]) -> int:
    author = comments.persona_author(str(persona['persona_id']), str(persona.get('name') or ''))
    document_id = str(document.get('document_id'))
    filed = 0
    entries: list[tuple[dict[str, str] | None, str, dict[str, Any]]] = [
        (entry['anchor'], entry['text'], {}) for entry in review['comments']
    ]
    if review['verdict']:
        entries.insert(0, (None, review['verdict'], {'verdict': review['stance']}))
    for anchor, text, extra in entries:
        key = _dedupe_key(author['persona_id'], document_id, anchor['exact'] if anchor else '')
        if key in seen:
            continue
        seen.add(key)
        comments.put_thread(table, comments.thread_item(
            project_id=project_id, series_id=series_id, document=document, author=author,
            text=text, anchor=anchor, extra=extra))
        filed += 1
    return filed


def run_review(table: Any, *, project_id: str, series_id: str, document: Mapping[str, Any], document_type: str,
               personas: Sequence[Mapping[str, Any]], invoke: Invoke = _default_invoke) -> dict[str, Any]:
    """Consult ``personas`` on ``document`` and file their comments; the job's ``result``."""
    text = plain_text(document.get('content'))[:MAX_DOCUMENT_CHARS]
    if not text:
        raise ValidationError('The document is empty; write something to review first')
    prompt = data_block('document', text)
    with ThreadPoolExecutor(max_workers=PERSONA_CONCURRENCY) as pool:
        reviews = list(pool.map(lambda p: _consult(p, document_type, prompt, text, invoke), personas))
    seen = _existing_keys(comments.list_threads(table, project_id, series_id))
    results = []
    for persona, review in zip(personas, reviews, strict=True):
        name = str(persona.get('name') or 'Persona')[:comments.MAX_NAME_CHARS]
        if review is None:
            results.append({'persona_id': persona['persona_id'], 'name': name, 'ok': False, 'filed': 0, 'dropped': 0})
            continue
        filed = _file(table, project_id=project_id, series_id=series_id, document=document, persona=persona,
                      review=review, seen=seen)
        results.append({'persona_id': persona['persona_id'], 'name': name, 'ok': True, 'stance': review['stance'],
                        'filed': filed, 'dropped': review['dropped']})
    return {'document_id': document.get('document_id'), 'version': document.get('version'),
            'personas': results, 'filed': sum(r['filed'] for r in results)}
