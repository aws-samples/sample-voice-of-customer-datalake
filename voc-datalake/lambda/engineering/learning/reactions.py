"""People's reactions on the host, as the runtime records them (7.10.00; docs/autonomous-engineering.md, "Getting
better": people's reactions).

The broker reads them (its ``reactions`` operation, ``connectors/reactions.py``: bounded, trust-filtered, redacted);
this keeps each read and answers it to its readers:

- **The rows**, in the run's own partition, each written once and never changed (D1):
  ``WS#<ws>#RUN#<run>`` / ``REACTIONS#<read_at>``: the read as the broker answered it (``voc-reactions/1``, checked
  again here: ``checked``; the authors' handles kept, since only administrators read the monitor), who asked
  (``schedule`` or ``human:<subject>``) and when. ``latest`` is one Query of at most one row. Beside them, one
  ``REACTIONS_ASK`` row per run, the hand trigger's rate limit (``claim_ask``: at most one ask in a rolling 60 minutes;
  a limiter, not a record, so it is written over once the hour has passed or the ask was released).
- **The coach's port** (``HostReactions``, ``retrospective.py``): ``host_reactions`` turns the latest read into the
  people's comments of a failure's evidence (the revert, people's commits after the merge, then each kept reaction,
  newest first), each author a label (``reviewer-1``, …), never a handle; the coach's prompt fences each as data
  (``coach/prompt.py``).
- **The run monitor** (``monitor.py``): ``view``, the latest read with its counts and each reviewer's latest state.
- **The scorecards' human edits** (``human_edits``): what a read says of changes requested, people's commits after the
  merge and a revert, which ``reactions_read.py`` writes as create-only rows beside each version's scorecards.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.connectors.reactions import (
    EDIT_WINDOW_DAYS,
    ITEM_KINDS,
    MAX_ITEMS,
    MAX_LISTED_FILES,
    REVIEW_STATES,
    SCHEMA,
    STATES,
    clean_body,
    handle,
    iso,
)
from engineering.learning.retrospective import HostReaction
from engineering.rows import amount_attr, get_row, put_once, run_pk, string_attr
from engineering.run_links import HOSTS, valid_number
from shared.aws import is_conditional_check_failure

#: A read's row, and an administrator's hand trigger's (not under ``REACTIONS#``, so ``latest`` never reads one).
READ_PREFIX: Final = 'REACTIONS#'
ASK_SK: Final = 'REACTIONS_ASK'
#: The hand trigger's window: one ask per run in any this many seconds.
ASK_SECONDS: Final = 3600
#: Who asked for a read, besides a person (``human:<subject>``).
SCHEDULE: Final = 'schedule'
_OBJECT_ID_CHARS: Final = frozenset('0123456789abcdef')


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _object_id(value: object) -> str:
    text = value.lower() if isinstance(value, str) else ''
    return text if len(text) in (40, 64) and set(text) <= _OBJECT_ID_CHARS else ''


def _count(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _item(raw: object) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    kind, state, author, at = raw.get('kind'), raw.get('state'), handle(raw.get('author')), iso(raw.get('at'))
    if kind not in ITEM_KINDS or not author or not at or (state and state not in REVIEW_STATES):
        return None
    return {'kind': str(kind), 'state': str(state or ''), 'author': author, 'at': at, 'body': clean_body(raw.get('body'))}


def _edits(raw: object) -> dict[str, Any]:
    edits = raw if isinstance(raw, dict) else {}
    files = edits.get('files')
    listed = [path for path in (files if isinstance(files, list) else [])
              if isinstance(path, str) and 0 < len(path) <= 1024 and path.isprintable()]
    return {'people_commits': _count(edits.get('people_commits')), 'files': listed[:MAX_LISTED_FILES],
            'paths_read': _count(edits.get('paths_read')), 'paths_total': _count(edits.get('paths_total'))}


def checked(raw: object) -> dict[str, Any] | None:
    """The broker's answer (``voc-reactions/1``) as it is kept: every field checked again and bounded (at most
    ``MAX_ITEMS`` reactions, each body cleaned again), unknown fields dropped; None for none or one off its shape."""
    if not isinstance(raw, dict) or raw.get('schema') != SCHEMA or raw.get('state') not in STATES:
        return None
    link = raw.get('pull_request')
    link = link if isinstance(link, dict) else {}
    host, number, url = link.get('host'), link.get('number'), link.get('url')
    if host not in HOSTS or not valid_number(number) or not isinstance(url, str) or len(url) > 1024:
        return None
    items = raw.get('items')
    kept = [found for found in (_item(entry) for entry in (items if isinstance(items, list) else [])) if found]
    dropped = raw.get('dropped')
    dropped = dropped if isinstance(dropped, dict) else {}
    revert = _object_id(raw.get('revert_commit'))
    return {
        'schema': SCHEMA, 'pull_request': {'host': host, 'number': number, 'url': url}, 'state': raw['state'],
        'merged_at': iso(raw.get('merged_at')), 'merge_commit': _object_id(raw.get('merge_commit')),
        'items': kept[:MAX_ITEMS],
        'dropped': {'outsiders': _count(dropped.get('outsiders')), 'bots': _count(dropped.get('bots'))},
        'reverted': bool(revert), 'revert_commit': revert, 'edits_after_merge': _edits(raw.get('edits_after_merge')),
        'more': raw.get('more') is True,
    }


@dataclass(frozen=True)
class Recorded:
    """A read as its row keeps it: when, who asked, and what the broker answered (``checked``)."""

    read_at: str
    asked_by: str
    found: dict[str, Any]


def _reviewers(items: list[dict[str, str]]) -> list[dict[str, str]]:
    """Each reviewer's latest review state (items are newest first), in that order."""
    seen: dict[str, dict[str, str]] = {}
    for item in items:
        if item['kind'] == 'review' and item['author'] not in seen:
            seen[item['author']] = {'reviewer': item['author'], 'state': item['state'], 'at': item['at']}
    return list(seen.values())


def view(recorded: Recorded | None) -> dict[str, Any] | None:
    """The run monitor's latest reactions: the read, its counts and each reviewer's latest state; None for none."""
    if recorded is None:
        return None
    found = recorded.found
    items: list[dict[str, str]] = found['items']
    reviews = [item for item in items if item['kind'] == 'review']
    counts = {state: sum(item['state'] == state for item in reviews) for state in sorted(REVIEW_STATES)}
    counts['review_comments'] = sum(item['kind'] == 'review_comment' for item in items)
    counts['comments'] = sum(item['kind'] == 'comment' for item in items)
    return {**found, 'read_at': recorded.read_at, 'asked_by': recorded.asked_by, 'counts': counts,
            'reviewers': _reviewers(items)}


@dataclass(frozen=True)
class HumanEdits:
    """What a read says a person had to do: reviews requesting changes, people's commits to the pull request's files
    after its merge (no bot's, no agent's), and whether the merge was reverted."""

    changes_requested: int = 0
    people_commits_after_merge: int = 0
    reverted: bool = False


def human_edits(found: Mapping[str, Any] | None) -> HumanEdits:
    if found is None:
        return HumanEdits()
    items: list[dict[str, str]] = found['items']
    return HumanEdits(changes_requested=sum(item['kind'] == 'review' and item['state'] == 'changes_requested'
                                            for item in items),
                      people_commits_after_merge=found['edits_after_merge']['people_commits'],
                      reverted=found['reverted'] is True)


def host_reactions(recorded: Recorded | None) -> tuple[HostReaction, ...]:
    """The latest read as the people's comments of a failure's evidence (the run's pull request, so no one task's:
    ``task_id`` ''): the revert, people's commits after the merge, then each kept reaction, newest first. No handle
    reaches the coach: each author is a label stable within the read (``reviewer-1`` the newest's, then
    ``reviewer-2``, …)."""
    if recorded is None:
        return ()
    found = recorded.found
    reactions: list[HostReaction] = []
    if found['reverted']:
        reactions.append(HostReaction('', 'revert', f"The merge was reverted by commit {found['revert_commit']}."))
    edits = found['edits_after_merge']
    if edits['people_commits']:
        reactions.append(HostReaction('', 'edit_after_merge', (
            f"{edits['people_commits']} commit(s) by people changed the pull request's files within "
            f"{EDIT_WINDOW_DAYS} days of its merge: " + ', '.join(edits['files']))))
    labels: dict[str, str] = {}
    for item in found['items']:
        label = labels.setdefault(item['author'], f'reviewer-{len(labels) + 1}')
        state = f" ({item['state'].replace('_', ' ')})" if item['state'] else ''
        said = f": {item['body']}" if item['body'] else ''
        reactions.append(HostReaction('', 'comment', f"{item['kind'].replace('_', ' ')} by {label}"
                                                     f"{state} at {item['at']}{said}"))
    return tuple(reactions)


@dataclass(frozen=True)
class AskClaim:
    """A hand trigger's claim: ``retry_after`` 0 and its ``claim`` when it was made, else the seconds to wait."""

    retry_after: int
    claim: str = ''


@dataclass(frozen=True)
class ReactionsStore:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str
    now: Callable[[], datetime] = _utc_now

    def stamp(self) -> str:
        """A read's ``read_at``: now, to the microsecond, so a run's reads sort by when they were made."""
        return self.now().strftime('%Y-%m-%dT%H:%M:%S.%fZ')

    def record(self, ws: str, run_id: str, found: Mapping[str, Any], asked_by: str, read_at: str = '') -> str:
        """``found`` (``checked``) as a new ``REACTIONS#<read_at>`` row of the run (``read_at``: ``stamp()`` when not
        given), created once: its ``read_at`` ('' when that row is there already: nothing is written over)."""
        read_at = read_at or self.stamp()
        written = put_once(self.client, self.table, {
            'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': f'{READ_PREFIX}{read_at}'}, 'kind': {'S': 'reactions'},
            'schema': {'S': SCHEMA}, 'read_at': {'S': read_at}, 'asked_by': {'S': asked_by[:240]},
            'reactions': {'S': json.dumps(found, sort_keys=True, separators=(',', ':'))}})
        return read_at if written else ''

    def latest(self, ws: str, run_id: str) -> Recorded | None:
        """The run's newest read (one Query of at most one row), None for none or one that is off its shape."""
        answer = self.client.query(
            TableName=self.table, ConsistentRead=True, ScanIndexForward=False, Limit=1,
            KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
            ExpressionAttributeValues={':pk': {'S': run_pk(ws, run_id)}, ':p': {'S': READ_PREFIX}})
        rows: list[dict[str, Any]] = answer.get('Items', [])
        if not rows:
            return None
        try:
            found = checked(json.loads(string_attr(rows[0], 'reactions') or 'null'))
        except ValueError:
            found = None
        return None if found is None else Recorded(read_at=string_attr(rows[0], 'read_at'),
                                                   asked_by=string_attr(rows[0], 'asked_by'), found=found)

    def _ask_key(self, ws: str, run_id: str) -> dict[str, Any]:
        return {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': ASK_SK}}

    def claim_ask(self, ws: str, run_id: str, actor: str) -> AskClaim:
        """An administrator's hand trigger, at most once per run in a rolling ``ASK_SECONDS``: the run's
        ``REACTIONS_ASK`` row (who, when, ``until``, and the claim's own ``claim``, its time to the microsecond) written
        only while there is none, its ``until`` has passed, or its ask was released (``release_ask``). Claimed now:
        ``retry_after`` 0 and the claim; else the seconds until one may ask again."""
        moment = self.now()
        now, claim = int(moment.timestamp()), moment.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        try:
            self.client.put_item(
                TableName=self.table, Item={**self._ask_key(ws, run_id), 'kind': {'S': 'reactions_ask'},
                                            'by': {'S': actor[:240]}, 'at': {'N': str(now)}, 'claim': {'S': claim},
                                            'until': {'N': str(now + ASK_SECONDS)}},
                ConditionExpression='attribute_not_exists(pk) OR #until <= :now OR released = :yes',
                ExpressionAttributeNames={'#until': 'until'},
                ExpressionAttributeValues={':now': {'N': str(now)}, ':yes': {'BOOL': True}})
        except ClientError as exc:
            if not is_conditional_check_failure(exc):
                raise
            held = get_row(self.client, self.table, self._ask_key(ws, run_id)) or {}
            return AskClaim(retry_after=max(1, int(amount_attr(held, 'until')) - now))
        return AskClaim(retry_after=0, claim=claim)

    def release_ask(self, ws: str, run_id: str, claim: str) -> bool:
        """The ask ``claim`` released (its read could not be handed on), so asking again is not refused: only while
        the row is still that claim, so a late release never clears a later one. False when it is not."""
        try:
            self.client.update_item(TableName=self.table, Key=self._ask_key(ws, run_id),
                                    UpdateExpression='SET released = :yes', ConditionExpression='claim = :claim',
                                    ExpressionAttributeValues={':yes': {'BOOL': True}, ':claim': {'S': claim}})
        except ClientError as exc:
            if not is_conditional_check_failure(exc):
                raise
            return False
        return True
