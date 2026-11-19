"""The scheduled cross-run Learn pass's input and its figures (7.53.00): a flow's recent runs, read bounded, and what is
counted of them by rule, never by a model.

**What is read**, per flow, never a whole-bucket listing or a whole-table read (voc-engineering-runtime's role:
``CrossRunListsIndex`` and ``CrossRunReadsManifests``, beside the reads Learn holds already):

- the transcripts' index (runtime/manifest.py ``index_key``): its flows, one listing of ``ws/default/transcripts-index/``
  by ``/`` (at most ``MAX_FLOWS``); a flow's days of the last ``WINDOW_DAYS``, one listing by ``/`` that starts at the
  window's first day; then each day's entries, newest day first, one listing each, until ``MAX_RUNS`` runs. An entry's
  key names its run, so no entry is read;
- each run's first manifest (``ws/default/runs/<run>/_manifest/v0001.json``, the one its index entry names; a resumed
  run's later versions are not read): its status, tokens, cost and agents (role, flow step, status, cost, session
  time, model, skill, transcript prefix). A run whose manifest cannot be read is left out and counted (``unread``);
- its Learn records, in its own partition: the failures its retrospective took to the coach (``RETRO#coach``, one
  GetItem) and what came of each (``LEARNED#<key>``, one Query of at most ``MAX_LEARN_ROWS``);
- its newest gate records (at most ``MAX_GATES``, named by the manifest's outputs: this run's own
  ``…/_gate/attempt-<n>/record.json`` keys, never another run's), each checked against ``voc-gate-record/1``: the
  verdict, the stop reason, the rounds, the open blocking findings' titles and the final go's reasons.

Every text kept (a finding's title, a reason, the coach's outcome) is cut to one line and its credential-shaped strings
replaced here (``thread_items.one_line``: ``quality_gate.text.redact``); the prompt fences it as data again
(cross_run_answer.py).

**What is counted by rule** (``figures``: numbers, ids and keys only):

- the recurring failures: an attempt's failure as the retrospective named it (``no_go``, ``failed``, ``crashed``,
  ``timed_out``), else an agent's session that ended ``failed`` or ``reposted``, else a gate's NO-GO (the final go's
  role), by role and kind, in ``MIN_RECURRING`` runs or more, with those runs and the evidence's keys (the manifests,
  the failing agents' transcript prefixes, the gate records);
- each flow step's (an agent's role where its task named no step) session seconds and cost at p50 and p95 (nearest
  rank), and the cost outliers: runs, and agents of a step, at ``OUTLIER_FACTOR`` times their p50 or more;
- the convergence: the runs by status, the share done, the older half's and the newer half's, the failures a run;
- calibration figures, as ``npm run orchestration:calibrate`` makes them (the observed p95 times ``MARGIN``, rounded
  up): the flow's ``budget.run_token_cap``, ``budget.max_tasks`` and ``budget.max_cost_usd``, for a person to set.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_CEILING, Decimal
from typing import Any, Final, Protocol

from engineering.flow.ledger import FINAL_GO_ROLE, GATE_RECORD
from engineering.learning.loop import CHOSEN_SK
from engineering.quality_gate.record import GateRecord
from engineering.runtime.interface import RuntimeRefused, check_run_id
from engineering.runtime.manifest import MANIFEST_SCHEMA, NO_FLOW, manifest_key
from engineering.runtime.runs import run_pk
from engineering.thread_items import one_line
from engineering.workspace.layout import parse_agent_key
from shared.dynamo_values import json_count as _whole
from shared.logging import logger

#: The transcripts' index (runtime/manifest.py), whose first level is the flows.
INDEX_PREFIX: Final = 'ws/default/transcripts-index/'
#: How far back a pass reads (days, today's included), how many runs at most, and how many flows one schedule hands on.
WINDOW_DAYS: Final = 28
MAX_RUNS: Final = 50
MAX_FLOWS: Final = 100
#: A run's Learn outcome rows read at most (three failures a run take three; room for more).
MAX_LEARN_ROWS: Final = 20
#: A run's gate records read at most (its newest attempts), and the open blocking titles and reasons kept of each.
MAX_GATES: Final = 2
MAX_TITLES: Final = 5
TEXT_CHARS: Final = 200
#: What the coach's outcome and the lesson line keep of a ``LEARNED#`` row.
OUTCOME_CHARS: Final = 300
#: A run's agents a digest names at most (the prompt's bound; the figures count every one).
MAX_DIGEST_AGENTS: Final = 20
#: A failure recurs from this many runs; the recurring failures kept, each with its evidence's keys at most.
MIN_RECURRING: Final = 2
MAX_FAILURES: Final = 10
MAX_EVIDENCE_KEYS: Final = 12
#: A cost this many times its p50 is an outlier; the outliers listed, of runs and of agents, at most.
OUTLIER_FACTOR: Final = 3
MAX_OUTLIERS: Final = 10
MAX_STEPS: Final = 40
#: The calibration's margin over the observed p95 (orchestration/calibrate.py's), and its task ceiling.
MARGIN: Final = Decimal('1.5')
MAX_TASKS: Final = 100
#: A flow the pass takes: a key part of its own (no ``/``), as the index and the spend ledger key it.
FLOW: Final = re.compile(r'[A-Za-z0-9._:@+=-]{1,100}\Z')
_DAY: Final = re.compile(r'20[0-9]{2}-[01][0-9]-[0-3][0-9]\Z')
_AGENT_NUMBER: Final = re.compile(r'-[0-9]+\Z')
#: An agent's session ended so (runtime/sessions.py), and what the pass calls it.
_SESSION_FAILURES: Final = {'failed': 'failed', 'reposted': 'reposted'}


@dataclass(frozen=True)
class Listing:
    """One page of a listing: its keys, its common prefixes (by the delimiter), and whether it was cut."""

    keys: tuple[str, ...] = ()
    prefixes: tuple[str, ...] = ()
    more: bool = False


class Lister(Protocol):
    def __call__(self, prefix: str, *, delimiter: str = '', start_after: str = '') -> Listing: ...


def s3_lister(s3: Any, bucket: str) -> Lister:
    """One page (at most 1,000) of ``bucket``'s listing under a prefix, through an S3 client."""
    def listed(prefix: str, *, delimiter: str = '', start_after: str = '') -> Listing:
        page = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1000,
                                  **({'Delimiter': delimiter} if delimiter else {}),
                                  **({'StartAfter': start_after} if start_after else {}))
        return Listing(keys=tuple(str(item['Key']) for item in page.get('Contents', [])),
                       prefixes=tuple(str(item['Prefix']) for item in page.get('CommonPrefixes', [])),
                       more=page.get('IsTruncated') is True)
    return listed


def check_flow(flow: object) -> str:
    """``flow`` when the pass takes it, else ValueError: a run without a flow (``no-flow``) has no settings to read."""
    if not isinstance(flow, str) or not FLOW.fullmatch(flow) or flow == NO_FLOW:
        raise ValueError('a flow is 1-100 letters, digits or ._:@+=- (never no-flow)')
    return flow


def index_prefix(flow: str) -> str:
    return f'{INDEX_PREFIX}{check_flow(flow)}/'


def flows(lister: Lister) -> tuple[tuple[str, ...], bool]:
    """The index's flows the pass takes (at most ``MAX_FLOWS``, by name), and whether the listing had more."""
    listed = lister(INDEX_PREFIX, delimiter='/')
    names = sorted(prefix[len(INDEX_PREFIX):].rstrip('/') for prefix in listed.prefixes)
    taken = [name for name in names if FLOW.fullmatch(name) and name != NO_FLOW]
    return tuple(taken[:MAX_FLOWS]), listed.more or len(taken) > MAX_FLOWS


@dataclass(frozen=True)
class Indexed:
    """A run as the index names it: its id, its day and its entry's key."""

    run_id: str
    day: str
    key: str


def _run_of(key: str) -> str:
    name = key.rsplit('/', 1)[-1].removesuffix('.json')
    try:
        return check_run_id(name)
    except RuntimeRefused:
        return ''


def recent_runs(lister: Lister, flow: str, today: date) -> tuple[tuple[Indexed, ...], bool]:
    """The flow's runs of the last ``WINDOW_DAYS`` days, newest first (a ULID sorts by time), at most ``MAX_RUNS``;
    and whether the index held more than was read."""
    prefix = index_prefix(flow)
    first = (today - timedelta(days=WINDOW_DAYS - 1)).isoformat()
    # (``<prefix><first>`` sorts before ``<prefix><first>/``: the window's first day is listed)
    days = lister(prefix, delimiter='/', start_after=f'{prefix}{first}')
    found: list[Indexed] = []
    more = days.more
    for day_prefix in sorted(days.prefixes, reverse=True):
        day = day_prefix[len(prefix):].rstrip('/')
        if not _DAY.fullmatch(day):
            continue
        listed = lister(day_prefix)
        more = more or listed.more
        runs = sorted(((run, key) for key in listed.keys if (run := _run_of(key))), reverse=True)
        for run_id, key in runs:
            if len(found) == MAX_RUNS:
                return tuple(found), True
            found.append(Indexed(run_id, day, key))
    return tuple(found), more


def _clip(value: object, limit: int = TEXT_CHARS) -> str:
    """``value`` as one redacted line of at most ``limit`` characters, never with a NUL."""
    return one_line(value, limit).replace('\x00', '')


def _amount(value: object) -> Decimal:
    try:
        found = Decimal(str(value))
    except (ArithmeticError, ValueError):
        return Decimal(0)
    return found if found.is_finite() and found >= 0 else Decimal(0)


@dataclass(frozen=True)
class AgentLine:
    """One agent of a run, as its manifest names it."""

    agent: str
    role: str
    step: str
    task: str
    attempt: int
    status: str
    cost: Decimal
    seconds: int
    transcripts: str

    @classmethod
    def of(cls, row: Mapping[str, Any]) -> AgentLine:
        return cls(agent=_clip(row.get('agent', ''), 64), role=_clip(row.get('role', ''), 64),
                   step=_clip(row.get('step', ''), 64), task=_clip(row.get('task', ''), 64),
                   attempt=_whole(row.get('attempt')) or 1, status=_clip(row.get('status', ''), 32),
                   cost=_amount(row.get('cost_usd', 0)), seconds=_whole(row.get('session_seconds')),
                   transcripts=str(row.get('transcripts', ''))[:400])

    @property
    def step_or_role(self) -> str:
        return self.step or f'role:{self.role}'


@dataclass(frozen=True)
class Coached:
    """A failure the run's retrospective took to the coach (``<task>#<attempt>#<how>``) and what came of it."""

    key: str
    task: str
    attempt: int
    how: str
    coach: str = ''
    lesson: str = ''


@dataclass(frozen=True)
class GateLine:
    key: str
    verdict: str
    stop_reason: str
    rounds: int
    open_blocking: tuple[str, ...]
    reasons: tuple[str, ...]

    @property
    def no_go(self) -> bool:
        return self.verdict == 'NO-GO'


@dataclass(frozen=True)
class RunDigest:
    """What the pass read of one run: ids, numbers, keys and short redacted texts."""

    run_id: str
    day: str
    status: str
    connection: str
    repo: str
    cost: Decimal
    tokens: int
    manifest: str
    agents: tuple[AgentLine, ...]
    coached: tuple[Coached, ...] = ()
    gates: tuple[GateLine, ...] = ()

    def role_of(self, task: str, attempt: int) -> AgentLine | None:
        return next((agent for agent in self.agents if (agent.task, agent.attempt) == (task, attempt)), None)

    def prompt_view(self) -> dict[str, Any]:
        """The run as the model reads it (fenced as data): never its transcript, never a diff."""
        return {'run_id': self.run_id, 'day': self.day, 'status': self.status, 'cost_usd': str(self.cost),
                'tokens': self.tokens,
                'agents': [{'agent': a.agent, 'role': a.role, 'step': a.step, 'status': a.status,
                            'cost_usd': str(a.cost), 'seconds': a.seconds} for a in self.agents[:MAX_DIGEST_AGENTS]],
                'agents_left_out': max(len(self.agents) - MAX_DIGEST_AGENTS, 0),
                'coached': [{'failure': c.key, 'coach': c.coach, 'lesson': c.lesson} for c in self.coached],
                'gates': [{'verdict': g.verdict, 'stop_reason': g.stop_reason, 'rounds': g.rounds,
                           'open_blocking': list(g.open_blocking), 'reasons': list(g.reasons)} for g in self.gates]}

    def line(self) -> dict[str, Any]:
        """The run as the record lists it."""
        return {'run_id': self.run_id, 'day': self.day, 'status': self.status, 'cost_usd': str(self.cost),
                'tokens': self.tokens, 'agents': len(self.agents), 'manifest': self.manifest}


def _coached(chosen: Mapping[str, Any] | None, learned: Sequence[Mapping[str, Any]]) -> tuple[Coached, ...]:
    keys = [str(key) for key in (chosen or {}).get('keys', []) if isinstance(key, str)]
    outcomes = {str(row.get('sk', '')).removeprefix('LEARNED#'): row for row in learned}
    found = []
    for key in keys[:MAX_LEARN_ROWS]:
        task, _, rest = key.partition('#')
        attempt, _, how = rest.partition('#')
        row = outcomes.get(key, {})
        found.append(Coached(key=_clip(key, 300), task=task, attempt=int(attempt) if attempt.isdigit() else 0,
                             how=how, coach=_clip(row.get('coach', ''), OUTCOME_CHARS),
                             lesson=_clip(row.get('lesson', ''), OUTCOME_CHARS)))
    return tuple(found)


def _gate(key: str, record: GateRecord) -> GateLine:
    open_blocking = [finding.title for finding in record.findings
                     if finding.blocking and record.outcome(finding)[0] == 'open']
    reasons = record.final_go.reasons if record.final_go else ()
    return GateLine(key=key, verdict=record.verdict, stop_reason=record.stop_reason, rounds=len(record.rounds),
                    open_blocking=tuple(_clip(title) for title in open_blocking[:MAX_TITLES]),
                    reasons=tuple(_clip(reason) for reason in reasons[:MAX_TITLES]))


@dataclass(frozen=True)
class RunInputReader:
    """A run's manifest, Learn records and gate records, on the runtime's grants."""

    #: voc-engineering, a boto3 resource Table (plain values).
    table: Any
    #: The workspace bucket's bounded read (WorkspaceStore.read_text: None for a missing or denied key).
    read_text: Callable[[str], str | None]

    def _json(self, key: str) -> Any:
        text = self.read_text(key)
        try:
            return None if text is None else json.loads(text)
        except ValueError:
            return None

    def _manifest(self, run_id: str) -> Mapping[str, Any] | None:
        body = self._json(manifest_key(run_id, 1))
        if not isinstance(body, Mapping) or body.get('schema') != MANIFEST_SCHEMA or body.get('run_id') != run_id:
            logger.warning('cross-run learn: a run\'s manifest could not be read', extra={'run_id': run_id})
            return None
        return body

    def _learned(self, run_id: str) -> tuple[Coached, ...]:
        pk = run_pk(run_id)
        chosen = self.table.get_item(Key={'pk': pk, 'sk': CHOSEN_SK}).get('Item')
        rows = self.table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :learned)',
                                ExpressionAttributeValues={':pk': pk, ':learned': 'LEARNED#'},
                                Limit=MAX_LEARN_ROWS).get('Items', [])
        return _coached(chosen, rows)

    def _gates(self, run_id: str, outputs: Sequence[object]) -> tuple[GateLine, ...]:
        keys: list[tuple[int, str]] = []
        for raw in outputs:
            key = parse_agent_key(raw) if isinstance(raw, str) else None
            if key is not None and (key.ws, key.run_id, key.kind, key.name) == ('default', run_id, 'gate', GATE_RECORD):
                keys.append((key.attempt, str(raw)))
        found = []
        for _attempt, raw in sorted(keys, reverse=True)[:MAX_GATES]:
            try:
                found.append(_gate(raw, GateRecord.from_dict(self._json(raw))))
            except ValueError:
                logger.warning('cross-run learn: a gate record is off its schema', extra={'run_id': run_id})
        return tuple(found)

    def digest(self, run: Indexed) -> RunDigest | None:
        """The run's digest, or None when its manifest cannot be read (logged)."""
        body = self._manifest(run.run_id)
        if body is None:
            return None
        rows, keys = body.get('agents'), body.get('keys')
        outputs = keys.get('outputs') if isinstance(keys, Mapping) else None
        return RunDigest(run_id=run.run_id, day=run.day, status=_clip(body.get('status', ''), 32),
                         connection=_clip(body.get('connection', ''), 128), repo=_clip(body.get('repo', ''), 200),
                         cost=_amount(body.get('cost_usd', 0)), tokens=_whole(body.get('tokens')),
                         manifest=manifest_key(run.run_id, 1),
                         agents=tuple(AgentLine.of(row) for row in (rows if isinstance(rows, list) else ())
                                      if isinstance(row, Mapping)),
                         coached=self._learned(run.run_id),
                         gates=self._gates(run.run_id, outputs if isinstance(outputs, list) else ()))


def percentile(values: Sequence[Decimal], share: Decimal) -> Decimal:
    """The nearest-rank percentile of ``values`` (``share`` 0.5 for the median, 0.95 for p95); 0 for none."""
    if not values:
        return Decimal(0)
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


P50: Final = Decimal('0.5')
P95: Final = Decimal('0.95')


@dataclass(frozen=True)
class Signal:
    """One way a run failed: the role and the kind, and the keys that show it."""

    role: str
    kind: str
    evidence: tuple[str, ...]


def _role_of_agent(agent: str) -> str:
    return _AGENT_NUMBER.sub('', agent)


def signals(run: RunDigest) -> tuple[Signal, ...]:
    """The run's failures by role and kind (once each): the retrospective's, its agents' failed sessions, its NO-GOs."""
    found: dict[tuple[str, str], list[str]] = {}
    covered: set[tuple[str, int]] = set()
    for coached in run.coached:
        agent = run.role_of(coached.task, coached.attempt)
        covered.add((coached.task, coached.attempt))
        found.setdefault((agent.role if agent else '', coached.how), []).append(agent.transcripts if agent else '')
    for agent in run.agents:
        kind = _SESSION_FAILURES.get(agent.status)
        if kind and (agent.task, agent.attempt) not in covered:
            found.setdefault((agent.role, kind), []).append(agent.transcripts)
    if not any(kind == 'no_go' for _role, kind in found):
        for gate in run.gates:
            if gate.no_go:
                key = parse_agent_key(gate.key)
                found.setdefault((_role_of_agent(key.agent) if key else FINAL_GO_ROLE, 'no_go'), []).append(gate.key)
    return tuple(Signal(role, kind, tuple(dict.fromkeys(key for key in (run.manifest, *keys) if key)))
                 for (role, kind), keys in found.items() if role and kind)


@dataclass(frozen=True)
class Recurring:
    """A failure in ``MIN_RECURRING`` runs or more: its role and kind, its runs (newest first), its evidence's keys."""

    role: str
    kind: str
    runs: tuple[str, ...]
    evidence: tuple[str, ...]

    def view(self, index: int) -> dict[str, Any]:
        return {'index': index, 'role': self.role, 'kind': self.kind, 'count': len(self.runs), 'runs': list(self.runs),
                'evidence': list(self.evidence)}


def recurring(digests: Sequence[RunDigest]) -> tuple[Recurring, ...]:
    """The failures that recur across the runs (newest run first), most runs first, at most ``MAX_FAILURES``."""
    runs: dict[tuple[str, str], list[str]] = {}
    evidence: dict[tuple[str, str], list[str]] = {}
    for run in digests:
        for signal in signals(run):
            runs.setdefault((signal.role, signal.kind), []).append(run.run_id)
            evidence.setdefault((signal.role, signal.kind), []).extend(signal.evidence)
    kept = sorted(((key, ids) for key, ids in runs.items() if len(ids) >= MIN_RECURRING),
                  key=lambda pair: (-len(pair[1]), pair[0]))
    return tuple(Recurring(role, kind, tuple(ids), tuple(dict.fromkeys(evidence[(role, kind)]))[:MAX_EVIDENCE_KEYS])
                 for (role, kind), ids in kept[:MAX_FAILURES])


def _spread(values: Sequence[Decimal]) -> dict[str, str]:
    return {'p50': str(percentile(values, P50)), 'p95': str(percentile(values, P95))}


def _steps(digests: Sequence[RunDigest]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Each step's session seconds and cost at p50 and p95, and the agents whose cost is an outlier of its step's."""
    by_step: dict[str, list[tuple[RunDigest, AgentLine]]] = {}
    for run in digests:
        for agent in run.agents:
            by_step.setdefault(agent.step_or_role, []).append((run, agent))
    steps, outliers = [], []
    for step, agents in sorted(by_step.items())[:MAX_STEPS]:
        costs = [agent.cost for _run, agent in agents]
        steps.append({'step': step, 'roles': sorted({agent.role for _run, agent in agents}), 'agents': len(agents),
                      'seconds': _spread([Decimal(agent.seconds) for _run, agent in agents]), 'cost_usd': _spread(costs)})
        median = percentile(costs, P50)
        outliers += [{'run_id': run.run_id, 'agent': agent.agent, 'step': step, 'cost_usd': str(agent.cost),
                      'times_p50': str((agent.cost / median).quantize(Decimal('0.1'))),
                      'transcripts': agent.transcripts}
                     for run, agent in agents if median > 0 and agent.cost >= OUTLIER_FACTOR * median]
    return steps, outliers[:MAX_OUTLIERS]


def _run_outliers(digests: Sequence[RunDigest]) -> list[dict[str, Any]]:
    median = percentile([run.cost for run in digests], P50)
    return [{'run_id': run.run_id, 'cost_usd': str(run.cost), 'times_p50': str((run.cost / median).quantize(
        Decimal('0.1'))), 'manifest': run.manifest}
            for run in digests if median > 0 and run.cost >= OUTLIER_FACTOR * median][:MAX_OUTLIERS]


def _done_rate(digests: Sequence[RunDigest]) -> str:
    return str((Decimal(sum(run.status == 'done' for run in digests)) / len(digests)).quantize(Decimal('0.01'))) \
        if digests else '0'


def _convergence(digests: Sequence[RunDigest]) -> dict[str, Any]:
    """The runs by status and the share done, overall and for the older and the newer half (newest first in)."""
    half = len(digests) // 2
    newer, older = digests[:half], digests[half:]
    failures = sum(len(signals(run)) for run in digests)
    return {'runs': len(digests), 'statuses': dict(sorted(Counter(run.status for run in digests).items())),
            'done_rate': _done_rate(digests), 'older_done_rate': _done_rate(older),
            'newer_done_rate': _done_rate(newer),
            'failures_per_run': str((Decimal(failures) / len(digests)).quantize(Decimal('0.01'))) if digests else '0'}


def _proposed(observed: Decimal, cents: bool = False, ceiling: int | None = None) -> str:
    scaled = observed * MARGIN
    value = scaled.quantize(Decimal('0.01'), rounding=ROUND_CEILING) if cents else scaled.to_integral_value(
        rounding=ROUND_CEILING)
    value = max(value, Decimal('0.01') if cents else Decimal(1))
    return str(min(value, Decimal(ceiling)) if ceiling is not None else value)


def calibration(digests: Sequence[RunDigest]) -> list[dict[str, Any]]:
    """The flow's caps from what its runs used: each setting's observed p95 and that times ``MARGIN``, rounded up."""
    if not digests:
        return []
    figures = (('budget.run_token_cap', [Decimal(run.tokens) for run in digests], False, None),
               ('budget.max_tasks', [Decimal(len(run.agents)) for run in digests], False, MAX_TASKS),
               ('budget.max_cost_usd', [run.cost for run in digests], True, None))
    return [{'setting': setting, 'observed_p95': str(percentile(values, P95)), 'margin': str(MARGIN),
             'proposed': _proposed(percentile(values, P95), cents, ceiling), 'runs': len(values)}
            for setting, values, cents, ceiling in figures]


@dataclass(frozen=True)
class Figures:
    """What the pass counted by rule (the record's figures, and the model's input beside the runs)."""

    failures: tuple[Recurring, ...]
    steps: list[dict[str, Any]]
    outliers: dict[str, list[dict[str, Any]]]
    convergence: dict[str, Any]
    calibration: list[dict[str, Any]]
    #: The runs' cost and tokens at p50 and p95.
    spread: dict[str, Any] = field(default_factory=dict)

    def view(self) -> dict[str, Any]:
        return {'failures': [failure.view(n) for n, failure in enumerate(self.failures, 1)], 'steps': self.steps,
                'outliers': self.outliers, 'convergence': self.convergence, 'calibration': self.calibration,
                'spread': self.spread}


def figures(digests: Sequence[RunDigest]) -> Figures:
    """The figures of the runs read (newest first)."""
    steps, agent_outliers = _steps(digests)
    costs = [run.cost for run in digests]
    return Figures(failures=recurring(digests), steps=steps,
                   outliers={'runs': _run_outliers(digests), 'agents': agent_outliers},
                   convergence=_convergence(digests), calibration=calibration(digests),
                   spread={'cost_usd': _spread(costs), 'tokens': _spread([Decimal(run.tokens) for run in digests])})
