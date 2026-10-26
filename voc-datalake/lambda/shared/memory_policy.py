"""
Memory policy — PURE (no AWS clients, no clock reads unless passed ``now``).

Every decision about what a memory may become lives here so the extractor, the
import path and the API reach the same answer from the same inputs:

* vocabulary (scopes, statuses, kinds, retention) and bounds;
* statement hygiene: prompt-injection screening, profanity / judgment-about-people
  rejection, personal-data redaction, review-quote stripping for restricted sources;
* company-vs-personal classification (the owner's rule, see ``classify_scope``);
* KiroCrew write rules: the confidence gate, dedup, contradiction, tombstones,
  "user-explicit beats automated" (``decide_automated_write``);
* the retrieval score and the daily retention decision;
* the suggested resolution shown in the review queue.
"""

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Final

# ── Vocabulary ───────────────────────────────────────────────────────────────
SCOPE_COMPANY: Final = 'company'
SCOPE_PERSONAL: Final = 'personal'
SCOPES: Final = (SCOPE_COMPANY, SCOPE_PERSONAL)

STATUS_ACTIVE: Final = 'active'
STATUS_PROPOSED: Final = 'proposed'
STATUS_CONFLICT: Final = 'conflict'
STATUS_ARCHIVED: Final = 'archived'
STATUSES: Final = (STATUS_ACTIVE, STATUS_PROPOSED, STATUS_CONFLICT, STATUS_ARCHIVED)

KINDS: Final = ('product', 'customer', 'agents', 'working_style', 'strategy', 'objective', 'other')
# Product / customer knowledge is ALWAYS company knowledge (owner rule, §4.1 Q6).
COMPANY_KINDS: Final = frozenset({'product', 'customer'})

RETENTION_LONG_TERM: Final = 'long_term'
RETENTION_DATED: Final = 'dated'
RETENTION_DECAY: Final = 'decay'
RETENTIONS: Final = (RETENTION_LONG_TERM, RETENTION_DATED, RETENTION_DECAY)

SOURCE_EXTRACTED: Final = 'extracted'
SOURCE_USER_EXPLICIT: Final = 'user_explicit'
SOURCE_IMPORT: Final = 'import'
SOURCE_AGENT: Final = 'agent'
AUTOMATED_SOURCES: Final = frozenset({SOURCE_EXTRACTED, SOURCE_IMPORT, SOURCE_AGENT})

# ── Bounds and thresholds ────────────────────────────────────────────────────
MAX_STATEMENT_CHARS: Final = 500
MIN_STATEMENT_CHARS: Final = 8
MAX_CATEGORIES_PER_MEMORY: Final = 10
MAX_SOURCES_KEPT: Final = 20
AUTO_CONFIDENCE_MIN: Final = 0.8        # KiroCrew: automated writes need ≥ 0.8
PROPOSE_CONFIDENCE_MIN: Final = 0.5     # below this even a company candidate is noise
DEDUP_COSINE: Final = 0.86              # same meaning within a scope → +1 supporter
RELATED_COSINE: Final = 0.6             # close enough to ask the model "same/contradicts?"
ALIGNMENT_COSINE: Final = 0.55          # memory ↔ company objective alignment
ALIGNMENT_BOOST: Final = 1.2
RECENCY_DECAY_RATE: Final = 0.01        # per day
DECAY_RETENTION_DAYS: Final = 90
DEFAULT_TOP_K: Final = 8
MAX_TOP_K: Final = 20
RELATION_SAME: Final = 'same'
RELATION_CONTRADICTS: Final = 'contradicts'
RELATION_UNRELATED: Final = 'unrelated'
RELATIONS: Final = (RELATION_SAME, RELATION_CONTRADICTS, RELATION_UNRELATED)

# ── Statement hygiene ────────────────────────────────────────────────────────
# Instruction-shaped text: a memory is replayed into future prompts (as DATA), so
# a statement that tries to steer the model is refused at write time rather than
# trusted to the fence later. Deliberately broad — a false positive costs one
# memory, a false negative is a persistent injection.
_INJECTION_PATTERNS: Final = tuple(re.compile(p, re.IGNORECASE) for p in (
    r'\bignore\b.{0,40}\b(instruction|prompt|rule|previous|above|prior)',
    r'\bdisregard\b.{0,40}\b(instruction|prompt|rule|previous|above|prior)',
    r'\bforget\b.{0,30}\b(instruction|prompt|rules)',
    r'\b(system|developer)\s*(prompt|message|instruction)',
    r'\byou\s+are\s+now\b',
    r'\bact\s+as\b.{0,30}\b(admin|system|developer|jailbr)',
    r'\b(always|must|should)\s+(respond|reply|answer|say|output|call|invoke|run)\b.{0,40}\b(tool|function|command)',
    r'\bnew\s+instructions?\b',
    r'\bjailbreak',
    r'</?\s*(system|assistant|user|memory|company_context|design_system|instructions?)\s*>',
    r'<<<|>>>',
    r'\[\s*sent by conductor\s*\]',
    r'<\s*script\b',
    r'\bBEGIN\s+UNTRUSTED\b',
))

_PROFANITY: Final = frozenset({
    'fuck', 'fucking', 'fucked', 'shit', 'shitty', 'bullshit', 'bitch', 'bastard', 'asshole', 'dick',
    'crap', 'damn', 'goddamn', 'piss', 'pissed', 'wtf', 'cunt', 'motherfucker',
})
_PROFANITY_RE: Final = re.compile(r"[a-z']+")

# Judgments about people: "X is stupid", "the PM is useless". Refused outright —
# no rewording rescues them, and they are exactly what the owner said to drop.
_PERSON_JUDGMENT_RE: Final = re.compile(
    r'\b(is|are|was|were|being|seems?|so)\s+(an?\s+)?(stupid|idiot|idiots|dumb|moron|morons|useless|incompetent|'
    r'lazy|clueless|pathetic|worthless|annoying|terrible\s+person|jerk|fool|fools)\b'
    r'|\b(idiot|moron|imbecile|loser)s?\b',
    re.IGNORECASE,
)

_EMAIL_RE: Final = re.compile(r'[\w.+-]+@[\w-]+(\.[\w-]+)+')
_PHONE_CANDIDATE_RE: Final = re.compile(r'(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)')
_ISO_DATE_RE: Final = re.compile(r'\d{4}-\d{2}-\d{2}')
# A phone number has at least 9 digits; fewer is a date, a version or an amount.
_PHONE_MIN_DIGITS: Final = 9
_SECRETISH_RE: Final = re.compile(r'\b(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,})\b')
_REDACTED: Final = '[redacted]'
# A quotation of 6+ words: for a restricted-category source the gist may travel,
# the customer's words may not (§0 M7).
_LONG_QUOTE_RE: Final = re.compile(r'["“”«»]([^"“”«»]{0,400}?)["“”«»]')
_QUOTE_MIN_WORDS: Final = 6
_WS_RE: Final = re.compile(r'\s+')

# First-person-singular preference phrasing: specific to one user (owner rule).
_PERSONAL_PHRASING_RE: Final = re.compile(
    r"^\s*(i|i'm|i am|i'd|my|me)\b|\b(i (like|prefer|want|need|hate|love|usually|always|never))\b",
    re.IGNORECASE,
)
# Working style is company-wide only when phrased about the team.
_TEAM_PHRASING_RE: Final = re.compile(r'\b(we|our|team|everyone)\b', re.IGNORECASE)


def screen_injection(text: str) -> bool:
    """True when ``text`` reads like an instruction aimed at a model."""
    return any(p.search(text) for p in _INJECTION_PATTERNS)


def contains_profanity(text: str) -> bool:
    return any(word in _PROFANITY for word in _PROFANITY_RE.findall(text.lower()))


def judges_a_person(text: str) -> bool:
    return bool(_PERSON_JUDGMENT_RE.search(text))


def redact_personal_data(text: str) -> str:
    """Replace emails, phone numbers and credential-shaped tokens with ``[redacted]``."""
    text = _EMAIL_RE.sub(_REDACTED, text)
    text = _SECRETISH_RE.sub(_REDACTED, text)
    return _PHONE_CANDIDATE_RE.sub(_redact_phone, text)


def _redact_phone(match: re.Match) -> str:
    candidate = match.group(0)
    digits = sum(ch.isdigit() for ch in candidate)
    if digits < _PHONE_MIN_DIGITS or _ISO_DATE_RE.search(candidate):
        return candidate
    return _REDACTED


def strip_long_quotes(text: str) -> str:
    """Drop quotations of six words or more (keeps the gist, not the words)."""
    def _replace(match: re.Match) -> str:
        inner = match.group(1)
        return '' if len(inner.split()) >= _QUOTE_MIN_WORDS else match.group(0)
    return _LONG_QUOTE_RE.sub(_replace, text)


@dataclass(frozen=True)
class CleanResult:
    """A cleaned statement, or the reason it was refused (``statement`` None)."""

    statement: str | None
    reason: str | None = None


def clean_statement(raw: object, *, restricted_source: bool = False) -> CleanResult:
    """Normalise a candidate statement or refuse it.

    Refusals (``reason``): ``not_text``, ``injection``, ``profanity``,
    ``judgment``, ``too_short``. Personal data is redacted rather than refused;
    a statement that is nothing BUT personal data ends up ``too_short``.
    """
    if not isinstance(raw, str):
        return CleanResult(None, 'not_text')
    text = _WS_RE.sub(' ', raw).strip()
    if screen_injection(text):
        return CleanResult(None, 'injection')
    if contains_profanity(text):
        return CleanResult(None, 'profanity')
    if judges_a_person(text):
        return CleanResult(None, 'judgment')
    text = redact_personal_data(text)
    if restricted_source:
        text = _WS_RE.sub(' ', strip_long_quotes(text)).strip()
    text = text[:MAX_STATEMENT_CHARS].strip()
    meaningful = text.replace(_REDACTED, '').strip(' .,;:-')
    if len(meaningful) < MIN_STATEMENT_CHARS:
        return CleanResult(None, 'too_short')
    return CleanResult(text)


# ── Classification ───────────────────────────────────────────────────────────
def normalise_kind(value: object) -> str:
    return value if isinstance(value, str) and value in KINDS else 'other'


def classify_scope(statement: str, kind: str, suggested: object) -> str:
    """Company or personal, per the owner's rule (§4.1 Q6).

    * product / customer knowledge → company, always ("Our customer demonstrated
      they xx and xx" → company);
    * a first-person preference about how the assistant should work → personal
      ("I like you to reply in short" → personal);
    * working style defaults to personal unless the model judged it company-wide;
    * otherwise the model's suggestion, defaulting to personal — "be very careful
      what goes company-wide".
    """
    if kind in COMPANY_KINDS:
        return SCOPE_COMPANY
    if _PERSONAL_PHRASING_RE.search(statement) or suggested != SCOPE_COMPANY:
        return SCOPE_PERSONAL
    if kind == 'working_style' and not _TEAM_PHRASING_RE.search(statement):
        return SCOPE_PERSONAL
    return SCOPE_COMPANY


def parse_confidence(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    if math.isnan(value):
        return 0.0
    return max(0.0, min(float(value), 1.0))


def parse_iso_date(value: object) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def quarter_end(day: date) -> date:
    """The last day of ``day``'s calendar quarter."""
    if day.month >= 10:
        return date(day.year, 12, 31)
    first_month_next = ((day.month - 1) // 3 + 1) * 3 + 1
    return date(day.year, first_month_next, 1) - timedelta(days=1)


def resolve_retention(kind: str, suggested: object, expires_at: object, today: date) -> tuple[str, str | None]:
    """``(retention, expires_at ISO date | None)``.

    A ``dated`` memory needs a future expiry: an objective without one expires at
    the end of the current quarter; anything else without one decays instead.
    Strategy/vision defaults to long-term, everything else to decay.
    """
    expiry = parse_iso_date(expires_at)
    retention = suggested if isinstance(suggested, str) and suggested in RETENTIONS else None
    if retention is None:
        retention = RETENTION_LONG_TERM if kind == 'strategy' else RETENTION_DECAY
        if kind == 'objective' or expiry is not None:
            retention = RETENTION_DATED
    if retention == RETENTION_DATED:
        if expiry is None and kind == 'objective':
            expiry = quarter_end(today)
        if expiry is None or expiry <= today:
            return RETENTION_DECAY, None
        return RETENTION_DATED, expiry.isoformat()
    return retention, None


def normalise_categories(value: object, known: frozenset[str] | None = None) -> list[str]:
    if not isinstance(value, list):
        return []
    names = []
    for entry in value:
        if isinstance(entry, str) and entry.strip() and (known is None or entry.strip() in known):
            name = entry.strip()[:100]
            if name not in names:
                names.append(name)
    return names[:MAX_CATEGORIES_PER_MEMORY]


# ── KiroCrew write rules ─────────────────────────────────────────────────────
GATE_WRITE: Final = 'write'
GATE_PROPOSE: Final = 'propose'
GATE_DROP: Final = 'drop'


def confidence_gate(confidence: float, scope: str) -> str:
    """Automated writes: ≥ 0.8 live; a company-relevant lower one is proposed; else dropped."""
    if confidence >= AUTO_CONFIDENCE_MIN:
        return GATE_WRITE
    if scope == SCOPE_COMPANY and confidence >= PROPOSE_CONFIDENCE_MIN:
        return GATE_PROPOSE
    return GATE_DROP


@dataclass(frozen=True)
class Neighbour:
    """An existing memory near a candidate, with the judged relation."""

    memory: Mapping[str, Any]
    cosine: float
    relation: str = RELATION_UNRELATED


ACTION_INSERT: Final = 'insert'
ACTION_REINFORCE: Final = 'reinforce'
ACTION_DROP: Final = 'drop'


@dataclass(frozen=True)
class WriteDecision:
    """What to do with one automated candidate.

    ``action``: insert (with ``status``), reinforce (``target_id``) or drop.
    ``conflicts_with``: ids to link both ways on insert.
    """

    action: str
    status: str | None = None
    target_id: str | None = None
    conflicts_with: tuple[str, ...] = ()
    reason: str = ''


def _is_same(neighbour: Neighbour) -> bool:
    if neighbour.relation == RELATION_CONTRADICTS:
        return False
    return neighbour.relation == RELATION_SAME or neighbour.cosine >= DEDUP_COSINE


def decide_automated_write(gate: str, neighbours: list[Neighbour]) -> WriteDecision:
    """Apply KiroCrew's rules to an automated candidate that passed hygiene.

    Order matters and mirrors the spec:
    1. dropped by the confidence gate → drop;
    2. matches a TOMBSTONED (forgotten) memory → never recreated: ``proposed``;
    3. matches a live memory → reinforce it (+1 supporter, refresh);
       an archived one that was merged → reinforce the merge target;
       an archived one that simply expired → reinforce (revives it);
    4. contradicts live memories → insert as ``conflict``, linked (both kept);
    5. otherwise insert ``active`` (or ``proposed`` from the gate).
    """
    if gate == GATE_DROP:
        return WriteDecision(ACTION_DROP, reason='low_confidence')
    ordered = sorted(neighbours, key=lambda n: n.cosine, reverse=True)
    for neighbour in ordered:
        if not _is_same(neighbour):
            continue
        memory = neighbour.memory
        if memory.get('tombstoned'):
            return WriteDecision(ACTION_INSERT, status=STATUS_PROPOSED, reason='matches_forgotten')
        merged_into = memory.get('merged_into')
        if isinstance(merged_into, str) and merged_into:
            return WriteDecision(ACTION_REINFORCE, target_id=merged_into, reason='matches_merged')
        return WriteDecision(ACTION_REINFORCE, target_id=str(memory.get('memory_id')), reason='duplicate')
    contradicted = tuple(
        str(n.memory.get('memory_id')) for n in ordered
        if n.relation == RELATION_CONTRADICTS
        and n.memory.get('status') in (STATUS_ACTIVE, STATUS_CONFLICT, STATUS_PROPOSED)
        and not n.memory.get('tombstoned')
    )
    if contradicted:
        return WriteDecision(ACTION_INSERT, status=STATUS_CONFLICT, conflicts_with=contradicted,
                             reason='contradiction')
    status = STATUS_ACTIVE if gate == GATE_WRITE else STATUS_PROPOSED
    return WriteDecision(ACTION_INSERT, status=status, reason='new')


def explicit_status(scope: str, may_curate_company: bool) -> str:
    """Status of a user-explicit write: company needs a curator, else proposed."""
    if scope == SCOPE_COMPANY and not may_curate_company:
        return STATUS_PROPOSED
    return STATUS_ACTIVE


# ── Retrieval and retention ──────────────────────────────────────────────────
def parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float, str, bytes, Decimal)):
        return 0
    try:
        return int(value)  # Decimal from DynamoDB
    except (TypeError, ValueError):
        return 0


def last_touched(memory: Mapping[str, Any]) -> datetime | None:
    """The latest of last_reinforced_at / last_used_at / created_at."""
    stamps = [parse_datetime(memory.get(k)) for k in ('last_reinforced_at', 'last_used_at', 'created_at')]
    known = [s for s in stamps if s is not None]
    return max(known) if known else None


def days_since_touched(memory: Mapping[str, Any], now: datetime) -> float:
    touched = last_touched(memory)
    if touched is None:
        return float(DECAY_RETENTION_DAYS)
    return max((now - touched).total_seconds() / 86400.0, 0.0)


def retrieval_score(cosine: float, supporters: int, days: float, aligned: bool) -> float:
    """``cosine * (1 + ln(1+supporters)) * exp(-0.01 * days) * (1.2 if aligned)``."""
    score = cosine * (1.0 + math.log1p(max(supporters, 0))) * math.exp(-RECENCY_DECAY_RATE * max(days, 0.0))
    return score * ALIGNMENT_BOOST if aligned else score


def score_memory(memory: Mapping[str, Any], cosine: float, now: datetime) -> float:
    return retrieval_score(
        cosine, _int(memory.get('supporters')), days_since_touched(memory, now),
        bool(memory.get('aligned_objective_ids')),
    )


def clamp_top_k(value: object) -> int:
    k = _int(value) if value is not None else DEFAULT_TOP_K
    return max(1, min(k or DEFAULT_TOP_K, MAX_TOP_K))


def should_archive(memory: Mapping[str, Any], now: datetime) -> str | None:
    """The retention reason to archive ``memory`` now, or None to keep it.

    ``decay``: untouched (no +1 / use / confirm) for 90 days. ``dated``: past
    ``expires_at`` (a dated item missing a valid expiry falls back to decay).
    ``long_term``: never. Already-archived items are left alone.
    """
    if memory.get('status') == STATUS_ARCHIVED:
        return None
    retention = memory.get('retention')
    if retention == RETENTION_LONG_TERM:
        return None
    if retention == RETENTION_DATED:
        expiry = parse_iso_date(memory.get('expires_at'))
        if expiry is not None:
            return 'expired' if now.date() > expiry else None
    return 'decayed' if days_since_touched(memory, now) >= DECAY_RETENTION_DAYS else None


# ── Imports ──────────────────────────────────────────────────────────────────
MAX_IMPORT_CHARS: Final = 200_000
IMPORT_CHUNK_CHARS: Final = 12_000


def chunk_text(text: str, size: int = IMPORT_CHUNK_CHARS) -> list[str]:
    """Split ``text`` into ≤ ``size``-char chunks on paragraph, then line, then hard bounds.

    Deterministic, so a re-delivered "process chunk i" message always sees the
    same chunk i.
    """
    chunks: list[str] = []
    group: list[str] = []
    for paragraph in re.split(r'\n\s*\n', text):
        piece = paragraph.strip()
        if not piece:
            continue
        while len(piece) > size:
            cut = piece[:size].rfind('\n')
            cut = cut if 2 * cut > size else size
            if group:
                _flush(chunks, group)
            chunks.append(piece[:cut].strip())
            piece = piece[cut:].strip()
        if group and len('\n\n'.join(group)) + 2 + len(piece) > size:
            _flush(chunks, group)
        group.append(piece)
    if group:
        _flush(chunks, group)
    return chunks


def _flush(chunks: list[str], group: list[str]) -> None:
    """Close the pending paragraphs as one chunk and start an empty group."""
    chunks.append('\n\n'.join(group))
    group.clear()


# ── Review queue ─────────────────────────────────────────────────────────────
RESOLVE_ACTIONS: Final = ('keep_both', 'keep', 'replace', 'merge')


def suggest_resolution(item: Mapping[str, Any], linked: list[Mapping[str, Any]]) -> dict[str, Any]:
    """A suggested action for one review entry, with the reasoning shown to a human.

    * proposed with no conflict → keep it (accept);
    * a user-explicit side beats automated sides;
    * otherwise the side with clearly more supporters (at least 2x) wins;
    * else objective alignment breaks the tie;
    * else merge (the humans should combine them).
    """
    if not linked:
        return {'action': 'keep', 'winner_id': item.get('memory_id'),
                'reason': 'No conflicting memory; accepting makes it live.'}
    sides = [item, *linked]
    explicit = [s for s in sides if s.get('source_kind') == SOURCE_USER_EXPLICIT]
    if len(explicit) == 1:
        return {'action': 'keep', 'winner_id': explicit[0].get('memory_id'),
                'reason': 'A person stated this explicitly; explicit beats automated.'}
    ranked = sorted(sides, key=lambda s: _int(s.get('supporters')), reverse=True)
    top, runner = _int(ranked[0].get('supporters')), _int(ranked[1].get('supporters'))
    if top >= max(2 * runner, runner + 2):
        return {'action': 'keep', 'winner_id': ranked[0].get('memory_id'),
                'reason': f'{top} people support it versus {runner}.'}
    aligned = [s for s in sides if s.get('aligned_objective_ids')]
    if len(aligned) == 1:
        return {'action': 'keep', 'winner_id': aligned[0].get('memory_id'),
                'reason': 'Only this side aligns with a company objective.'}
    return {'action': 'merge', 'winner_id': None,
            'reason': 'Support is similar on both sides; combine them into one statement.'}
