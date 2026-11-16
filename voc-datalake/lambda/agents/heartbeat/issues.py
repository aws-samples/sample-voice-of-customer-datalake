"""An engineering agent's ``github_issue`` trigger (7.47.00; docs/autonomous-agents.md "Engineering agents").

The heartbeat reads the GitHub issues the data lake ingested (plugins/github_issues, docs/github-issues.md) from the
feedback table's channel index (``gsi5-by-channel``, the deployment's ``CHANNEL#issue`` partition: only the
deployment's own feedback starts a run, D8), those first ingested within the trigger's look-back (``gsi1sk``, the
processing time an in-place refresh keeps), newest first, paged, at most ``MAX_ISSUE_ITEMS`` a tick. It keeps an item
when:

- it is an issue (``source_platform`` ``github_issues``, ``issue_attributes.kind`` ``issue``) of the repository of the
  agent's connection, still open;
- it is of the agent's kind (``dimensions.feedback_type``: ``bug`` for a bug agent, ``feature_request`` for a feature
  one) and inside the agent's scope;
- and it may start a run: on a public repository (a connection that does not say it is private:
  ``repository_private``, 7.45.00) only with the trigger's label, which a maintainer puts on it (anyone may open an
  issue, only a maintainer labels one); on a private repository with the label, else, with ``trusted_authors``, when
  its author is the repository's ``OWNER``, a ``MEMBER`` or a ``COLLABORATOR``, else (no label set) any issue.

The oldest kept issue that has not started a run yet (its ``ISSUE_RUN#`` row: ``shared/agents_store.py``
``issue_claimed``; at most ``MAX_ISSUE_CANDIDATES`` read a tick) starts one; the claim is written with the run, in its
transaction, so two ticks or two agents never start the same issue. A label added after the look-back has passed is
missed: the item's processing time is its first ingest.

Only the item's ids, number and repository are used; never its title or text (the run's goal is trusted text:
shared/engineering_agent_runs.py).
"""
from __future__ import annotations

from collections.abc import Iterator, Mapping
from datetime import datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Key

from shared import agents_store as store
from shared.dynamo_paging import iter_query
from shared.engineering_agent_runs import IssueRef
from shared.feedback_partitions import channel_partition
from shared.feedback_types import FEEDBACK_TYPE_KEY
from shared.github_metrics import GITHUB_SOURCE
from shared.indexes import FEEDBACK_BY_CHANNEL_INDEX

#: The GitHub issue items' channel (plugins/_shared/github_mapping.py ``issue_item``).
ISSUE_CHANNEL: Final = 'issue'
#: The most issue items one trigger reads a tick, and the most of them whose claim it reads.
MAX_ISSUE_ITEMS: Final = 500
MAX_ISSUE_CANDIDATES: Final = 25
#: GitHub's author associations of the people who maintain a repository.
TRUSTED_ASSOCIATIONS: Final = frozenset({'OWNER', 'MEMBER', 'COLLABORATOR'})
_PAGE: Final = 200
_FIELDS: Final = 'feedback_id, source_platform, category, subcategory, #dims, issue_attributes'


def issue_items(feedback_table: Any, since: datetime) -> Iterator[dict[str, Any]]:
    """The deployment's GitHub issue items first ingested after ``since``, newest first, at most ``MAX_ISSUE_ITEMS``."""
    kwargs: dict[str, Any] = {
        'IndexName': FEEDBACK_BY_CHANNEL_INDEX, 'ScanIndexForward': False, 'Limit': _PAGE,
        'KeyConditionExpression': Key('gsi5pk').eq(channel_partition(None, ISSUE_CHANNEL))
        & Key('gsi1sk').gt(store.iso(since)),
        'ProjectionExpression': _FIELDS, 'ExpressionAttributeNames': {'#dims': 'dimensions'},
    }
    yield from iter_query(feedback_table, kwargs, max_items=MAX_ISSUE_ITEMS)


def may_start(attributes: Mapping[str, Any], trigger: Mapping[str, Any], *, private: bool) -> bool:
    """The label rule (the module's doc): on a public repository only the label; on a private one the label, else a
    trusted author with ``trusted_authors``, else any issue when the trigger sets no label."""
    label = str(trigger.get('label') or '')
    labels = attributes.get('labels')
    names = {name.casefold() for name in labels if isinstance(name, str)} if isinstance(labels, list) else set()
    has_label = bool(label) and label.casefold() in names
    if not private or has_label:
        return has_label
    if trigger.get('trusted_authors') is True:
        return attributes.get('author_association') in TRUSTED_ASSOCIATIONS
    return not label


def _number(attributes: Mapping[str, Any]) -> int | None:
    number = store.plain(attributes.get('number'))
    return number if isinstance(number, int) and not isinstance(number, bool) and number > 0 else None


def matching(item: Mapping[str, Any], *, repository: str, feedback_type: str, scope: Mapping[str, Any],
             trigger: Mapping[str, Any], private: bool) -> int | None:
    """The issue's number when ``item`` may start the agent's run (the module's doc), else None."""
    attributes = item.get('issue_attributes')
    dimensions = item.get('dimensions')
    if item.get('source_platform') != GITHUB_SOURCE or not isinstance(attributes, Mapping):
        return None
    if attributes.get('kind') != 'issue' or attributes.get('state') != 'open':
        return None
    if str(attributes.get('repo') or '').lower() != repository.lower():
        return None
    if not isinstance(dimensions, Mapping) or dimensions.get(FEEDBACK_TYPE_KEY) != feedback_type:
        return None
    if not store.item_in_scope(scope, item) or not may_start(attributes, trigger, private=private):
        return None
    return _number(attributes)


def find_issue(feedback_table: Any, agents_table: Any, agent: Mapping[str, Any], trigger: Mapping[str, Any],
               connection: Mapping[str, Any], now: datetime) -> IssueRef | None:
    """The oldest issue that may start the agent's run and has started none yet; None when there is none."""
    repository = str(connection.get('repository') or '')
    settings = agent.get('engineering') or {}
    if not repository or str(connection.get('host') or 'github') != 'github':
        return None
    days = int(store.plain(trigger.get('lookback_days')) or store.DEFAULT_ISSUE_LOOKBACK_DAYS)
    found: list[IssueRef] = []
    for item in issue_items(feedback_table, now - timedelta(days=days)):
        number = matching(item, repository=repository, feedback_type=str(settings.get('feedback_type')),
                          scope=agent.get('scope') or {}, trigger=trigger,
                          private=connection.get('repository_private') is True)
        if number is not None and all(ref.number != number for ref in found):
            found.append(IssueRef(repository, number, str(item.get('feedback_id') or '')))
    for ref in reversed(found[-MAX_ISSUE_CANDIDATES:]):   # (oldest first: the read is newest first)
        if not store.issue_claimed(agents_table, ref.repository, ref.number):
            return ref
    return None
