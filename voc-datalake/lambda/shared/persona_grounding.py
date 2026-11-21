"""Persona grounding: the evidence a persona answers from (docs/project-workspace.md → Persona focus groups).

One module for every surface that lets a project's personas speak: the focus groups (7.64.00) now, the Validate
phase and the voice personas after them. Each persona's pack is:

* its stored evidence: the reviews its evidence refreshes added (``evidence_updates``, newest first), then the ones its
  ``supporting_evidence`` cites (``evidence_feedback_ids``, first cited first), at most ``MAX_STORED_EVIDENCE``: a
  refresh is what a person asked for, so a persona citing many reviews never pushes it out of the pack;
* fresh retrieval: the reviews imported since the persona was generated that match it and that it does not hold yet
  (neither its evidence nor the reviews it was written from), at most ``MAX_FRESH`` (8), the ones that share the most
  words with the question first, then the newest. "Match" is the persona's categories
  (the categories of the reviews it was written from, most frequent first) within the project's own filters
  (``filters.sources``, ``categories``, ``sentiments`` on its ``META``).

Every review is read as the person asking: their category scope (``shared.category_access``, its category AND source
rules) admits it or it is not in the pack, so a pack never holds an id the person could not open. Each review is the
stored text, which is already the source's PII policy as applied at ingestion (a ``redact`` source's text redacted,
a ``summary_only`` source's text its summary, ``verbatim: false``); the author, title, URL and metadata are never
read into it. Text that reads like an instruction to a model is withheld, as the revise-from-comments evidence is.

A pack is ids and short quotes for one request: nothing is stored. Only **Refresh evidence** writes, and only the ids
it found: it appends ``{at, by: {sub, kind}, reason, feedback_ids}`` to the persona's ``evidence_updates`` (at most
``MAX_EVIDENCE_UPDATES`` entries, the oldest dropped) and sets ``evidence_refreshed_at``; the persona's own text is
never rewritten (regenerating stays the generation's). The freshness count is every match since the generation that
the persona does not hold yet, so a refresh that took 8 of 20 leaves 12 to count and to refresh again.

Not per workspace yet: projects are the deployment's until phase 3 (docs/multi-workspace.md), so a ``workspace`` is
refused (``require_deployment``) and every read is the deployment's feedback, as the project gate's.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared import category_access
from shared.aws import is_conditional_check_failure
from shared.category_access import CategoryScope
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.feedback import DATE_BASIS_IMPORTED, basis_date
from shared.feedback_partitions import FEEDBACK_ID_INDEX_PARTITION, date_partition, feedback_id_partition
from shared.feedback_sampling import Partition, fetch_full, read_pool
from shared.feedback_similarity import item_tokens, tokens
from shared.indexes import FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_ID_INDEX
from shared.item_filters import NO_ITEM_FILTERS
from shared.logging import logger
from shared.persona_evidence import EVIDENCE_FEEDBACK_IDS_FIELD, listed_ids
from shared.project_keys import PROJECT_GATE_STORE, project_pk, require_deployment
from shared.prompt_safety import WITHHELD, injection_findings
from shared.source_profiles import PII_SUMMARY_ONLY
from shared.text_clip import clip_words
from shared.time_budget import WalkBudget
from shared.timestamps import now_iso
from shared.ws_repo import WorkspaceScope

__all__ = [
    'EVIDENCE_UPDATES_FIELD',
    'Reader',
    'evidence_freshness',
    'evidence_pack',
    'evidence_update_entries',
    'refresh_evidence',
    'validated_pack_request',
    'visible_ids',
]

#: The persona fields a refresh writes (nothing else of the persona changes).
EVIDENCE_UPDATES_FIELD: Final = 'evidence_updates'
EVIDENCE_REFRESHED_AT_FIELD: Final = 'evidence_refreshed_at'
#: A refresh's entries kept on the persona, the newest last; an older one is dropped.
MAX_EVIDENCE_UPDATES: Final = 20
#: A refresh's reason, recorded with its actor and time (TENETS.md D4).
REFRESH_REASON: Final = 'manual_refresh'

#: The personas one pack covers: a focus group's ceiling (stream contract FOCUS_GROUP_LIMITS.maxPersonas).
MAX_PACK_PERSONAS: Final = 6
#: Fresh reviews per persona, and a refresh's at most (the plan's "top 8 since it was generated").
MAX_FRESH: Final = 8
#: Stored reviews (cited, then refreshed) per persona in a pack, and how many of its listed ids are looked at to find
#: them (a restricted person may see few of them: the reads stay bounded).
MAX_STORED_EVIDENCE: Final = 12
MAX_STORED_EXAMINED: Final = 24
#: Stored ids read to learn a persona's categories (cited first, else the reviews it was written from).
MAX_CATEGORY_SAMPLE: Final = 20
#: The persona's most frequent categories that its fresh reviews are matched on.
MAX_PERSONA_CATEGORIES: Final = 5
#: Fresh candidates fetched in full to rank against the question (the newest first).
MAX_FRESH_CANDIDATES: Final = 40
#: The oldest day a fresh read reaches back to: a persona older than this is matched on its last year.
MAX_FRESH_DAYS: Final = 365
#: One pack's or one freshness count's walk of the day partitions (a synchronous read: the stream's invoke, or
#: API Gateway's 29 s for the persona card). Past it the count is a lower bound and the pack says so.
WALK_SECONDS: Final = 8.0
#: The characters of one review's text in a pack (a persona's prompt holds up to 20 of them).
MAX_QUOTE_CHARS: Final = 400
MAX_QUESTION_CHARS: Final = 2000
MAX_ID_CHARS: Final = 128

ORIGIN_CITED: Final = 'cited'
ORIGIN_REFRESHED: Final = 'refreshed'
ORIGIN_FRESH: Final = 'fresh'



@dataclass(frozen=True)
class Reader:
    """Who a pack is read for, and the tables it reads.

    ``scope`` is the person's category scope (``category_gate.scope_for_event``): what they may see is the only
    thing a pack may hold. ``today`` is injectable so a test can pin the window.
    """

    projects_table: Any
    feedback_table: Any
    scope: CategoryScope
    today: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    #: The reviews read by id in this request (a persona's categories and its stored evidence name the same ones).
    rows: dict[str, dict | None] = field(default_factory=dict)


# ── Request validation ─────────────────────────────────────────────────────────────────────────────────────────

def _validated_id(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > MAX_ID_CHARS:
        raise ValidationError(f'{name} must be a non-empty string of at most {MAX_ID_CHARS} characters')
    return value


def validated_pack_request(body: Mapping[str, Any]) -> tuple[list[str], str, int]:
    """``(persona_ids, question, limit)`` of ``POST …/personas/evidence-pack``, or a 400.

    ``persona_ids``: 1 to ``MAX_PACK_PERSONAS`` ids, duplicates dropped in order; ``question``: optional text the
    fresh reviews are ranked against (at most 2,000 characters); ``limit``: fresh reviews per persona, 0 to
    ``MAX_FRESH`` (default ``MAX_FRESH``).
    """
    raw_ids = body.get('persona_ids')
    if not isinstance(raw_ids, list) or not 1 <= len(raw_ids) <= MAX_PACK_PERSONAS:
        raise ValidationError(f'persona_ids must be a list of 1 to {MAX_PACK_PERSONAS} persona ids')
    persona_ids = list(dict.fromkeys(_validated_id(value, 'Each persona id') for value in raw_ids))
    question = body.get('question', '')
    if not isinstance(question, str) or len(question) > MAX_QUESTION_CHARS:
        raise ValidationError(f'question must be a string of at most {MAX_QUESTION_CHARS} characters')
    limit = body.get('limit', MAX_FRESH)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= MAX_FRESH:
        raise ValidationError(f'limit must be a whole number from 0 to {MAX_FRESH}')
    return persona_ids, question.strip(), limit


# ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────

def _persona_key(project_id: str, persona_id: str) -> dict[str, str]:
    return {'pk': project_pk(project_id), 'sk': f'PERSONA#{persona_id}'}


def _stored_persona(reader: Reader, project_id: str, persona_id: str) -> dict | None:
    item = reader.projects_table.get_item(Key=_persona_key(project_id, persona_id), ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else None


def _project_filters(reader: Reader, project_id: str) -> dict[str, list[str]]:
    """The project's own feedback filters (``META.filters``): lists of strings only, anything else read as none."""
    meta = reader.projects_table.get_item(
        Key={'pk': project_pk(project_id), 'sk': 'META'}, ProjectionExpression='filters',
    ).get('Item') or {}
    stored = meta.get('filters')
    filters: Mapping[str, Any] = stored if isinstance(stored, Mapping) else {}
    return {
        name: [value for value in values if isinstance(value, str) and value]
        for name in ('sources', 'categories', 'sentiments')
        if isinstance(values := filters.get(name), list)
    }


def evidence_update_entries(row: Mapping[str, Any]) -> list[dict[str, Any]]:
    """A persona's evidence refreshes (``evidence_updates``), the entries that are maps (the lineage pass reads them)."""
    entries = row.get(EVIDENCE_UPDATES_FIELD)
    return [dict(entry) for entry in entries if isinstance(entry, Mapping)] if isinstance(entries, list) else []


def _stored_ids(persona: Mapping[str, Any]) -> list[tuple[str, str]]:
    """``(feedback_id, origin)`` of the persona's stored evidence: refreshed (newest first), then cited."""
    cited = [(one, ORIGIN_CITED) for one in listed_ids(persona.get(EVIDENCE_FEEDBACK_IDS_FIELD))]
    refreshed = [(one, ORIGIN_REFRESHED)
                 for entry in reversed(evidence_update_entries(persona)) for one in listed_ids(entry.get('feedback_ids'))]
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for feedback_id, origin in [*refreshed, *cited]:
        if feedback_id not in seen:
            seen.add(feedback_id)
            out.append((feedback_id, origin))
    return out


def _row_by_id(reader: Reader, feedback_id: str) -> dict | None:
    """One review by id (the deployment's ``gsi4-by-feedback-id``), whoever may see it: callers decide. Read once a
    request."""
    if feedback_id in reader.rows:
        return reader.rows[feedback_id]
    rows = reader.feedback_table.query(
        IndexName=FEEDBACK_BY_ID_INDEX, Limit=1,
        KeyConditionExpression=Key(FEEDBACK_ID_INDEX_PARTITION).eq(feedback_id_partition(None, feedback_id)),
    ).get('Items') or []
    row = rows[0] if rows else None
    reader.rows[feedback_id] = row if isinstance(row, dict) else None
    return reader.rows[feedback_id]


def _by_id(reader: Reader, feedback_id: str) -> dict | None:
    """One review by id, when the person may see it and it is a customer's (else None, as for an erased one: never
    the VoC app's own micro-feedback, shared/item_filters.py)."""
    row = _row_by_id(reader, feedback_id)
    admitted = row is not None and category_access.admits_item(reader.scope, row) and NO_ITEM_FILTERS.admits(row)
    return row if admitted else None


def _persona_categories(reader: Reader, persona: Mapping[str, Any]) -> list[str]:
    """The categories of the reviews the persona cites (else of those it was written from), most frequent first.

    A property of the persona, not of the person asking, so it is read whatever their scope: only the names are kept,
    never answered, and every review matched on them is admitted by the scope (``_Match.admits``). A person who
    cannot see the persona's categories gets no fresh review, never another category's instead.
    """
    sample = listed_ids(persona.get(EVIDENCE_FEEDBACK_IDS_FIELD)) or listed_ids(persona.get('input_feedback_ids'))
    counts = Counter(category_access.item_category(row) for one in sample[:MAX_CATEGORY_SAMPLE]
                     if (row := _row_by_id(reader, one)) is not None)
    return [name for name, _ in counts.most_common(MAX_PERSONA_CATEGORIES)]


def _since(persona: Mapping[str, Any]) -> str:
    """The persona's generation time ('' when it has none: the oldest window)."""
    value = persona.get('created_at')
    return value if isinstance(value, str) else ''


def _held_ids(persona: Mapping[str, Any]) -> set[str]:
    """Every review the persona already holds: its evidence (cited, refreshed) and the reviews it was written from."""
    return {one for one, _ in _stored_ids(persona)} | set(listed_ids(persona.get('input_feedback_ids')))


@dataclass(frozen=True)
class _Match:
    """What a fresh review must be: in these categories and sources and sentiments (empty: any), on or after ``day``."""

    categories: frozenset[str]
    sources: frozenset[str]
    sentiments: frozenset[str]
    day: str

    def admits(self, row: Mapping[str, Any], scope: CategoryScope) -> bool:
        return (
            basis_date(row, DATE_BASIS_IMPORTED) >= self.day
            and (not self.categories or category_access.item_category(row) in self.categories)
            and (not self.sources or row.get('source_platform') in self.sources)
            and (not self.sentiments or row.get('sentiment_label') in self.sentiments)
            and category_access.admits_item(scope, row)
            # (never the VoC app's own micro-feedback: no customer's evidence, shared/item_filters.py)
            and NO_ITEM_FILTERS.admits(row)
        )


def _match_for(reader: Reader, persona: Mapping[str, Any], filters: Mapping[str, list[str]], since: str) -> _Match:
    """The persona's categories within the project's filters, from ``since`` (at most ``MAX_FRESH_DAYS`` back)."""
    floor = (reader.today() - timedelta(days=MAX_FRESH_DAYS - 1)).strftime('%Y-%m-%d')
    own = _persona_categories(reader, persona)
    project = set(filters.get('categories') or [])
    categories = [name for name in own if name in project] if project and own else own or sorted(project)
    if project and own and not categories:
        # The persona's categories are all outside the project's filters: the filters are the floor.
        categories = sorted(project)
    return _Match(categories=frozenset(categories), sources=frozenset(filters.get('sources') or []),
                  sentiments=frozenset(filters.get('sentiments') or []), day=max(since[:10], floor))


def _days(reader: Reader, first_day: str) -> Iterator[str]:
    """Every day from today back to ``first_day``, newest first."""
    today = reader.today()
    for back in range(MAX_FRESH_DAYS):
        day = (today - timedelta(days=back)).strftime('%Y-%m-%d')
        if day < first_day:
            return
        yield day


@dataclass(frozen=True)
class _Fresh:
    rows: list[dict]
    capped: bool


def _fresh_rows(reader: Reader, match: _Match, skip: set[str], budget: WalkBudget, *, stop_after: int = 0) -> _Fresh:
    """The matching reviews since ``match.day`` (projected), newest day first, without the ids in ``skip``.

    ``stop_after`` (0: never) ends the walk once that many matched: a pack needs its newest candidates only, a count
    needs them all.
    """
    partitions = (Partition(FEEDBACK_BY_DATE_INDEX, Key('gsi1pk').eq(date_partition(None, day)), dated=True)
                  for day in _days(reader, match.day))
    pool = read_pool(reader.feedback_table, partitions, budget=budget, stop_after=stop_after,
                     admit=lambda row: match.admits(row, reader.scope) and row.get('feedback_id') not in skip)
    return _Fresh(rows=pool.rows, capped=pool.capped)


def _ranked(items: Sequence[dict], question: str, limit: int) -> list[dict]:
    """The ``limit`` items sharing the most words with ``question``, the newest first among equals: the similarity
    ranker's tokens (shared/feedback_similarity.py: its stop list, over a review's title, summary and text)."""
    asked = tokens(question)
    newest = sorted(items, key=lambda item: basis_date(item, DATE_BASIS_IMPORTED), reverse=True)
    return sorted(newest, key=lambda item: len(asked & item_tokens(item)), reverse=True)[:limit]


def _quote(item: Mapping[str, Any]) -> dict[str, Any]:
    """One review as a pack holds it: its id, the stored text (clipped, screened) and what it is about."""
    text = clip_words(str(item.get('original_text') or ''), MAX_QUOTE_CHARS)
    return {
        'feedback_id': str(item.get('feedback_id')),
        'text': WITHHELD if injection_findings(text) else text,
        # A summary-only source stores the model's summary, never the customer's words.
        'verbatim': item.get('pii_policy') != PII_SUMMARY_ONLY,
        'source_platform': str(item.get('source_platform') or 'unknown'),
        'category': category_access.item_category(item),
        'sentiment_label': str(item.get('sentiment_label') or 'unknown'),
        'date': str(item.get('source_created_at') or item.get('date') or '')[:10],
    }


def _fresh_items(reader: Reader, match: _Match, skip: set[str], question: str, limit: int,
                 budget: WalkBudget) -> tuple[list[dict], bool]:
    """The ``limit`` best fresh reviews in full, and whether the read was cut short."""
    if limit == 0:
        return [], False
    fresh = _fresh_rows(reader, match, skip, budget, stop_after=MAX_FRESH_CANDIDATES)
    candidates = fetch_full(reader.feedback_table, fresh.rows[:MAX_FRESH_CANDIDATES])
    # Re-checked on the full items: a review re-categorised since the (eventually consistent) index read.
    admitted = [item for item in candidates if match.admits(item, reader.scope)]
    return _ranked(admitted, question, limit), fresh.capped


def _persona_pack(reader: Reader, project_id: str, persona: Mapping[str, Any], filters: Mapping[str, list[str]],
                  question: str, limit: int, budget: WalkBudget) -> dict[str, Any]:
    stored: list[dict[str, Any]] = []
    for feedback_id, origin in _stored_ids(persona)[:MAX_STORED_EXAMINED]:
        # The pack's one budget bounds these reads too (a later persona then gets fewer, never a slow answer).
        if len(stored) >= MAX_STORED_EVIDENCE or budget.exhausted():
            break
        row = _by_id(reader, feedback_id)
        if row is not None:
            stored.append({**_quote(row), 'origin': origin})
    match = _match_for(reader, persona, filters, _since(persona))
    fresh, capped = _fresh_items(reader, match, _held_ids(persona), question, limit, budget)
    logger.info('Persona evidence pack read', extra={
        'project_id': project_id, 'stored': len(stored), 'fresh': len(fresh), 'capped': capped})
    return {
        'persona_id': persona['persona_id'],
        'name': str(persona.get('name') or ''),
        'evidence': [*stored, *({**_quote(item), 'origin': ORIGIN_FRESH} for item in fresh)],
        'fresh_since': match.day,
        'fresh_capped': capped,
    }


def visible_ids(reader: Reader, feedback_ids: Sequence[str]) -> list[str]:
    """The ``feedback_ids`` that name a review the person may see, in order, each once (a saved focus group's lineage:
    never an id they could not open)."""
    return [one for one in dict.fromkeys(feedback_ids) if _by_id(reader, one) is not None]


def evidence_pack(reader: Reader, project_id: str, persona_ids: Sequence[str], question: str, limit: int, *,
                  workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    """``{personas: [...], missing_persona_ids}``: each persona's stored and fresh evidence, as the person may see it.

    The personas come back in request order; an id the project does not have is in ``missing_persona_ids``. One walk
    budget covers the whole pack, so a pack of six personas answers within it (``fresh_capped`` says when a persona's
    fresh read was cut short).
    """
    require_deployment(workspace, PROJECT_GATE_STORE)
    filters = _project_filters(reader, project_id)
    budget = WalkBudget(seconds=WALK_SECONDS)
    personas: list[dict[str, Any]] = []
    missing: list[str] = []
    for persona_id in persona_ids:
        persona = _stored_persona(reader, project_id, persona_id)
        if persona is None:
            missing.append(persona_id)
            continue
        personas.append(_persona_pack(reader, project_id, persona, filters, question, limit, budget))
    return {'personas': personas, 'missing_persona_ids': missing, 'limit': limit}


def _required_persona(reader: Reader, project_id: str, persona_id: str) -> dict:
    persona = _stored_persona(reader, project_id, persona_id)
    if persona is None:
        raise NotFoundError('Persona not found')
    return persona


def _new_matches(reader: Reader, project_id: str, persona_id: str,
                 workspace: WorkspaceScope | None) -> tuple[dict, _Match, _Fresh]:
    """The persona (or a 404), its match, and the matching reviews since its generation that it does not hold yet."""
    require_deployment(workspace, PROJECT_GATE_STORE)
    persona = _required_persona(reader, project_id, persona_id)
    match = _match_for(reader, persona, _project_filters(reader, project_id), _since(persona))
    return persona, match, _fresh_rows(reader, match, _held_ids(persona), WalkBudget(seconds=WALK_SECONDS))


def evidence_freshness(reader: Reader, project_id: str, persona_id: str, *,
                       workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    """``GET …/personas/{pid}/evidence-freshness``: how many matching reviews arrived since the persona was generated
    that it does not hold yet, of those the person may see (``count_is_lower_bound`` when the read was cut)."""
    persona, match, fresh = _new_matches(reader, project_id, persona_id, workspace)
    return {
        'persona_id': persona_id,
        'since': match.day,
        'count': len(fresh.rows),
        'count_is_lower_bound': fresh.capped,
        'refreshed_at': persona.get(EVIDENCE_REFRESHED_AT_FIELD),
        'updates': len(evidence_update_entries(persona)),
    }


def _appended(entries: Iterable[dict[str, Any]], entry: dict[str, Any]) -> list[dict[str, Any]]:
    return [*entries, entry][-MAX_EVIDENCE_UPDATES:]


def refresh_evidence(reader: Reader, project_id: str, persona_id: str, actor: Mapping[str, str], *,
                     workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    """``POST …/personas/{pid}/evidence/refresh``: append the newest matching reviews to the persona's evidence.

    The ``MAX_FRESH`` newest matching reviews since the generation that the persona does not hold yet and the person
    may see join ``evidence_updates`` as one entry with its actor, time and reason; the persona's text is never
    touched. Nothing new is no write (``added: 0``). A persona changed meanwhile (another refresh, or a regeneration
    under the same key) is a 409: nothing is written.
    """
    persona, _match, fresh = _new_matches(reader, project_id, persona_id, workspace)
    ids = [str(row['feedback_id']) for row in fresh.rows[:MAX_FRESH] if isinstance(row.get('feedback_id'), str)]
    previous = evidence_update_entries(persona)
    if not ids:
        return {'persona_id': persona_id, 'added': 0, EVIDENCE_UPDATES_FIELD: previous,
                EVIDENCE_REFRESHED_AT_FIELD: persona.get(EVIDENCE_REFRESHED_AT_FIELD)}
    at = now_iso()
    entry = {'at': at, 'by': {'sub': actor.get('sub', ''), 'kind': actor.get('kind', 'user')},
             'reason': REFRESH_REASON, 'feedback_ids': ids}
    updates = _appended(previous, entry)
    stored = persona.get(EVIDENCE_UPDATES_FIELD)
    created = persona.get('created_at')
    unchanged = 'attribute_not_exists(#evidence_updates)' if stored is None else '#evidence_updates = :previous'
    same = '#created_at = :created' if isinstance(created, str) else 'attribute_not_exists(#created_at)'
    try:
        reader.projects_table.update_item(
            Key=_persona_key(project_id, persona_id),
            # The placeholders are the attributes' own names, so the export's static view reads them as stored.
            UpdateExpression='SET #evidence_updates = :updates, #evidence_refreshed_at = :at',
            # The same persona as read (its generation time) and the same refreshes: else another write came between.
            ConditionExpression=f'attribute_exists(sk) AND {same} AND {unchanged}',
            ExpressionAttributeNames={'#evidence_updates': EVIDENCE_UPDATES_FIELD,
                                      '#evidence_refreshed_at': EVIDENCE_REFRESHED_AT_FIELD, '#created_at': 'created_at'},
            ExpressionAttributeValues={':updates': updates, ':at': at,
                                       **({':created': created} if isinstance(created, str) else {}),
                                       **({} if stored is None else {':previous': stored})},
        )
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            raise ConflictError('The persona changed while its evidence was refreshed. Try again.') from exc
        raise
    logger.info('Persona evidence refreshed', extra={
        'project_id': project_id, 'persona_id': persona_id, 'added': len(ids), 'entries': len(updates)})
    return {'persona_id': persona_id, 'added': len(ids), EVIDENCE_UPDATES_FIELD: updates,
            EVIDENCE_REFRESHED_AT_FIELD: at}
