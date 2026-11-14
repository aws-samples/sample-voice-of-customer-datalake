"""Revise a PR/FAQ or PRD from its comment threads (docs/document-review.md -> Revise from comments).

The work behind ``POST /projects/{id}/documents/{doc}/revise-from-comments`` (an assist job of the
projects API, run by its 15-minute twin, like the persona review). ONE model call on the
``documents`` surface (``shared.converse``; the model comes from ``shared.model_config``) reads the
version's Markdown, the threads it considers (quote, heading, comments and replies, author kind,
status) and the document's evidence (its ``input_feedback_ids``, read under the starter's category
scope, capped), and answers a recommendation per thread and, when the person's way of working lets
the AI write the document, changes: ``{before, after}`` pairs, ``before`` copied from the Markdown.

**Outcome** (docs/ways-of-working.md), decided when the job starts: the projects API asks its one
AI-writing gate (``_require_ai_writing``) whether the AI may write the document for this caller,
and if so the caller's own mode picks applied or proposal (``writing_outcome``):

- ``recommendations``: the AI may not write this document for the caller (Human-driven without the
  unlock; any autonomous caller who is not AI-driven). Recommending is allowed in every mode, like
  the persona review: nothing is written and no change is asked for.
- ``proposal``: interactive and allowed, not AI-driven. The changes go back to the canvas, where the
  person accepts or rejects each and saves (the normal PUT: one new version), then marks the
  accepted changes' threads addressed (``POST …/comments/addressed``).
- ``applied``: AI-driven (both the caller and, for an autonomous call, the project's owner). The
  server applies every kept change as the NEXT version of the series
  (``shared.document_history.revise_document``: D1, never an overwrite; 409 when someone saved since
  the pass read the version) and marks the changes' threads addressed, best effort: a thread it
  could not mark is logged and left out of ``addressed_thread_ids`` (the version stands; the person
  marks it from the canvas). Undo is History's restore. A pass that kept no change writes nothing
  and answers ``recommendations``.

**Grounding.** A change is kept only when its ``before`` occurs EXACTLY ONCE in the base Markdown
(verbatim, not collapsed), does not overlap a change kept before it, differs from its ``after`` and
names at least one considered thread; at most ``MAX_CHANGES`` are kept. Every other change counts in
``dropped``.

**Injection screening.** Every thread, reply and review reaches the prompt inside a DATA block
(``shared.prompt_safety``); a comment or reply ``flagged`` as instruction-shaped when it was written
(shared/document_comments.py) is withheld from the prompt and says so, and so is an anchor's
free-text ``heading`` that reads like one (screened here, where it reaches the prompt), so a
reviewer behind a link cannot steer the rewrite.

**Provenance of the AI** (D4). Every pass's result names the model that answered
(``ConverseResult.model_id``; the surface's model only when a stand-in reports none) and
``REVISE_PROMPT_VERSION`` (``model_id``, ``prompt_version``). The version an applied pass writes
carries both as its ``llm_metadata: {model, prompt_version}`` (the shape personas use), and so does a
person's save of a proposal (``verify_saved_proposal``: read from the pass's job result).
"""
from __future__ import annotations

import itertools
import secrets
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared import ai_mode, category_access
from shared import document_comments as comments
from shared.assist_jobs import COMPLETED
from shared.converse import ConverseResult, answering_model, converse_detailed
from shared.document_history import require_series_head, revise_document
from shared.document_review import SURFACE, TYPE_LABELS
from shared.document_series import collapse, plain_text, series_of
from shared.exceptions import ConflictError, ValidationError
from shared.feedback_sampling import received_input_feedback_ids
from shared.indexes import FEEDBACK_BY_ID_INDEX
from shared.logging import logger
from shared.memory_store import parse_json_object
from shared.prompt_safety import DATA_NOTICE, data_block, injection_findings
from shared.text_clip import stripped_head
from shared.timestamps import now_iso

OUTCOME_RECOMMENDATIONS: Final = 'recommendations'
OUTCOME_PROPOSAL: Final = 'proposal'
OUTCOME_APPLIED: Final = 'applied'
OUTCOMES: Final = (OUTCOME_RECOMMENDATIONS, OUTCOME_PROPOSAL, OUTCOME_APPLIED)

#: The version of what a pass sends the model (``_RULES``, ``_RECOMMEND_ONLY``, ``_WITH_CHANGES``,
#: ``system_prompt``, ``user_prompt``), recorded on every pass's result and on the version it writes
#: (``llm_metadata.prompt_version``), so a revised version says which prompt wrote it. Bump it with ANY change
#: to those prompts: shared/test/test_document_revision.py pins each version to a digest of the
#: rendered prompts (append only), so a prompt edit without a bump fails.
REVISE_PROMPT_VERSION: Final = '1.0.0'

MAX_THREADS: Final = comments.MAX_ADDRESSED_THREADS
MAX_CHANGES: Final = 20
MAX_DOCUMENT_CHARS: Final = 60_000
MAX_BEFORE_CHARS: Final = 2_000
MAX_AFTER_CHARS: Final = 4_000
MAX_REASON_CHARS: Final = 500
MAX_RECOMMENDATION_CHARS: Final = 800
MAX_REPLIES_READ: Final = 10
MAX_THREAD_TEXT_CHARS: Final = 600
MAX_EVIDENCE_ITEMS: Final = 20
MAX_EVIDENCE_TEXT_CHARS: Final = 600
REVISE_MAX_TOKENS: Final = 8_000
WITHHELD: Final = '[withheld: this text reads like an instruction to the AI]'
NO_THREADS: Final = 'No comments to revise from yet: reply to a comment or resolve it first'
TOO_LONG: Final = f'This document is too long to revise from comments (over {MAX_DOCUMENT_CHARS:,} characters)'


_RECOMMEND_ONLY: Final = (
    'Answer with ONE JSON object only: {"recommendations": [{"thread": "T1", "text": "what to change in '
    'the document for this thread, and why, in at most 3 sentences"}]}. One recommendation per thread. '
    'Do not write replacement text: the person revises the document.'
)
_WITH_CHANGES: Final = (
    'Answer with ONE JSON object only: {"recommendations": [{"thread": "T1", "text": "what this thread '
    'asks for and what you changed (or why nothing), in at most 3 sentences"}], "changes": [{"threads": '
    '["T1"], "before": "a passage copied EXACTLY, character for character, from the document Markdown '
    '(markup included), long enough to occur only once", "after": "its replacement Markdown", "reason": '
    '"one sentence"}]}. One recommendation per thread; at most '
    f'{MAX_CHANGES} changes, none overlapping. Change only the parts the threads are about and keep '
    'everything else, citations included, as it is.'
)
_RULES: Final = (
    'Ground every claim about customers in the evidence reviews or the threads; never invent numbers, '
    'quotes or facts. A thread that is resolved without asking for a change, or whose point is already '
    'covered, needs no change. Threads are referred to as T1, T2, ... '
)


# ── Outcome ─────────────────────────────────────────────────────────────────

def writing_outcome(caller_mode: ai_mode.AiMode | None) -> str:
    """The outcome for a caller the AI MAY write for (the projects API's one AI-writing gate said
    so, answering the mode it read; None for a type it does not gate): AI-driven applies, anything
    else proposes. A caller it may not write for recommends."""
    driven = caller_mode is not None and caller_mode.mode == ai_mode.MODE_AI_DRIVEN
    return OUTCOME_APPLIED if driven else OUTCOME_PROPOSAL


# ── Selecting the threads ───────────────────────────────────────────────────

def validate_body(body: Mapping[str, Any]) -> list[str] | None:
    """``{thread_ids?: [≤50 comment ids]}``; None = every thread waiting for a revision."""
    if set(body) - {'thread_ids'}:
        raise ValidationError('body must be {thread_ids?}')
    return comments.validate_thread_ids(body.get('thread_ids'))


def placed(thread: Mapping[str, Any], text: str) -> bool:
    """On the whole document, or its quote is found in this version's plain text."""
    anchor = thread.get('anchor')
    if not isinstance(anchor, Mapping):
        return True
    exact = collapse(str(anchor.get('exact') or ''))
    return bool(exact) and exact in text


def _answered(thread: Mapping[str, Any]) -> bool:
    replies = thread.get('replies')
    return thread.get('status') == comments.STATUS_RESOLVED or (isinstance(replies, list) and bool(replies))


def select_threads(threads: Iterable[Mapping[str, Any]], document: Mapping[str, Any],
                   wanted: list[str] | None) -> list[dict[str, Any]]:
    """The threads a pass considers, oldest first, at most ``MAX_THREADS``.

    ``wanted`` None: every thread that is resolved, or open with a reply, not yet addressed, and
    placed in this version. ``wanted``: those of the series' threads, placed in this version
    (unknown ids are ignored; the person chose them, so status and addressed do not matter).
    """
    text = plain_text(document.get('content'))
    if wanted is None:
        chosen = [dict(t) for t in threads if _answered(t) and not t.get('addressed') and placed(t, text)]
    else:
        wanted_ids = set(wanted)
        chosen = [dict(t) for t in threads if t.get('comment_id') in wanted_ids and placed(t, text)]
    return chosen[:MAX_THREADS]


def require_revisable(document: Mapping[str, Any], threads: Sequence[Mapping[str, Any]]) -> None:
    """The synchronous refusals (400) before a job starts."""
    if len(str(document.get('content') or '')) > MAX_DOCUMENT_CHARS:
        raise ValidationError(TOO_LONG)
    if not plain_text(document.get('content')):
        raise ValidationError('The document is empty; write something to revise first')
    if not threads:
        raise ValidationError(NO_THREADS)


# ── Evidence ────────────────────────────────────────────────────────────────

def read_evidence(feedback_table: Any, document: Mapping[str, Any], scope_config: object) -> list[dict[str, Any]]:
    """The document's input reviews the starter may see, at most ``MAX_EVIDENCE_ITEMS``.

    One keyed query per id on the by-id index (no partition read). An erased review is simply
    absent; a starter whose scope hides a review's category never sends it to the model.
    """
    stored = received_input_feedback_ids(document.get('input_feedback_ids')) or []
    ids = list(dict.fromkeys(stored))[:MAX_EVIDENCE_ITEMS]
    if not ids or feedback_table is None:
        return []
    scope = category_access.scope_from_config(scope_config)
    found = []
    for feedback_id in ids:
        rows = feedback_table.query(IndexName=FEEDBACK_BY_ID_INDEX, Limit=1,
                                    KeyConditionExpression=Key('feedback_id').eq(feedback_id)).get('Items') or []
        if rows and (scope is None or category_access.admits_item(scope, rows[0])):
            found.append(rows[0])
    return found


def _evidence_block(items: Sequence[Mapping[str, Any]]) -> str:
    lines = []
    for item in items:
        text = collapse(str(item.get('original_text') or item.get('text') or ''))[:MAX_EVIDENCE_TEXT_CHARS]
        if not text:
            continue
        if injection_findings(text):
            text = WITHHELD
        date = str(item.get('source_created_at') or '')[:10]
        lines.append(f'- [{item.get("feedback_id")}] ({item.get("source_platform") or "unknown"}, {date or "n/a"}, '
                     f'{item.get("sentiment_label") or "unknown"}): {text}')
    return '\n'.join(lines)


# ── Prompt ──────────────────────────────────────────────────────────────────

def _screened(text: object, flagged: object) -> str:
    if flagged is True:
        return WITHHELD
    return collapse(str(text or ''))[:MAX_THREAD_TEXT_CHARS]


def _author_kind(author: object) -> str:
    return str(author.get('kind') or comments.AUTHOR_USER) if isinstance(author, Mapping) else comments.AUTHOR_USER


def _thread_lines(ref: str, thread: Mapping[str, Any]) -> list[str]:
    anchor = thread.get('anchor')
    if isinstance(anchor, Mapping):
        heading = collapse(str(anchor.get('heading') or ''))[:comments.MAX_HEADING_CHARS]
        if injection_findings(heading):
            heading = WITHHELD
        where = f'on the passage "{collapse(str(anchor.get("exact") or ""))}"' + (
            f' under "{heading}"' if heading else '')
    else:
        where = 'on the whole document'
    raw_replies = thread.get('replies')
    replies = [r for r in raw_replies if isinstance(r, Mapping)] if isinstance(raw_replies, list) else []
    return [f'{ref} ({thread.get("status") or comments.STATUS_OPEN}, {where})',
            _entry('comment', thread),
            *(_entry('reply', reply) for reply in replies[-MAX_REPLIES_READ:])]


def _entry(label: str, entry: Mapping[str, Any]) -> str:
    return f'- {label} by a {_author_kind(entry.get("author"))}: {_screened(entry.get("text"), entry.get("flagged"))}'


def thread_refs(threads: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    """``T1``… -> comment id, in the threads' order."""
    return {f'T{n}': str(thread['comment_id']) for n, thread in enumerate(threads, 1)}


def system_prompt(document_type: str, outcome: str) -> str:
    label = TYPE_LABELS.get(document_type, 'document')
    task = _RECOMMEND_ONLY if outcome == OUTCOME_RECOMMENDATIONS else _WITH_CHANGES
    return (f'You are an editor helping a product team revise a {label} from the comment threads its '
            f'readers left on it. {_RULES}{task} {DATA_NOTICE}')


def user_prompt(markdown: str, threads: Sequence[Mapping[str, Any]], evidence: Sequence[Mapping[str, Any]]) -> str:
    refs = list(thread_refs(threads))
    thread_text = '\n\n'.join('\n'.join(_thread_lines(ref, t)) for ref, t in zip(refs, threads, strict=True))
    blocks = [data_block('document', markdown), data_block('reference', thread_text),
              data_block('reviews', _evidence_block(evidence))]
    return '\n\n'.join(block for block in blocks if block)


# ── Reading the answer ──────────────────────────────────────────────────────

def parse_recommendations(answer: Mapping[str, Any], refs: Mapping[str, str]) -> list[dict[str, str]]:
    """At most one per considered thread, in the threads' order."""
    listed = answer.get('recommendations')
    by_thread: dict[str, str] = {}
    for entry in listed if isinstance(listed, list) else []:
        if not isinstance(entry, Mapping):
            continue
        thread_id = refs.get(str(entry.get('thread') or '').strip())
        text = stripped_head(entry.get('text'), MAX_RECOMMENDATION_CHARS)
        if thread_id and text and thread_id not in by_thread:
            by_thread[thread_id] = text
    return [{'thread_id': tid, 'text': by_thread[tid]} for tid in refs.values() if tid in by_thread]


def _thread_ids(raw: object, refs: Mapping[str, str]) -> list[str]:
    names = raw if isinstance(raw, list) else [raw]
    return list(dict.fromkeys(refs[n.strip()] for n in names if isinstance(n, str) and n.strip() in refs))


def ground_changes(answer: Mapping[str, Any], markdown: str,
                   refs: Mapping[str, str]) -> tuple[list[dict[str, Any]], int]:
    """``(kept changes, dropped)``: the grounding rules in the module docstring."""
    listed = answer.get('changes')
    raw_changes = listed if isinstance(listed, list) else []
    kept: list[dict[str, Any]] = []
    spans: list[tuple[int, int]] = []
    for entry in raw_changes:
        change = _grounded(entry, markdown, refs, spans) if len(kept) < MAX_CHANGES else None
        if change is None:
            continue
        kept.append({'change_id': f'ch_{len(kept) + 1}', **change})
    return kept, len(raw_changes) - len(kept)


def _only_place(text: str, passage: str) -> int | None:
    """Where ``passage`` starts in ``text`` when it occurs at exactly one place, else None.

    Overlapping places count: 'aa' occurs at two places in 'aaa' (``str.count`` sees one), so a quote like that is
    ambiguous and no place is picked for it.
    """
    first = text.find(passage)
    return first if first >= 0 and passage not in text[first + 1:] else None


def _grounded(entry: object, markdown: str, refs: Mapping[str, str],
              spans: list[tuple[int, int]]) -> dict[str, Any] | None:
    if not isinstance(entry, Mapping):
        return None
    before, after = entry.get('before'), entry.get('after')
    if not isinstance(before, str) or not isinstance(after, str) or not before.strip() or before == after:
        return None
    start = _only_place(markdown, before)
    if len(before) > MAX_BEFORE_CHARS or len(after) > MAX_AFTER_CHARS or start is None:
        return None
    end = start + len(before)
    thread_ids = _thread_ids(entry.get('threads'), refs)
    if not thread_ids or any(start < other_end and other_start < end for other_start, other_end in spans):
        return None
    spans.append((start, end))
    return {'thread_ids': thread_ids, 'before': before, 'after': after,
            'reason': stripped_head(entry.get('reason'), MAX_REASON_CHARS)}


def apply_changes(markdown: str, changes: Sequence[Mapping[str, Any]]) -> str:
    """``markdown`` with every change applied where its ``before`` first starts, last first so offsets hold.

    Two changes whose passages overlap (or start at the same place) are refused with a ValueError: applying one
    would move or eat the other's text. ``ground_changes`` never keeps two such changes.
    """
    placed_changes = sorted(((markdown.index(c['before']), c) for c in changes), key=lambda pair: pair[0])
    for (start, change), (next_start, _) in itertools.pairwise(placed_changes):
        if start + len(change['before']) > next_start:
            raise ValueError('apply_changes: two changes overlap; ground the changes first (ground_changes)')
    revised = markdown
    for start, change in reversed(placed_changes):
        revised = revised[:start] + change['after'] + revised[start + len(change['before']):]
    return revised


# ── The work ────────────────────────────────────────────────────────────────

Invoke = Callable[[str, str], ConverseResult]


def _default_invoke(prompt: str, system: str) -> ConverseResult:
    return converse_detailed(prompt=prompt, system_prompt=system, max_tokens=REVISE_MAX_TOKENS, temperature=None,
                             surface=SURFACE, step_name='document_revise_from_comments')


def pass_llm_metadata(model_id: str, prompt_version: str = REVISE_PROMPT_VERSION) -> dict[str, str]:
    """The ``llm_metadata`` of a revised version: ``{model, prompt_version}`` (the shape personas use)."""
    return {'model': model_id, 'prompt_version': prompt_version}


def new_revise_id() -> str:
    """The allocation id of one pass's applied version (stored in the job config): the version write
    is idempotent on it."""
    return secrets.token_hex(12)


def _result(outcome: str, document: Mapping[str, Any], recommendations: list, changes: list, dropped: int,
            *, model_id: str, applied_version: dict | None = None,
            addressed: list[str] | None = None) -> dict[str, Any]:
    return {'outcome': outcome, 'base_document_id': str(document.get('document_id') or ''),
            'base_version': int(document['version']) if document.get('version') is not None else None,
            'recommendations': recommendations, 'changes': changes, 'applied_version': applied_version,
            'addressed_thread_ids': addressed or [], 'dropped': dropped,
            'model_id': model_id, 'prompt_version': REVISE_PROMPT_VERSION}


def run_revision(table: Any, *, project_id: str, series_id: str, document: Mapping[str, Any], document_type: str,
                 wanted: list[str] | None, outcome: str, revise_id: str, actor: Mapping[str, str],
                 evidence: Sequence[Mapping[str, Any]], invoke: Invoke = _default_invoke) -> dict[str, Any]:
    """One pass over ``document``; the job's ``result`` (shape in docs/document-review.md)."""
    if outcome not in OUTCOMES:
        raise ValidationError('Unknown revise outcome')
    threads = select_threads(comments.list_threads(table, project_id, series_id), document, wanted)
    require_revisable(document, threads)
    if outcome == OUTCOME_APPLIED:
        # A version saved since the pass read this one: the write would be refused, so the model is never asked.
        require_series_head(table, project_id, dict(document))
    markdown = str(document.get('content') or '')
    refs = thread_refs(threads)
    reply = invoke(user_prompt(markdown, threads, evidence), system_prompt(document_type, outcome))
    model_id = answering_model(reply, SURFACE)
    answer = parse_json_object(reply.text)
    if answer is None:
        raise ValidationError('The AI answer could not be read. Please try again.')
    recommendations = parse_recommendations(answer, refs)
    if outcome == OUTCOME_RECOMMENDATIONS:
        return _result(outcome, document, recommendations, [], 0, model_id=model_id)
    changes, dropped = ground_changes(answer, markdown, refs)
    if outcome == OUTCOME_PROPOSAL:
        return _result(outcome, document, recommendations, changes, dropped, model_id=model_id)
    if not changes:
        return _result(OUTCOME_RECOMMENDATIONS, document, recommendations, [], dropped, model_id=model_id)
    answered = list(dict.fromkeys(tid for change in changes for tid in change['thread_ids']))
    item = revise_document(table, project_id, dict(document), apply_changes(markdown, changes), revise_id=revise_id,
                           now=now_iso(), actor=dict(actor), llm_metadata=pass_llm_metadata(model_id))
    version = int(item['version'])
    entry = comments.addressed_entry(version=version, document_id=str(item['document_id']),
                                     by_kind=comments.ADDRESSED_BY_AI, by_sub=str(actor.get('sub') or ''))
    marked = _mark_best_effort(table, [t for t in threads if t['comment_id'] in answered], entry)
    return _result(outcome, document, recommendations, changes, dropped, model_id=model_id,
                   applied_version={'document_id': str(item['document_id']), 'version': version},
                   addressed=marked)


def _mark_best_effort(table: Any, threads: Sequence[Mapping[str, Any]], entry: Mapping[str, Any]) -> list[str]:
    """The ids of the threads ``entry`` marked. The version is already written, so a thread that is
    gone, full or could not be written is logged and left out, never a failed pass."""
    marked = []
    for thread in threads:
        try:
            comments.record_addressed(table, thread, entry)
        except (ConflictError, ClientError) as error:
            logger.warning('Revise from comments: a thread was not marked addressed',
                           extra={'comment_id': thread.get('comment_id'), 'error': type(error).__name__})
            continue
        marked.append(str(thread['comment_id']))
    return marked


# ── A person's save of a proposal (PUT …/documents/{doc} revise_job_id, D4) ─────────────────

#: The assist job type of a pass (the projects API registers its work under it).
ASSIST_JOB_TYPE: Final = 'assist_revise_from_comments'
#: The job config's series of the version the pass read (set when the pass starts).
SERIES_CONFIG_KEY: Final = 'series_id'
REVISION_NOT_FOUND: Final = 'That revision was not found in this project'
REVISION_WITHOUT_PROPOSAL: Final = ('That revision has no proposal to save: it is still running, failed '
                                    'or only recommended')
REVISION_OF_SOMEONE_ELSE: Final = 'That revision was started by someone else: save it as your own edit'
REVISION_OF_ANOTHER_DOCUMENT: Final = 'That revision is of another document'
SAVE_WITHOUT_CHANGE: Final = 'This save does not hold a change from that revision'
#: The machine-readable ``code`` of every refusal above (the client offers "Save as my own edit" on it alone).
REVISE_REFUSED_CODE: Final = 'revise_refused'


@dataclass(frozen=True)
class ProposalSave:
    """What a save that names its pass (``revise_job_id``) brings to the check."""

    job_id: str
    #: The job row in the project's own partition (``PROJECT#{id}``), None when there is none.
    job: Mapping[str, Any] | None
    #: The caller's subject (compared with the job's ``initiated_by``) and their ``{sub, kind}``.
    caller_sub: str
    actor: Mapping[str, str]


@dataclass(frozen=True)
class _Texts:
    """A text verbatim and as plain text (the canvas may write the same Markdown with other markup;
    the anchors allow the same)."""

    markdown: str
    flat: str

    @classmethod
    def of(cls, markdown: str) -> _Texts:
        return cls(markdown, plain_text(markdown))

    def count(self, passage: str) -> tuple[int, int]:
        """How often ``passage`` occurs verbatim, and as plain text (0 when it has none)."""
        plain = plain_text(passage)
        return self.markdown.count(passage), self.flat.count(plain) if plain else 0


def _is_new(change: object, saved: _Texts, edited: _Texts) -> bool:
    """``change`` is new in ``saved`` relative to ``edited``: a non-empty ``after`` occurs MORE often
    (verbatim, or as plain text); or its ``before`` occurs LESS often, verbatim and as plain text
    (when it has any), while its non-empty ``after`` is in ``saved`` and does not occur less often
    (a deletion, or a trim whose ``after`` is a piece of its ``before``): other markup on the same
    words is not a deletion, and words the document also says elsewhere may stay."""
    if not isinstance(change, Mapping) or not isinstance(change.get('after'), str):
        return False
    after, before = change['after'], change.get('before')
    counts = list(zip(saved.count(after), edited.count(after), strict=True)) if after.strip() else []
    if any(now > was for now, was in counts):
        return True
    if not isinstance(before, str) or not before.strip():
        return False
    (verbatim_now, plain_now), (verbatim_was, plain_was) = saved.count(before), edited.count(before)
    before_gone = verbatim_now < verbatim_was and (plain_now < plain_was or not plain_text(before))
    # Only a deletion or a trim: the ``after`` is a piece of the ``before`` (verbatim, or as plain text).
    flat_after = plain_text(after)
    trimmed = not after.strip() or after in before or (bool(flat_after) and flat_after in plain_text(before))
    # "Less often" as for the before: verbatim and as plain text; a trim may change the kept words' markup.
    after_kept = not counts or (any(now >= was for now, was in counts) and any(now for now, _ in counts))
    return before_gone and trimmed and after_kept


def holds_a_change(content: str, edited: str, changes: object) -> bool:
    """True when at least one of ``changes`` is NEW in ``content`` (the saved text) relative to
    ``edited`` (the content of the version being edited, ``_is_new``): a text that was already in the
    document, or a change the save does not hold, is not."""
    if not isinstance(changes, list):
        return False
    saved, before = _Texts.of(content), _Texts.of(edited)
    return any(_is_new(change, saved, before) for change in changes)


def _read_the_same_series(job: Mapping[str, Any], project_id: str, document: Mapping[str, Any]) -> bool:
    """The pass read a version of ``document``'s series (its job's config holds the series)."""
    config = job.get('config')
    read = config.get(SERIES_CONFIG_KEY) if isinstance(config, Mapping) else None
    return isinstance(read, str) and bool(read) and read == series_of(project_id, dict(document))['series_id']


def _expired(ttl: object) -> bool:
    """The job's ``ttl`` (epoch seconds) is past: DynamoDB deletes expired items lazily, so a job
    past it may still be read, and counts as gone."""
    return isinstance(ttl, int | float | Decimal) and not isinstance(ttl, bool) and ttl <= time.time()


def _refused(message: str) -> ValidationError:
    """A 400 refusing a save as a revise, with its ``code``."""
    return ValidationError(message, code=REVISE_REFUSED_CODE)


def verify_saved_proposal(save: ProposalSave, *, project_id: str, document: Mapping[str, Any],
                          content: str) -> dict[str, Any]:
    """The ``revise`` provenance (``{edited_by, revise_job_id}``) of a person's save of a proposal, or a 400.

    Recorded only when the job is this project's Revise from comments pass (its ``ttl`` not past),
    completed with outcome ``proposal``, started by the same caller, read a version of the edited document's series, and at
    least one of its changes is new in the saved text relative to ``document`` (the version edited:
    ``holds_a_change``). Never a quiet relabel: any miss refuses the save.

    Plus the pass's ``llm_metadata`` (``pass_llm_metadata``: the model and prompt version its job result
    recorded, not today's). A pass whose result names neither (one finished before passes recorded them)
    adds none: never a guessed model.
    """
    job = save.job
    if not isinstance(job, Mapping) or job.get('job_type') != ASSIST_JOB_TYPE or job.get('project_id') != project_id:
        raise _refused(REVISION_NOT_FOUND)
    if _expired(job.get('ttl')):
        raise _refused(REVISION_NOT_FOUND)
    result = job.get('result')
    if job.get('status') != COMPLETED or not isinstance(result, Mapping) or result.get('outcome') != OUTCOME_PROPOSAL:
        raise _refused(REVISION_WITHOUT_PROPOSAL)
    if not save.caller_sub or job.get('initiated_by') != save.caller_sub:
        raise _refused(REVISION_OF_SOMEONE_ELSE)
    if not _read_the_same_series(job, project_id, document):
        raise _refused(REVISION_OF_ANOTHER_DOCUMENT)
    if not holds_a_change(content, str(document.get('content') or ''), result.get('changes')):
        raise _refused(SAVE_WITHOUT_CHANGE)
    revise: dict[str, Any] = {'edited_by': dict(save.actor), 'revise_job_id': save.job_id}
    model_id, prompt_version = result.get('model_id'), result.get('prompt_version')
    if not isinstance(model_id, str) or not model_id or not isinstance(prompt_version, str) or not prompt_version:
        return revise
    return {**revise, 'llm_metadata': pass_llm_metadata(model_id, prompt_version)}
