"""The default autonomous agent every deployment starts with (docs/autonomous-agents.md → "Default agent").

``GET /agents`` called by an admin runs :func:`ensure_default_agent` before it lists.
A marker row (``AGENTSEED`` / ``META``) in ``voc-agents`` decides it ONCE per deployment:

- the marker is claimed with a conditional put (``state: seeding``); a lost race does nothing;
- a deployment that already has any agent (archived included) is marked ``skipped``;
- otherwise the agent below is created, with its own editable copy of the built-in workflow
  (exactly what ``POST /agents`` does without a ``workflow_id``), and the marker becomes ``done``.

The agent is created DISABLED: nothing runs, nothing is spent, until an admin turns it on.
A failure after the claim releases the marker (``state: failed``, which a later admin GET
claims again) and never fails the listing. Deleting or archiving the seeded agent later never
brings it back: the marker stays.
Once the marker is known to be settled, this warm container never reads it again.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import timedelta
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared import agents_store as store
from shared import workflow_schema
from shared.aws import is_conditional_check_failure
from shared.logging import logger
from shared.project_access import Caller

SEED_KEY: Final = {'pk': 'AGENTSEED', 'sk': 'META'}
STATE_SEEDING: Final = 'seeding'
STATE_SKIPPED: Final = 'skipped'
STATE_DONE: Final = 'done'
# A released claim. The agents API role has no DeleteItem (DELETE /agents archives), so a failed
# seed overwrites its marker with this state instead of deleting it; it is claimable again.
STATE_FAILED: Final = 'failed'
# A ``seeding`` claim older than this belongs to a request that died mid-seed (the API Lambda
# answers within API Gateway's 29 s); a later admin GET takes it over.
STALE_CLAIM: Final = timedelta(minutes=15)

# The agent body, through store.normalize_agent (its budget defaults apply).
DEFAULT_AGENT_BODY: Final[Mapping[str, Any]] = {
    'name': 'Autonomous Product',
    'description': 'Turns recurring review problems into a PR/FAQ, PRD and prototype',
    'enabled': False,
    'scope': {'all': True},
    'instructions': '',
    'personas': {'allow_generate': True, 'fixed': []},
    'triggers': [{'kind': 'threshold', 'count': 10, 'per': 'category', 'window_days': 7}],
    'models': {},
    'output': {'visibility': 'private'},
}

# Table names whose marker is known to exist in this warm container.
_settled: set[str] = set()


def default_workflow_copy(table: Any, name: str, caller: Caller) -> str:
    """A fresh, editable copy of the built-in template for a new agent; its workflow id."""
    definition = workflow_schema.default_template()
    definition['name'] = f'{name} workflow'[:workflow_schema.MAX_NAME_CHARS]
    created = store.create_workflow(
        table, definition, created_by=caller.subject, username=caller.username,
        now=store.utc_now(), derived_from=workflow_schema.DEFAULT_WORKFLOW_ID,
    )
    return created['workflow_id']


def _settled_marker(table: Any) -> bool:
    """True when the marker says the seed is decided (``done`` / ``skipped``)."""
    item = table.get_item(Key=SEED_KEY, ConsistentRead=True).get('Item')
    return isinstance(item, dict) and item.get('state') in (STATE_DONE, STATE_SKIPPED)


def _claim(table: Any, caller: Caller) -> bool:
    """Write the ``seeding`` marker; False when another live request (or an earlier seed) holds it.

    Claimable: no marker, a released (``failed``) one, or a ``seeding`` claim older than STALE_CLAIM.
    """
    now = store.utc_now()
    try:
        table.put_item(
            Item={**SEED_KEY, 'state': STATE_SEEDING, 'claimed_by': caller.subject, 'claimed_at': store.iso(now)},
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


def _settle(table: Any, state: str, agent_id: str | None = None) -> None:
    item: dict[str, Any] = {**SEED_KEY, 'state': state, 'settled_at': store.iso(store.utc_now())}
    if agent_id:
        item['agent_id'] = agent_id
    table.put_item(Item=item)


def _seed(table: Any, caller: Caller, categories_config: Callable[[], list[dict]]) -> tuple[str, str | None]:
    """Create the default agent unless the deployment has one; the marker state and the agent id."""
    if store.list_agents(table):
        return STATE_SKIPPED, None
    fields = store.normalize_agent(dict(DEFAULT_AGENT_BODY), categories_config())
    workflow_id = default_workflow_copy(table, fields['name'], caller)
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


def _release(table: Any) -> None:
    """Release the claim so a later admin GET retries (best effort: it is already a failure path)."""
    try:
        _settle(table, STATE_FAILED)
    except (ClientError, BotoCoreError):
        logger.exception('Default agent seeding could not release its marker')


def ensure_default_agent(table: Any, caller: Caller, categories_config: Callable[[], list[dict]]) -> str | None:
    """Seed the default agent once per deployment; the new agent's id, or None. Never raises.

    ``categories_config`` is read only when the agent is actually created.
    """
    name = str(getattr(table, 'name', ''))
    if name in _settled:
        return None
    claimed = False
    try:
        if _settled_marker(table):
            _settled.add(name)
            return None
        if not _claim(table, caller):
            return None  # another request is seeding right now; not memoised, it may still fail
        claimed = True
        state, agent_id = _seed(table, caller, categories_config)
        _settle(table, state, agent_id)
    except Exception:
        logger.exception('Default agent seeding failed; a later admin listing retries')
        if claimed:
            _release(table)
        return None
    _settled.add(name)
    if agent_id:
        logger.info('Default agent created', extra={'agent_id': agent_id})
    return agent_id
