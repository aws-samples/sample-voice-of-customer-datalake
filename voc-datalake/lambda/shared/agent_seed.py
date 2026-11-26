"""The agents every deployment starts with (docs/autonomous-agents.md → "Default agents").

``GET /agents`` called by an admin runs :func:`ensure_default_agent` (and, with the engineering module on,
:func:`ensure_engineering_agents`) before it lists. Each seeded agent is an automation of the orchestration templates
(voc-datalake/templates/orchestration/automations/, 7.50.00), compiled into the bundle this module reads
(``shared/engineering_templates.bundle``): its marker, its agent body and the flow it gets. Each has its own marker row
in ``voc-agents`` (``AGENTSEED`` / ``META`` for "Autonomous Product"; ``AGENTSEED#<slug>`` / ``META`` for each
engineering agent: Issue triage, Bug fixer and Feature builder), which decides it ONCE per deployment:

- the marker is claimed with a conditional put (``state: seeding``); a lost race does nothing;
- "Autonomous Product": a deployment that already has any agent (archived included) is marked ``skipped``; an
  engineering agent: a deployment that already has an active agent of its name is marked ``skipped``, and any other,
  a deployment that has run for a while included, gets it once (its marker is its own, so an upgrade seeds it);
- otherwise the agent is created with its own editable copy of its workflow (the built-in template for "Autonomous
  Product", exactly what ``POST /agents`` does without a ``workflow_id``; for an engineering agent, its flow template,
  named for it and with its monthly budget), and the marker becomes ``done``.

Every seeded agent is created DISABLED: nothing runs, nothing is spent, until an admin turns it on (an engineering agent
needs its repository connection and its language first, "Set up" in the web app; its flow is seeded with its
automation's monthly budget, the owner's $50 for each, which an admin may change there or in the flow).
A failure after the claim releases the marker (``state: failed``, which a later admin GET claims again) and never
fails the listing. Deleting or archiving a seeded agent later never brings it back: the marker stays. An agent seeded
before 7.50.00 keeps the flow it was given (no stored row is rewritten); only a new deployment's Bug fixer gets the
plain Bug hunt and fix flow, Issue triage being its own agent now.
Once a marker is known to be settled, this warm container never reads it again.
"""
from __future__ import annotations

import copy
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import timedelta
from functools import partial
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared import agents_store as store
from shared import engineering_templates, workflow_schema
from shared.aws import is_conditional_check_failure
from shared.logging import logger
from shared.project_access import Caller
from shared.ws_repo import WorkspaceScope

STATE_SEEDING: Final = 'seeding'
STATE_SKIPPED: Final = 'skipped'
STATE_DONE: Final = 'done'
# A released claim. The agents API role has no DeleteItem (DELETE /agents archives), so a failed
# seed overwrites its marker with this state instead of deleting it; it is claimable again.
STATE_FAILED: Final = 'failed'
# A ``seeding`` claim older than this belongs to a request that died mid-seed (the API Lambda
# answers within API Gateway's 29 s); a later admin GET takes it over.
STALE_CLAIM: Final = timedelta(minutes=15)

#: "Autonomous Product"'s automation, and the engineering agents' in the order they are seeded. Each engineering
#: automation's ``budget.monthly_usd`` (the owner's $50, 2026-11-16) is what its seeded flow's runs may spend in a
#: calendar month, the hard cap forced on every run of it; the Set up dialog shows it and an admin changes it in the flow
#: (its Workflow tab). The agent still needs its connection and language before it can be enabled.
DEFAULT_AUTOMATION: Final = 'autonomous-product'
ENGINEERING_AUTOMATIONS: Final = ('issue-triage', 'bug-fixer', 'feature-builder')

# (table name, marker pk) pairs whose marker is known to be settled in this warm container.
_settled: set[tuple[str, str]] = set()


def automation(automation_id: str) -> Mapping[str, Any]:
    """One seeded automation of the bundle: ``seed_marker``, ``body``, ``flow``, ``monthly_budget_usd``."""
    for item in engineering_templates.bundle()['automations']:
        if item['id'] == automation_id:
            return item
    raise LookupError(f'no automation {automation_id} in the orchestration bundle')


def default_workflow_copy(table: Any, name: str, caller: Caller, *, workspace: WorkspaceScope | None = None) -> str:
    """A fresh, editable copy of the built-in template for a new agent (in ``workspace``'s library, the
    deployment's without one); its workflow id. Nothing is seeded in a workspace: this is ``POST /agents``' copy. It
    never copies an engineering flow (``voc-workflow/2``) into a workspace (ValueError, nothing written): those are the
    deployment's (3g3-c), and the template is an agents workflow."""
    definition = workflow_schema.default_template()
    if workspace is not None and definition.get('schema') == workflow_schema.SCHEMA_V2:
        raise ValueError("an engineering flow is the deployment's: it is never copied into a workspace")
    definition['name'] = f'{name} workflow'[:workflow_schema.MAX_NAME_CHARS]
    created = store.create_workflow(
        table, definition, created_by=caller.subject, username=caller.username,
        now=store.utc_now(), derived_from=workflow_schema.DEFAULT_WORKFLOW_ID, workspace=workspace,
    )
    return created['workflow_id']


def _template(template_id: str) -> dict[str, Any]:
    """An engineering flow template's definition (a copy)."""
    for template in engineering_templates.list_templates():
        if template['template_id'] == template_id:
            return copy.deepcopy(template['definition'])
    raise LookupError(f'no engineering flow template {template_id}')


def seeded_flow(automation_id: str) -> dict[str, Any]:
    """An engineering automation's flow: its template, named for the agent, with the automation's monthly budget.
    Bug fixer's is *Bug hunt and fix* as the template has it (the hunt, its board, the quality gate, the commit and the
    pull request, which the broker opens with ``Fixes #N``): Issue triage is its own agent since 7.50.00, and a Bug
    fixer seeded before keeps the triage steps 7.47.00 joined in front."""
    seeded = automation(automation_id)
    return {**_template(str(seeded['flow'])), 'name': f'{seeded["name"]} workflow'[:workflow_schema.MAX_NAME_CHARS],
            'budget': {'monthly_usd': seeded['monthly_budget_usd']}}


@dataclass(frozen=True)
class Seed:
    """One seeded agent: its marker, its body and its workflow's definition (None: the built-in template's copy)."""

    key: Mapping[str, str]
    body: Mapping[str, Any]
    flow: Callable[[], dict[str, Any]] | None = None


def _seed_of(automation_id: str, *, engineering: bool) -> Seed:
    seeded = automation(automation_id)
    return Seed(dict(seeded['seed_marker']), copy.deepcopy(seeded['body']),
                partial(seeded_flow, automation_id) if engineering else None)


DEFAULT_SEED: Final = _seed_of(DEFAULT_AUTOMATION, engineering=False)
SEED_KEY: Final = DEFAULT_SEED.key
ENGINEERING_SEEDS: Final = tuple(_seed_of(name, engineering=True) for name in ENGINEERING_AUTOMATIONS)
#: The seeded engineering automations' names, folded, in the loop's order (Issue triage, Bug fixer, Feature builder).
_LOOP_NAMES: Final = tuple(str(seed.body['name']).strip().lower() for seed in ENGINEERING_SEEDS)


def list_order(agent: Mapping[str, Any]) -> tuple[int, str, str]:
    """``GET /agents``' order (7.50.01): the agents that are not engineering agents by name, then the engineering ones,
    the seeded automations first in the loop's order (Issue triage, Bug fixer, Feature builder: the setup guide's and
    the docs'), each found by its seeded name as the guide finds it, then any other by name."""
    name = str(agent.get('name') or '')
    rank = 0
    if store.is_engineering_agent(agent):
        folded = name.strip().lower()
        rank = 1 + (_LOOP_NAMES.index(folded) if folded in _LOOP_NAMES else len(_LOOP_NAMES))
    return rank, name.lower(), str(agent.get('agent_id'))


def _settled_marker(table: Any, key: Mapping[str, str] = SEED_KEY) -> bool:
    """True when the marker says the seed is decided (``done`` / ``skipped``)."""
    item = table.get_item(Key=dict(key), ConsistentRead=True).get('Item')
    return isinstance(item, dict) and item.get('state') in (STATE_DONE, STATE_SKIPPED)


def _claim(table: Any, caller: Caller, key: Mapping[str, str] = SEED_KEY) -> bool:
    """Write the ``seeding`` marker; False when another live request (or an earlier seed) holds it.

    Claimable: no marker, a released (``failed``) one, or a ``seeding`` claim older than STALE_CLAIM.
    """
    now = store.utc_now()
    try:
        table.put_item(
            Item={**key, 'state': STATE_SEEDING, 'claimed_by': caller.subject, 'claimed_at': store.iso(now)},
            ConditionExpression=('attribute_not_exists(pk) OR #state = :failed '
                                 'OR (#state = :seeding AND claimed_at < :stale)'),
            ExpressionAttributeNames={'#state': 'state'},
            ExpressionAttributeValues={':failed': STATE_FAILED, ':seeding': STATE_SEEDING,
                                       ':stale': store.iso(now - STALE_CLAIM)},
        )
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return False
        raise
    return True


def _settle(table: Any, state: str, agent_id: str | None = None, key: Mapping[str, str] = SEED_KEY) -> None:
    item: dict[str, Any] = {**key, 'state': state, 'settled_at': store.iso(store.utc_now())}
    if agent_id:
        item['agent_id'] = agent_id
    table.put_item(Item=item)


def _workflow_for(table: Any, seed: Seed, name: str, caller: Caller) -> str:
    if seed.flow is None:
        return default_workflow_copy(table, name, caller)
    created = store.create_workflow(table, seed.flow(), created_by=caller.subject, username=caller.username,
                                    now=store.utc_now())
    return created['workflow_id']


def _already_has(seed: Seed, agents: list[dict]) -> bool:
    """Whether the deployment has what the seed would add: any agent at all for "Autonomous Product"; an active agent
    of its name for an engineering agent (one an administrator made by hand is kept, never doubled)."""
    if seed.flow is None:
        return bool(agents)
    return any(agent.get('name') == seed.body['name'] and agent.get('status') != store.AGENT_STATUS_ARCHIVED
               for agent in agents)


def _seed(table: Any, caller: Caller, categories_config: Callable[[], list[dict]],
          seed: Seed = DEFAULT_SEED) -> tuple[str, str | None]:
    """Create the seeded agent unless the deployment has it; the marker state and the agent id."""
    if _already_has(seed, store.list_agents(table)):
        return STATE_SKIPPED, None
    fields = store.normalize_agent(dict(seed.body), categories_config())
    workflow_id = _workflow_for(table, seed, fields['name'], caller)
    fields['workflow_id'] = workflow_id
    try:
        agent = store.create_agent(table, fields, created_by=caller.subject, now=store.utc_now())
    except Exception:
        _archive_orphan(table, workflow_id, caller)
        raise
    return STATE_DONE, agent['agent_id']


def _archive_orphan(table: Any, workflow_id: str, caller: Caller) -> None:
    """The workflow copy of an agent that was never created leaves the library (best effort)."""
    try:
        store.archive_workflow(table, workflow_id, archived_by=caller.subject, username=caller.username,
                               now=store.utc_now())
    except Exception:
        logger.exception('Default agent seeding could not archive its orphan workflow',
                         extra={'workflow_id': workflow_id})


def _release(table: Any, key: Mapping[str, str] = SEED_KEY) -> None:
    """Release the claim so a later admin GET retries (best effort: it is already a failure path)."""
    try:
        _settle(table, STATE_FAILED, key=key)
    except (ClientError, BotoCoreError):
        logger.exception('Default agent seeding could not release its marker')


def _ensure(table: Any, caller: Caller, categories_config: Callable[[], list[dict]], seed: Seed) -> str | None:
    """Seed ``seed`` once per deployment; the new agent's id, or None. Never raises."""
    memo = (str(getattr(table, 'name', '')), seed.key['pk'])
    if memo in _settled:
        return None
    claimed = False
    try:
        if _settled_marker(table, seed.key):
            _settled.add(memo)
            return None
        if not _claim(table, caller, seed.key):
            return None  # another request is seeding right now; not memoised, it may still fail
        claimed = True
        state, agent_id = _seed(table, caller, categories_config, seed)
        _settle(table, state, agent_id, key=seed.key)
    except Exception:
        logger.exception('Default agent seeding failed; a later admin listing retries', extra={'seed': seed.key['pk']})
        if claimed:
            _release(table, seed.key)
        return None
    _settled.add(memo)
    if agent_id:
        logger.info('Default agent created', extra={'agent_id': agent_id, 'seed': seed.key['pk']})
    return agent_id


def ensure_default_agent(table: Any, caller: Caller, categories_config: Callable[[], list[dict]]) -> str | None:
    """Seed "Autonomous Product" once per deployment; the new agent's id, or None. Never raises.

    ``categories_config`` is read only when the agent is actually created.
    """
    return _ensure(table, caller, categories_config, DEFAULT_SEED)


def ensure_engineering_agents(table: Any, caller: Caller, categories_config: Callable[[], list[dict]]) -> list[str]:
    """Seed "Issue triage", "Bug fixer" and "Feature builder" once per deployment each (the caller runs it only with
    the engineering module on); the new agents' ids. Never raises."""
    return [agent_id for seed in ENGINEERING_SEEDS
            if (agent_id := _ensure(table, caller, categories_config, seed)) is not None]
