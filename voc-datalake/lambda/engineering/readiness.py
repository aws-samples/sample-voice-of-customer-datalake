"""Readiness (7.50.00): whether an engineering agent (an automation) or a flow template can run here, check by check.

Pure: every read is a port (``ReadinessPorts``) the caller wires (``readiness_aws.py`` for the Agents API's
``GET /agents/engineering/readiness``), and a port that cannot answer raises ``ReadFailed``, which the check answers
``unknown`` (never a pass). Each check answers ``{id, status, detail, fix, docs, required}``: ``status`` one of
``pass``, ``fail``, ``warn`` or ``unknown``; ``fix`` what a person does about it; ``docs`` where the doc explains it
(``docs/autonomous-engineering.md#readiness-75000`` and the sections it links). A check the subject does not need
(an Issues source for a flow no issue starts) passes, saying so.

The owner's list, in order: the connection and the App installation covering its repository; the CI attestation and
the host's branch rules (``ci_protection``: the broker reads them with the connection's own token at each push, so
this answers ``unknown`` unless a reader is wired); an image for the language; the knowledge pack and the tenets
where the flow's ``requires`` asks for them; the Issues source (deployment-wide) and the trigger's label; the enabling
administrator's STORED way of working (``connectors/dial.py``: no row is Human-driven, which pushes nothing); the
budget and the hard cap; Bedrock access for every model the flow's roles run on (their cards' models,
``skills/templates.py``, and any step's own ``model``); the AgentCore sessions quota and the build memory setting;
the sessions' network; the workspace bucket's create-only probe.

``REQUIRED`` (the owner's decision, 2026-11-16) are the checks a run truly needs: the connection, the CI attestation,
the image, the models, the budget and the dial. Engineering Enable is refused (409) while one of them fails; the rest
are advice, and the setup guide says so.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Final, Literal, Protocol

from shared.ai_mode import MODE_AI_ASSISTED, MODE_AI_DRIVEN, MODES
from shared.workflow_engineering import PUSHING_ROLES

Status = Literal['pass', 'fail', 'warn', 'unknown']
DOCS: Final = 'docs/autonomous-engineering.md'
READINESS_DOCS: Final = f'{DOCS}#readiness-75000'
#: The checks, in the order they are answered.
CHECK_IDS: Final = ('connection', 'app_installation', 'ci_attestation', 'ci_protection', 'image', 'pack', 'tenets',
                    'issues_source', 'issue_label', 'dial', 'budget', 'hard_cap', 'bedrock_models',
                    'agentcore_quota', 'memory_setting', 'network', 'session_storage')
#: What a run truly needs (owner decision): Enable is refused while one of these fails.
REQUIRED: Final = frozenset({'connection', 'ci_attestation', 'image', 'bedrock_models', 'budget', 'dial'})
#: The ways of working that let a run push and open a pull request (connectors/dial.py PUSHING_MODES; the modes are
#: shared/ai_mode.py's ``MODES``, and the roles whose work leaves as code shared/workflow_engineering.py's).
PUSHING_MODES: Final = frozenset({MODE_AI_ASSISTED, MODE_AI_DRIVEN})
#: Learn's model, as ``flow_models`` names its caller (the run-end step, plan §5; the coach's card has no model).
LEARN: Final = 'learn'
#: The model access statuses (shared/image_model_status.py): only ``available`` runs.
MODEL_AVAILABLE: Final = 'available'
#: The build runtimes' resource configuration (engineering-agentcore.ts BUILD_MEMORY_MIB) and the regions whose
#: CloudFormation schema lacked ``ResourceConfigurations`` on 2026-11-15 (the stack's comment; plan §13.8).
BUILD_MEMORY_MIB: Final = 8192
REGIONS_WITHOUT_BUILD_SIZES: Final = frozenset({'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1',
                                                'ap-northeast-1'})
#: The roles every run has, whatever its flow names: its coordinator.
ALWAYS: Final = frozenset({'coordinator'})
#: The roles a quality gate step runs (its runner and its final go).
GATE_ROLES: Final = ('gate-runner', 'final-go')


class ReadFailed(Exception):
    """A port that could not read what it was asked (a refused or failed call): the check answers ``unknown``."""


@dataclass(frozen=True)
class Check:
    id: str
    status: Status
    detail: str
    fix: str = ''
    docs: str = READINESS_DOCS

    @property
    def required(self) -> bool:
        return self.id in REQUIRED

    @property
    def blocking(self) -> bool:
        """A required check that does not pass: a run cannot go (an ``unknown`` one included: never assumed)."""
        return self.required and self.status != 'pass'

    def view(self) -> dict[str, Any]:
        return {'id': self.id, 'status': self.status, 'detail': self.detail, 'fix': self.fix, 'docs': self.docs,
                'required': self.required}


@dataclass(frozen=True)
class Subject:
    """What readiness is asked of: an automation (an engineering agent, ``kind`` automation) or a flow template.

    ``definition``: the flow (``voc-workflow/2``); ``workflow_id``: the stored flow whose month spend the hard cap
    reads ('' for a template); ``connection``/``language``: the agent's settings ('' for none named); ``trigger``:
    its ``github_issue`` trigger, if any; ``person``: whose stored way of working its runs follow (the enabling
    administrator, or the asker for an agent not enabled yet)."""

    kind: Literal['automation', 'flow']
    id: str
    name: str
    definition: Mapping[str, Any]
    person: str
    #: What a run of the flow needs (``flow_requires``: its template's ``requires``, plan §2).
    requires: Mapping[str, Any] = field(default_factory=dict)
    workflow_id: str = ''
    connection: str = ''
    language: str = ''
    budget_usd: Decimal | None = None
    trigger: Mapping[str, Any] | None = None

    def view(self) -> dict[str, Any]:
        return {'kind': self.kind, 'id': self.id, 'name': self.name, 'connection': self.connection or None,
                'language': self.language or None}


@dataclass(frozen=True)
class Settings:
    """The deployment's own settings the checks read (the Agents API's environment)."""

    #: The languages with an agent runtime (``-c engineeringImages`` with a network).
    image_languages: frozenset[str] = frozenset()
    #: Whether the sessions have a network (``-c engineeringAgentNetwork``).
    network: bool = False
    build_memory_mib: int = 0
    region: str = ''
    #: The agent sessions this deployment runs at once (``-c engineeringMaxSessions``).
    max_sessions: int = 0
    #: The model each role's card names (``skills/templates.py`` ``card_models``).
    card_models: Mapping[str, str] = field(default_factory=dict)


class ReadinessPorts(Protocol):
    """What the checks read; each raises ``ReadFailed`` when it cannot answer."""

    def connection(self, connection_id: str) -> Mapping[str, Any] | None:
        """The stored connection's row (``repository``, ``host``, ``repository_private``, ``credential_kind``,
        ``app_id``, ``installation_id``), None for none."""
        ...

    def installation_repositories(self, connection: Mapping[str, Any]) -> tuple[frozenset[str], bool] | None:
        """The repositories the connection's GitHub App installation covers, and whether the list was cut; None when
        this deployment cannot read it from here (a connection with its own App key, which only the broker reads)."""
        ...

    def attested(self, connection_id: str, repository: str) -> bool:
        """Whether an administrator's CI attestation holds for the connection's repository."""
        ...

    def ci_protection(self, connection: Mapping[str, Any]) -> bool | None:
        """Whether the host's branch rules pass (``hosts.ci_refusal`` is None), None when not readable from here."""
        ...

    def knowledge_approved(self, connection_id: str) -> int:
        """The approved knowledge pack version of the connection's repository root (0: none)."""
        ...

    def issues_source_reads(self, repository: str) -> bool:
        """Whether the deployment-wide GitHub Issues source has read ``repository`` (its watermark exists)."""
        ...

    def mode(self, person: str) -> str:
        """The person's STORED way of working (``connectors/dial.py``: Human-driven for no row)."""
        ...

    def hard_cap_on(self) -> bool:
        ...

    def month_spend_usd(self, workflow_id: str) -> Decimal:
        """What the flow spent this month (the spend ledger's ``FLOW#`` total)."""
        ...

    def models_access(self, model_ids: list[str]) -> Mapping[str, str]:
        """Each model's access in this account and region: ``available`` | ``no_access`` | ``not_subscribed`` |
        ``not_in_region`` | ``unknown`` (a model left out of the answer reads ``unknown``)."""
        ...

    def session_quota(self) -> float:
        """AgentCore's active sessions quota for the account and region."""
        ...

    def probe_storage(self) -> bool:
        """The workspace bucket's create-only probe: True when it answered as a create-only bucket does."""
        ...


@dataclass(frozen=True)
class Report:
    subject: Subject
    checks: tuple[Check, ...]

    @property
    def ready(self) -> bool:
        return not self.failing

    @property
    def failing(self) -> tuple[Check, ...]:
        """The required checks that do not pass (what Enable's 409 names)."""
        return tuple(check for check in self.checks if check.blocking)

    def view(self) -> dict[str, Any]:
        return {'subject': self.subject.view(), 'ready': self.ready,
                'checks': [check.view() for check in self.checks]}


# ── the flow's roles and models ─────────────────────────────────────────────────────────────────────────────────


def _params(node: Mapping[str, Any]) -> Mapping[str, Any]:
    data = node.get('data')
    params = data.get('params') if isinstance(data, Mapping) else None
    return params if isinstance(params, Mapping) else {}


def _nodes(definition: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    nodes = definition.get('nodes')
    return [node for node in nodes if isinstance(node, Mapping)] if isinstance(nodes, list) else []


def _texts(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def start_params(definition: Mapping[str, Any]) -> Mapping[str, Any]:
    """The flow's own settings: its start step's ``params`` (``memory``, ``learn``, ``pr``: plan §2, as compiled)."""
    return next((_params(node) for node in _nodes(definition) if node.get('type') == 'start'), {})


def flow_roles(definition: Mapping[str, Any]) -> frozenset[str]:
    """Every role a run of the flow launches: its agent steps', its boards' posters and claimers, a quality gate's
    runner and final go, and its coordinator."""
    found = set(ALWAYS)
    for node in _nodes(definition):
        params, kind = _params(node), node.get('type')
        if kind == 'agent' and isinstance(params.get('role'), str):
            found.add(str(params['role']))
        elif kind == 'board':
            found |= {*_texts(params.get('posters')), *_texts(params.get('claimers'))}
        elif kind == 'quality_gate':
            found |= set(GATE_ROLES)
    return frozenset(found)


def flow_requires(definition: Mapping[str, Any], declared: object = None) -> dict[str, Any]:
    """What a run of the flow needs (plan §2 ``requires``: ``dial``, the modes it runs in; ``ci_attestation``,
    ``image``, ``issues_source``, ``knowledge_pack``): ``declared`` (its template's), else what its start step or
    its definition says, else what its roles need: a flow that pushes (a committer or a PR author) needs a pushing
    way of working and the CI attestation; any flow, an image."""
    for found in (declared, start_params(definition).get('requires'), definition.get('requires')):
        if isinstance(found, Mapping):
            return dict(found)
    pushes = bool(flow_roles(definition) & PUSHING_ROLES)
    return {'dial': sorted(PUSHING_MODES) if pushes else list(MODES), 'ci_attestation': pushes, 'image': True}


def flow_models(definition: Mapping[str, Any], card_models: Mapping[str, str]) -> dict[str, tuple[str, ...]]:
    """Every model the flow's runs call, each with the roles that call it: each role's card model (its agent steps,
    its boards' posters and claimers, a quality gate's runner and final go, the run's coordinator), or a step's own
    ``model`` (an agent's, a gate's ``final_go_model``), and Learn's (``learn.model`` while Learn is on). A role with
    no card model is left out (none is launched)."""
    by_model: dict[str, set[str]] = {}

    def add(role: str, model: object = None) -> None:
        chosen = model if isinstance(model, str) and model else card_models.get(role, '')
        if chosen:
            by_model.setdefault(chosen, set()).add(role)

    for role in ALWAYS:
        add(role)
    for node in _nodes(definition):
        params, kind = _params(node), node.get('type')
        if kind == 'agent' and isinstance(params.get('role'), str):
            add(str(params['role']), params.get('model'))
        elif kind == 'board':
            for role in (*_texts(params.get('posters')), *_texts(params.get('claimers'))):
                add(role)
        elif kind == 'quality_gate':
            add(GATE_ROLES[0])
            add(GATE_ROLES[1], params.get('final_go_model'))
    learn = start_params(definition).get('learn')
    if isinstance(learn, Mapping) and learn.get('enabled') is not False:
        add(LEARN, learn.get('model'))
    return {model: tuple(sorted(roles)) for model, roles in sorted(by_model.items())}


def requires(subject: Subject, name: str) -> bool:
    """Whether the subject's flow needs ``name`` (``knowledge_pack``, also spelled ``pack``; ``tenets``,
    ``issues_source``, ``ci_attestation``)."""
    names = ('knowledge_pack', 'pack') if name == 'knowledge_pack' else (name,)
    return any(subject.requires.get(each) is True for each in names)


def allowed_modes(subject: Subject) -> frozenset[str]:
    """The ways of working a run of the flow works in (``requires.dial``; the pushing ones when it names none)."""
    modes = subject.requires.get('dial')
    named = frozenset(mode for mode in modes if mode in MODES) if isinstance(modes, list) else frozenset()
    return named or PUSHING_MODES


# ── the checks ─────────────────────────────────────────────────────────────────────────────────────────────────


def _unknown(check_id: str, what: str, error: ReadFailed, fix: str = 'Ask again in a minute.',
             docs: str = READINESS_DOCS) -> Check:
    return Check(check_id, 'unknown', f'{what} could not be read ({str(error)[:200] or type(error).__name__}).', fix,
                 docs)


def _not_needed(check_id: str, why: str, docs: str = READINESS_DOCS) -> Check:
    return Check(check_id, 'pass', f'Not needed: {why}.', '', docs)


CONNECTORS_DOCS: Final = f'{DOCS}#repository-connectors'
APP_DOCS: Final = f'{DOCS}#a-github-app-in-two-clicks-74500'
KNOWLEDGE_DOCS: Final = f'{DOCS}#the-knowledge-pack'
TENETS_DOCS: Final = f'{DOCS}#the-repositorys-tenets'
RUNTIME_DOCS: Final = f'{DOCS}#runtime-one-agentcore-session-per-agent'
MODELS_DOCS: Final = f'{DOCS}#models'
COST_DOCS: Final = f'{DOCS}#cost'
TRUST_DOCS: Final = f'{DOCS}#trust-and-safety'
ADD_CONNECTION: Final = 'Add the repository under Agents → Connections, then name it in the agent\'s Set up.'


@dataclass
class _Context:
    subject: Subject
    ports: ReadinessPorts
    settings: Settings
    row: Mapping[str, Any] | None = None
    row_error: ReadFailed | None = None


def _connection(ctx: _Context) -> Check:
    if not ctx.subject.connection:
        return Check('connection', 'fail', 'No repository connection is named.', ADD_CONNECTION, CONNECTORS_DOCS)
    if ctx.row_error is not None:
        return _unknown('connection', 'The connection', ctx.row_error, docs=CONNECTORS_DOCS)
    if ctx.row is None:
        return Check('connection', 'fail', f'The connection {ctx.subject.connection} is not stored (or was removed).',
                     ADD_CONNECTION, CONNECTORS_DOCS)
    return Check('connection', 'pass', f'{ctx.row.get("host") or "github"}: {ctx.row.get("repository", "")}', '',
                 CONNECTORS_DOCS)


def _repository(ctx: _Context) -> str:
    return str((ctx.row or {}).get('repository') or '')


def _app_installation(ctx: _Context) -> Check:
    if ctx.row is None:
        return Check('app_installation', 'unknown', 'No stored connection to read its installation of.',
                     ADD_CONNECTION, APP_DOCS)
    if str(ctx.row.get('host') or 'github') != 'github':
        return _not_needed('app_installation', 'a GitLab connection signs in with its project access token', APP_DOCS)
    try:
        covered = ctx.ports.installation_repositories(ctx.row)
    except ReadFailed as error:
        return _unknown('app_installation', 'The GitHub App installation', error,
                        'Check the App under Agents → Connections → GitHub Apps, then ask again.', APP_DOCS)
    if covered is None:
        return Check('app_installation', 'unknown', 'This connection signs in with its own GitHub App key, which only '
                     'the broker reads: its installation is not read from here.',
                     'Make sure the App is installed on the repository (GitHub → Settings → GitHub Apps), or connect '
                     'it through one of this deployment\'s GitHub Apps.', APP_DOCS)
    repositories, truncated = covered
    repository = _repository(ctx)
    if repository.lower() in {name.lower() for name in repositories}:
        return Check('app_installation', 'pass', f'The installation covers {repository}.', '', APP_DOCS)
    if truncated:
        return Check('app_installation', 'unknown', f'The installation lists more repositories than are read here; '
                     f'{repository} is not among those read.', 'Check the installation on GitHub.', APP_DOCS)
    return Check('app_installation', 'fail', f'The GitHub App installation does not cover {repository}.',
                 'On GitHub, add the repository to the App\'s installation (Configure → Repository access).', APP_DOCS)


def _ci_attestation(ctx: _Context) -> Check:
    if not requires(ctx.subject, 'ci_attestation'):
        return _not_needed('ci_attestation', 'the flow pushes nothing', CONNECTORS_DOCS)
    if ctx.row is None:
        return Check('ci_attestation', 'fail', 'No stored connection to attest.', ADD_CONNECTION, CONNECTORS_DOCS)
    try:
        attested = ctx.ports.attested(ctx.subject.connection, _repository(ctx))
    except ReadFailed as error:
        return _unknown('ci_attestation', 'The CI attestation', error, docs=CONNECTORS_DOCS)
    if attested:
        return Check('ci_attestation', 'pass', f'An administrator attested the CI of {_repository(ctx)}.', '',
                     CONNECTORS_DOCS)
    return Check('ci_attestation', 'fail', 'No CI attestation holds for the repository: the broker refuses every push '
                 'and pull request.', 'Agents → Connections → the connection → CI attestation: confirm every point '
                 'of the setup guide.', CONNECTORS_DOCS)


def _ci_protection(ctx: _Context) -> Check:
    fix = ('Protect the default branch with the checks the repository requires, and leave voc-agent/* without any '
           'branch rule or ruleset.')
    if ctx.row is None:
        return Check('ci_protection', 'unknown', 'No stored connection to read the branch rules of.', fix,
                     CONNECTORS_DOCS)
    try:
        passes = ctx.ports.ci_protection(ctx.row)
    except ReadFailed as error:
        return _unknown('ci_protection', 'The branch rules', error, fix, CONNECTORS_DOCS)
    if passes is None:
        return Check('ci_protection', 'unknown', 'The host\'s branch rules are read by the broker, with the '
                     'connection\'s own read-only token, at each push and pull request; this API holds no host token.',
                     fix, CONNECTORS_DOCS)
    if passes:
        return Check('ci_protection', 'pass', 'The default branch is protected and voc-agent/* is not.', '',
                     CONNECTORS_DOCS)
    return Check('ci_protection', 'fail', 'The host\'s branch rules do not pass.', fix, CONNECTORS_DOCS)


def _image(ctx: _Context) -> Check:
    language = ctx.subject.language
    images = sorted(ctx.settings.image_languages)
    fix = ('Build and push the language\'s image, then deploy with -c engineeringImages naming its digest '
           '(docs/deployment.md).')
    if ctx.subject.requires.get('image') is False:
        return _not_needed('image', 'the flow runs no agent', RUNTIME_DOCS)
    if not language:
        return Check('image', 'fail', 'No language is named.', 'Pick the repository\'s language in the agent\'s Set up.',
                     RUNTIME_DOCS)
    if language in ctx.settings.image_languages:
        return Check('image', 'pass', f'This deployment runs {language} agents.', '', RUNTIME_DOCS)
    return Check('image', 'fail', f'No {language} image in this deployment (it has: {", ".join(images) or "none"}).',
                 fix, RUNTIME_DOCS)


def _pack(ctx: _Context) -> Check:
    if not requires(ctx.subject, 'knowledge_pack'):
        return _not_needed('pack', 'the flow does not require an approved knowledge pack', KNOWLEDGE_DOCS)
    if ctx.row is None:
        return Check('pack', 'fail', 'No stored connection to read the knowledge pack of.', ADD_CONNECTION,
                     KNOWLEDGE_DOCS)
    try:
        version = ctx.ports.knowledge_approved(ctx.subject.connection)
    except ReadFailed as error:
        return _unknown('pack', 'The knowledge pack', error, docs=KNOWLEDGE_DOCS)
    if version:
        return Check('pack', 'pass', f'Knowledge pack version {version} is approved.', '', KNOWLEDGE_DOCS)
    return Check('pack', 'fail', 'No knowledge pack version is approved for the repository.',
                 'Run the Understand flow, then approve its pack under Agents → Knowledge.', KNOWLEDGE_DOCS)


def _tenets(ctx: _Context) -> Check:
    if not requires(ctx.subject, 'tenets'):
        return _not_needed('tenets', 'the flow does not require accepted tenets', TENETS_DOCS)
    return Check('tenets', 'warn', 'The repository\'s tenets store arrives in a later release: the flow runs without '
                 'accepted tenets meanwhile.', 'Write the repository\'s TENETS.md by hand meanwhile.', TENETS_DOCS)


def _starts_from_issues(ctx: _Context) -> bool:
    return ctx.subject.trigger is not None or requires(ctx.subject, 'issues_source')


def _issues_source(ctx: _Context) -> Check:
    if not _starts_from_issues(ctx):
        return _not_needed('issues_source', 'nothing here starts a run from a GitHub issue')
    fix = ('Settings → Data sources (deployment) → GitHub Issues: add the repository, signed in with this '
           'deployment\'s GitHub App or a read-only token.')
    if ctx.row is None:
        return Check('issues_source', 'unknown', 'No stored connection to look the repository up for.', fix)
    try:
        reads = ctx.ports.issues_source_reads(_repository(ctx))
    except ReadFailed as error:
        return _unknown('issues_source', 'The Issues source', error, fix)
    if reads:
        return Check('issues_source', 'pass', f'The deployment\'s GitHub Issues source reads {_repository(ctx)}.')
    return Check('issues_source', 'fail', f'The deployment\'s GitHub Issues source has not read {_repository(ctx)} '
                 'yet (its first read follows its next schedule, every 30 minutes).', fix)


def _issue_label(ctx: _Context) -> Check:
    trigger = ctx.subject.trigger
    if trigger is None:
        return _not_needed('issue_label', 'the agent has no github_issue trigger')
    label = str(trigger.get('label') or '')
    private = (ctx.row or {}).get('repository_private') is True
    if not label:
        if private:
            return Check('issue_label', 'warn', 'No label: any issue of the private repository may start a run.',
                         'Set the trigger\'s label (voc-agent) to choose which issues start one.')
        return Check('issue_label', 'fail', 'A public repository\'s issue starts a run only with the trigger\'s label, '
                     'and the trigger names none.', 'Set the trigger\'s label (voc-agent).')
    return Check('issue_label', 'unknown', f'Issues labelled {label} start a run; whether the label exists on the '
                 'repository is not read from here.', f'Create the {label} label on the repository, and let only its '
                 'maintainers put it on an issue.')


def _dial(ctx: _Context) -> Check:
    fix = ('An administrator sets this person\'s way of working to AI-assisted or AI-driven (Administration → Users); '
           'with AI-assisted, each push waits for a person\'s go on the run.')
    if not ctx.subject.person:
        return Check('dial', 'fail', 'No person to run as: the agent runs as the administrator who enables it.', fix,
                     TRUST_DOCS)
    try:
        mode = ctx.ports.mode(ctx.subject.person)
    except ReadFailed as error:
        return _unknown('dial', 'The way of working', error, docs=TRUST_DOCS)
    allowed, shown = allowed_modes(ctx.subject), mode.replace('_', '-')
    if mode in allowed:
        return Check('dial', 'pass', f'The runs follow a {shown} way of working, which this flow runs in.', '',
                     TRUST_DOCS)
    return Check('dial', 'fail', f'The person the runs follow works {shown} (no stored AI-assisted or AI-driven way of '
                 f'working is Human-driven: a run pushes nothing), and this flow runs only '
                 f'{", ".join(mode.replace("_", "-") for mode in sorted(allowed))}.', fix, TRUST_DOCS)


def _budget(ctx: _Context) -> Check:
    budget = ctx.subject.budget_usd
    if budget is None or budget <= 0:
        return Check('budget', 'fail', 'The flow has no monthly budget.', 'Set the flow\'s monthly budget in its '
                     'Workflow tab.', COST_DOCS)
    return Check('budget', 'pass', f'The flow\'s monthly budget is {budget} USD.', '', COST_DOCS)


def _hard_cap(ctx: _Context) -> Check:
    try:
        on = ctx.ports.hard_cap_on()
    except ReadFailed as error:
        return _unknown('hard_cap', 'The hard cap', error, docs=COST_DOCS)
    budget = ctx.subject.budget_usd
    if not on:
        return Check('hard_cap', 'warn', 'The hard cap is off: a flow\'s budget raises alerts, and no run is refused '
                     'for it.', 'Turn the hard cap on under Agents → Spend to bound every run by its flow\'s budget.',
                     COST_DOCS)
    if not ctx.subject.workflow_id or budget is None:
        return Check('hard_cap', 'pass', 'The hard cap is on: a run starts only within its flow\'s budget.', '',
                     COST_DOCS)
    try:
        spent = ctx.ports.month_spend_usd(ctx.subject.workflow_id)
    except ReadFailed as error:
        return _unknown('hard_cap', 'This month\'s spend', error, docs=COST_DOCS)
    if spent >= budget:
        return Check('hard_cap', 'fail', f'The hard cap is on and the flow spent {spent} of its {budget} USD this '
                     'month: a run is refused until next month.', 'Raise the flow\'s monthly budget, or wait for '
                     'the next month (UTC).', COST_DOCS)
    return Check('hard_cap', 'pass', f'The hard cap is on; the flow spent {spent} of its {budget} USD this month.', '',
                 COST_DOCS)


def _bedrock_models(ctx: _Context) -> Check:
    models = flow_models(ctx.subject.definition, ctx.settings.card_models)
    if not models:
        return Check('bedrock_models', 'fail', 'The flow names no role with a model.', 'Add the flow\'s steps.',
                     MODELS_DOCS)
    try:
        answered = ctx.ports.models_access(list(models))
    except ReadFailed:
        answered = {}
    statuses = {model: str(answered.get(model) or 'unknown') for model in models}
    missing = [f'{model} ({status}, for {", ".join(models[model])})' for model, status in statuses.items()
               if status not in (MODEL_AVAILABLE, 'unknown')]
    unread = [model for model, status in statuses.items() if status == 'unknown']
    fix = ('In the Bedrock console (Model access), enable each model for this account and region; Administration → '
           'AI models shows each one\'s access.')
    if missing:
        return Check('bedrock_models', 'fail', f'Not available: {"; ".join(missing)}.', fix, MODELS_DOCS)
    if unread:
        return Check('bedrock_models', 'unknown', f'Not read: {", ".join(unread)}.', fix, MODELS_DOCS)
    return Check('bedrock_models', 'pass', f'Available: {", ".join(models)}.', '', MODELS_DOCS)


def _agentcore_quota(ctx: _Context) -> Check:
    fix = ('Ask for a higher "Active Session Workloads per Account" quota (Service Quotas → Amazon Bedrock AgentCore), '
           'or deploy with a lower -c engineeringMaxSessions.')
    try:
        quota = ctx.ports.session_quota()
    except ReadFailed as error:
        return _unknown('agentcore_quota', 'The AgentCore sessions quota', error, fix, RUNTIME_DOCS)
    wanted = ctx.settings.max_sessions
    if quota >= wanted:
        return Check('agentcore_quota', 'pass', f'The account runs {int(quota)} sessions at once; this deployment uses '
                     f'up to {wanted}.', '', RUNTIME_DOCS)
    return Check('agentcore_quota', 'fail', f'The account runs {int(quota)} sessions at once, below this '
                 f'deployment\'s {wanted}.', fix, RUNTIME_DOCS)


def _memory_setting(ctx: _Context) -> Check:
    mib, region = ctx.settings.build_memory_mib, ctx.settings.region
    if mib == 0:
        return Check('memory_setting', 'pass', 'Every role runs at the standard size (2 vCPU, 8 GB).', '',
                     RUNTIME_DOCS)
    if mib == BUILD_MEMORY_MIB and region in REGIONS_WITHOUT_BUILD_SIZES:
        return Check('memory_setting', 'fail', f'-c engineeringBuildMemoryMiB={mib} in {region}, where CloudFormation '
                     'does not take a runtime\'s resource configuration: the deploy fails.',
                     'Deploy with -c engineeringBuildMemoryMiB=0.', RUNTIME_DOCS)
    return Check('memory_setting', 'warn', f'The build roles run with {mib} MiB committed; check that CloudFormation in '
                 f'{region or "this region"} takes it (aws cloudformation describe-type --type RESOURCE --type-name '
                 'AWS::BedrockAgentCore::Runtime).', '', RUNTIME_DOCS)


def _network(ctx: _Context) -> Check:
    if ctx.settings.network:
        return Check('network', 'pass', 'The sessions run in the deployment\'s VPC, TCP 443 out only.', '',
                     RUNTIME_DOCS)
    return Check('network', 'fail', 'The sessions have no network: no agent runtime is made.',
                 'Deploy with -c engineeringAgentNetwork naming private subnets whose way out reaches the hosts the '
                 'agents need (docs/deployment.md).', RUNTIME_DOCS)


def _session_storage(ctx: _Context) -> Check:
    try:
        held = ctx.ports.probe_storage()
    except ReadFailed as error:
        return _unknown('session_storage', 'The workspace bucket', error,
                        'Check that VocCoreStack deployed the voc-eng-workspace bucket.', RUNTIME_DOCS)
    if held:
        return Check('session_storage', 'pass', 'The workspace bucket takes create-only puts.', '', RUNTIME_DOCS)
    return Check('session_storage', 'fail', 'The workspace bucket took a put without the create-only rule.',
                 'Redeploy VocCoreStack: its bucket policy refuses every put without If-None-Match.', RUNTIME_DOCS)


_CHECKS: Final[Mapping[str, Callable[[_Context], Check]]] = {
    'connection': _connection, 'app_installation': _app_installation, 'ci_attestation': _ci_attestation,
    'ci_protection': _ci_protection, 'image': _image, 'pack': _pack, 'tenets': _tenets,
    'issues_source': _issues_source, 'issue_label': _issue_label, 'dial': _dial, 'budget': _budget,
    'hard_cap': _hard_cap, 'bedrock_models': _bedrock_models, 'agentcore_quota': _agentcore_quota,
    'memory_setting': _memory_setting, 'network': _network, 'session_storage': _session_storage,
}


def evaluate(subject: Subject, ports: ReadinessPorts, settings: Settings,
             only: Iterable[str] | None = None) -> Report:
    """Every check of ``subject`` (``only``: just those ids, in ``CHECK_IDS``' order: Enable asks the required ones)."""
    wanted = set(CHECK_IDS if only is None else only)
    ctx = _Context(subject, ports, settings)
    if subject.connection:
        try:
            ctx.row = ports.connection(subject.connection)
        except ReadFailed as error:
            ctx.row_error = error
    return Report(subject, tuple(_CHECKS[check_id](ctx) for check_id in CHECK_IDS if check_id in wanted))
