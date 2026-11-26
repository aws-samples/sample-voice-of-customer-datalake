"""voc-retention: an erasure by email reaches voc-participants (7.72.00, projects 3g2; TENETS.md D5;
docs/multi-workspace.md, the project plan's 3g2).

A participant (shared/participants_store.py) is one person per address in one scope, the deployment or a workspace,
and its address guard (``EMAIL#{sha}`` / ``PERSON``, a workspace's ``WS#{ws}#EMAIL#{sha}``) names its person id. The
same address in two workspaces is two people. So an erasure by email without a source finds the people the address
names, never by a Scan, and erases each with the participant erasure itself (shared/participants_erasure.py
``erase_person``, in that person's scope, under the job's legal basis; the actor is the job: the admin who started it,
``kind`` ``erasure`` and the job id). That writes the participant's own tombstone and ``AUDIT#delete`` row first, then
deletes the guard, the memberships, the project links, the tokens and the person:

- the deployment's job looks the address up in the deployment's scope, then in every workspace the platform lists
  (workspaces.py: the listing's pages, and its re-walk of the workspaces renamed or created meanwhile);
- a workspace's own job (7.09.00) looks it up in that workspace only (its cursor may name no other:
  ``workspaces.checked_page``).

Without voc-workspaces the deployment's job reads its own scope only and says ``participants_walked: false`` (it could
list no workspace), never complete.

In each scope, one strongly consistent GetItem of the guard and one Query (its pages, at most ``_INDEX_PAGES``) of the
scope's people index (``gsi1``, ``PEOPLE`` / ``WS#{ws}#PEOPLE``, its sort key the lower-cased address:
``people_index_pk``), their ids united, so a person whose erasure was cut after its guard went (an erasure deletes the
guard first and the person last) is still found, beside a newer person's guard too; the deployment's job also reads
each listed workspace's saved row (three reads per listed workspace). The address is normalised as the guard's is
(shared/engagement_common.py ``normalize_email``: trimmed and lower-cased, the alert recipients' rule), never with the
walks' ``casefold``, so the hash is the guard's; an address that rule refuses can be no participant's, and the phase
reads nothing.

Saved before anything is deleted: the ids a step resolves are saved, with their scopes, before any is erased, in the
job's own partition of voc-aggregates (``JOB#erasure``, a workspace's ``WS#{ws}#JOB#erasure``) under the guard's own
hash, ``PARTICIPANTS#{sha}``: a string set (``people``) of ``{scope}#{person id}`` (``deployment`` for the
deployment's), added to by ``ADD`` and taken from by ``DELETE``, so two jobs of one address never drop each other's.
Each person is taken off once erased, or once found gone (a strongly consistent read of the person says so: a
``NotFoundError`` alone does not, ``erase_person``'s own read being eventually consistent). The deployment's walk also
reads each listed workspace's saved row in the same step (one more GetItem per workspace), so a workspace's own job
that failed is finished by the deployment's erasure too; and when its walk ends, the phase reads its own row again and
erases whom it still names (an earlier job's people, a concurrent job's), at most ``MAX_SAVED`` at a time. So an
erasure that failed after a person's guard went is finished, by id, by the next erasure of the address in that scope
or, for a workspace's person, by the deployment's. Bounded: a step saves at most one listing page's people (``ID_PAGE``
workspaces) or the deployment's scope, all of them saved, and carries at most ``MAX_SAVED`` on (the rest wait in the
saved row for the end of the walk). Every save sets the row's ``ttl`` ``SAVED_FOR`` ahead, so a failed job's row is
removed by the table's TTL, usually within a few days after its ``ttl`` (a later erasure of the address before then
finishes the ids); once its set is empty (the job's row, or a workspace's the deployment's walk emptied) its ``ttl`` is
brought to ``EMPTIED_FOR``. The key holds the address's unsalted SHA-256, as the guard's own key and the job row's
``value_hash`` do; it goes with the row.

A workspace's exports (exports.py): a workspace's export may hold the person's rows, so the workspace is noted (its
exports closed at once, swept by the ``exports`` phase) before its person is saved, and again before an entry read
from a saved row is erased.

Refusals: only a refusal that does not clear within the run is taken: a person of a workspace who holds asks or tokens
(``NotPerWorkspaceError``; none can exist until the asks move into their workspace) and a person a consistent read
still finds after ``erase_person`` answered "not found" twice. Such an entry is saved again on the job's own row (its
``ttl`` pushed ``SAVED_FOR`` past the last run that refused it: no erasure of the address for that long, and the
table's TTL removes it, usually within a few days after its ``ttl``), counted (``participants_not_erased``), and not
tried again in the same run (the cursor's ``refused``, at most ``MAX_SAVED``: past that the job fails, named; the cap
holds only while no workspace person can hold asks, the precondition the asks' move into their workspace must keep or
lift, docs/multi-workspace.md 3d and 3g2); the walk goes on and the job completes, its row saying
``participants_complete: false``. Every later erasure of the address tries it again. Any other error of the erasure (an
API error such as a throttle, a service fault or a configuration error: ``ParticipantNotErased``, its type only; an AWS
error) fails the job, the entry still saved for the next erasure of the address.

Counted: ``participants_erased`` (each person this job's call erased; a person an earlier job's cut erasure had
mostly erased is counted by the job that finishes it, and one whose erasure finished just before a crash is counted
by neither: a lower bound across retries), ``participant_guards_malformed`` (a guard or index row naming no person
id, a string one, and a workspace's saved row of the wrong shape, which is skipped: another scope's bad row never
fails the deployment's erasure; the job's own row of the wrong shape fails it. Since 7.72.03 any of them leaves the
job's row saying ``participants_complete: false``: a skipped row may still name a person whose tail stays),
``participant_index_rows_kept`` (a
workspace guard's index row left holding the address: every try to unlist it conflicted and no guard of the address is
back; the entry stays saved, like a refusal, and the next erasure unlists it. A row kept because a guard is back lists
that newer person and is not counted).

Finished by the next erasure: a person found gone (an erasure cut after its ``META`` went, the last of its rows) still
has its tail finished before its entry is forgotten (``finish_erasure``: the memberships an add committed late, and in
a workspace the guard's index row, unlisted while no guard is back).

The boards (TENETS.md D5's gap since board promotes, closed here): a board request's promote makes each supporter and
each +1's contact a participant (shared/feature_requests_promote.py ``promoted_emails`` reads the +1s' ``email`` and
``contact_email``). The ``boards`` phase de-identifies those first (boards.py), so a later promote finds no address to
make a participant of again; this phase then erases the participant. An erasure of a person by id
(``DELETE /participants/people/{id}``) still leaves their +1s: the erasure by email reaches both.

The cursor (a hand-over carries it): the listing walk's state (workspaces.py ``start``), whether the deployment's scope
was read (``deployment_done``), the people resolved and not yet erased (``to_erase``) and those refused in this run
(``refused``), each at most ``MAX_SAVED``. A carried state of the wrong shape fails the job (ValueError), never erases
anyone else.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any, Final

from botocore.exceptions import ClientError

from jobs.retention import exports, workspaces
from jobs.retention.members import STORE_MEMBERS
from jobs.retention.runs import PARTICIPANTS_WALKED, email_without_source, job_scope
from shared.aws import is_conditional_check_failure
from shared.digests import sha256_hex
from shared.dynamo_paging import query_all
from shared.engagement_common import is_id, normalize_email
from shared.erasure_jobs import job_partition
from shared.exceptions import ApiError, NotFoundError
from shared.indexes import PARTICIPANTS_LISTING_INDEX
from shared.ingest_tables import DeploymentTable, scoped_calls, table_view
from shared.participants_erasure import erase_person, finish_erasure
from shared.participants_keys import PERSON_PARTITION_PREFIX, email_guard_key, people_index_pk, person_key
from shared.participants_store import PERSON_PREFIX
from shared.project_keys import NotPerWorkspaceError
from shared.retention import (
    GUARD_MALFORMED_COUNTER,
    INDEX_KEPT_COUNTER,
    NOT_ERASED_COUNTER,
    PARTICIPANT_COUNTER,
)
from shared.timestamps import now_iso
from shared.workspace_ids import is_workspace_id
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, WorkspaceTable, scope_from_message

#: The phase's name (handler.py) and voc-participants' key in the walk's tables.
STORE_PARTICIPANTS: Final = 'participants'
#: The saved row's sort key in a job partition: this prefix and the guard's hash of the address.
SAVED_PREFIX: Final = 'PARTICIPANTS#'
#: The saved row's string set of ``{scope}#{person id}``.
SAVED_PEOPLE: Final = 'people'
#: The scope part of a saved deployment person (never a workspace id: those start ``ws_``).
DEPLOYMENT_SCOPE: Final = 'deployment'
#: The most people a cursor carries (to erase, refused), and a final read of the saved row takes at a time.
MAX_SAVED: Final = 500
#: How far ahead of now a save sets the saved row's ``ttl``, and an emptied set's (voc-aggregates' TTL then removes
#: the row, usually within a few days after its ``ttl``).
SAVED_FOR: Final = timedelta(days=30)
EMPTIED_FOR: Final = timedelta(days=1)
#: The actor's ``kind`` on the participant's tombstone and ``AUDIT#delete`` row.
ACTOR_KIND: Final = 'erasure'
#: How many times one entry's erasure is tried in a run when the person is still there after "not found".
_TRIES: Final = 2
#: The most pages of the people index one scope's lookup of the address reads.
_INDEX_PAGES: Final = 10
_PENDING: Final = 'to_erase'
_REFUSED: Final = 'refused'
_BAD_STATE: Final = 'a carried participant is not one'
#: The refusals that will keep coming back, whatever is retried (a workspace person holding asks or tokens, which
#: ``erase_person`` refuses until they move into their workspace): the entry is kept, counted, and the walk goes on.
#: Any other error of the erasure (an API error such as a throttle or a service fault, an AWS error) fails the job,
#: the entry still saved for the next erasure of the address.
_REFUSALS: Final = (NotPerWorkspaceError,)


class _StillThere(Exception):
    """``erase_person`` answered "not found" while a consistent read still finds the person: a refusal that does not
    clear within the run."""


class ParticipantNotErased(RuntimeError):
    """``erase_person`` failed with an API error that is not a lasting refusal: the job fails (the type only)."""


def applies(run: Mapping[str, Any], tables: Mapping[str, Any]) -> bool:
    """An erasure by email that is not limited to a source, with voc-participants configured."""
    return email_without_source(run) and STORE_PARTICIPANTS in tables


def guard_address(value: object) -> str | None:
    """The address as the guard holds it (``normalize_email``'s lower-cased form), or None when that rule refuses it
    (no participant can hold such an address)."""
    try:
        return normalize_email(value)[1]
    except ValueError:
        return None


def saved_entry(scope: WorkspaceScope | None, person_id: str) -> str:
    """One saved person: ``{workspace id}#{person id}``, or ``deployment#{person id}``."""
    return f'{DEPLOYMENT_SCOPE if scope is None else scope.ws}#{person_id}'


def parsed_entry(value: object, only: str | None) -> tuple[WorkspaceScope | None, str]:
    """A saved or carried person's scope and id; ValueError when it is not one, or when a job that names workspace
    ``only`` carries anyone outside it (a malformed run state: never erased)."""
    if not isinstance(value, str) or value.count('#') != 1:
        raise ValueError(_BAD_STATE)
    scope_part, person_id = value.split('#')
    if not is_id(person_id, PERSON_PREFIX):
        raise ValueError(_BAD_STATE)
    if scope_part == DEPLOYMENT_SCOPE and only is None:
        return None, person_id
    if is_workspace_id(scope_part) and only in (None, scope_part):
        return scope_from_message({WORKSPACE_FIELD: scope_part}), person_id
    raise ValueError(_BAD_STATE)


def checked_entries(carried: object, only: str | None) -> list[str]:
    """A carried list of people (at most ``MAX_SAVED``), each checked (``parsed_entry``)."""
    if carried is None:
        return []
    if not isinstance(carried, list) or len(carried) > MAX_SAVED:
        raise ValueError(_BAD_STATE)
    for each in carried:
        parsed_entry(each, only)
    return list(carried)


class _PagedIndex:
    """One scope's people index partition as ``shared.dynamo_paging`` pages it: each ``query`` one page of
    ``partition``, and past ``_INDEX_PAGES`` pages a RuntimeError (named) rather than a person left unread."""

    def __init__(self, view: WorkspaceTable | DeploymentTable, partition: str) -> None:
        self._view = view
        self._partition = partition
        self._pages = 0

    def query(self, **request: Any) -> dict[str, Any]:
        if self._pages >= _INDEX_PAGES:
            raise RuntimeError('The people index lists more pages for one address than an erasure reads')
        self._pages += 1
        return self._view.query('gsi1pk', self._partition, **request)


def _scope_of(entry: str) -> str | None:
    """The workspace id an entry names, or None for the deployment's."""
    scope_part = entry.split('#', 1)[0]
    return None if scope_part == DEPLOYMENT_SCOPE else scope_part


class ParticipantEraser:
    """One erasure's walk of the participants (the module docstring), one step at a time."""

    def __init__(self, run: dict[str, Any], tables: Mapping[str, Any], value: str,
                 clock: Callable[[], datetime] = workspaces.utc_now) -> None:
        self._run = run
        self._participants = tables[STORE_PARTICIPANTS]
        self._aggregates = tables['aggregates']
        self._workspaces = tables.get(STORE_MEMBERS)
        self._address = guard_address(value)
        self._clock = clock

    def step(self, cursor: Mapping[str, Any] | None) -> dict[str, Any] | None:
        """One step from ``cursor`` (None: the start), and the cursor of the next; None once done: erase the next
        resolved person, else resolve the deployment's scope, else the next page of workspaces, else the next page of
        the listing, else erase whom the job's saved row still names, else the end."""
        only = workspaces.named(self._run)
        if self._address is None:
            self._run[PARTICIPANTS_WALKED] = True
            return None
        here = dict(cursor) if cursor else {**workspaces.start(self._run, self._clock), _PENDING: [], _REFUSED: []}
        if only is None and not cursor:
            here[workspaces.DEPLOYMENT_DONE] = False
        pending = checked_entries(here.get(_PENDING), only)
        refused = checked_entries(here.get(_REFUSED), only)
        if pending:
            # A person this run already refused (found again by a re-walk of a renamed workspace) is not tried twice.
            if pending[0] not in refused and not self._erase(pending[0], only):
                refused = self._refused(refused, pending[0])
            return {**here, _PENDING: pending[1:], _REFUSED: refused}
        if only is None and here.get(workspaces.DEPLOYMENT_DONE) is not True:
            return {**here, workspaces.DEPLOYMENT_DONE: True, _PENDING: self._resolve([None])}
        page = workspaces.checked_page(self._run, here)
        if page:
            scopes = [scope_from_message({WORKSPACE_FIELD: ws}) for ws in page]
            return {**here, 'ws': [], 'at': {}, _PENDING: self._resolve(scopes)}
        if not here.get('listing_done') and self._workspaces is not None:
            return workspaces.listing_page(self._run, self._workspaces, here, self._clock())
        saved, exists = self._saved(job_scope(self._run), only, set(refused))
        if saved:
            return {**here, _PENDING: saved}
        if exists:
            self._expire(job_scope(self._run))
        # The deployment's job without voc-workspaces read no workspace's people: not walked, never complete.
        self._run[PARTICIPANTS_WALKED] = only is not None or self._workspaces is not None
        return None

    @staticmethod
    def _refused(refused: list[str], entry: str) -> list[str]:
        """``refused`` with ``entry``; past ``MAX_SAVED`` people refused in one run the job fails, named (the cursor
        carries no more; the entries stay saved for the next erasure of the address)."""
        if entry in refused:
            return refused
        if len(refused) >= MAX_SAVED:
            raise RuntimeError('More participants were refused than one erasure carries')
        return [*refused, entry]

    # ── Resolve, save, erase ─────────────────────────────────────────────────────────────────────────────────────

    def _resolve(self, scopes: Sequence[WorkspaceScope | None]) -> list[str]:
        """The people the address names in each scope (its guard and its people index), all saved in the job's row
        before any of them is erased, each workspace's exports closed first; for the deployment's job, also whom each
        workspace's own saved row names (a workspace job that failed), all saved on the job's own row. At most
        ``MAX_SAVED`` are carried on: the end of the walk reads the rest from the job's row."""
        found: list[str] = []
        carried: list[str] = []
        for scope in scopes:
            found.extend(saved_entry(scope, person_id) for person_id in self._people(scope))
            if scope is not None and workspaces.named(self._run) is None:
                carried.extend(self._workspace_saved(scope))
        resolved = sorted({*found, *carried})
        # Every one of them on the job's own row (a workspace's row's too: the end of the walk reads the job's row
        # only, so what the cap leaves out is still erased), each workspace's exports closed first.
        for ws in sorted({ws for entry in resolved if (ws := _scope_of(entry)) is not None}):
            exports.note_workspace(self._run, scope_from_message({WORKSPACE_FIELD: ws}), self._aggregates)
        if resolved:
            self._save(job_scope(self._run), resolved)
        return resolved[:MAX_SAVED]

    def _workspace_saved(self, scope: WorkspaceScope) -> list[str]:
        """Whom a workspace's own saved row names; a row of the wrong shape is counted
        (``participant_guards_malformed``, so the job does not read complete) and skipped: another scope's bad row never
        fails the deployment's erasure."""
        try:
            return self._saved(scope, scope.ws, set())[0]
        except ValueError:
            workspaces.count(self._run, GUARD_MALFORMED_COUNTER)
            return []

    def _people(self, scope: WorkspaceScope | None) -> list[str]:
        """The person ids the address names in ``scope``: its guard's (one consistent GetItem) and every one its people
        index lists (one Query), so a person whose erasure was cut after its guard went is found even beside a newer
        person's guard; an id not shaped like one (or not a string) counted (``participant_guards_malformed``), never
        followed."""
        address = str(self._address)
        guard = scoped_calls(self._participants, scope).get_item(Key=email_guard_key(address, workspace=scope),
                                                                 ConsistentRead=True).get('Item')
        ids: list[object] = [] if guard is None else [guard.get('person_id')]
        ids.extend(self._indexed(scope, address))
        shaped = [each for each in ids if isinstance(each, str) and is_id(each, PERSON_PREFIX)]
        workspaces.count(self._run, GUARD_MALFORMED_COUNTER, len(ids) - len(shaped))
        return sorted(set(shaped))

    def _indexed(self, scope: WorkspaceScope | None, address: str) -> list[str]:
        """The people the scope's people index lists under the address (``gsi1``; a person keeps its row there until
        its ``META`` goes, the last of its rows), by their partition key: the key alone is asked for
        (``SPECIFIC_ATTRIBUTES``, its IAM statement's condition). Every page, at most ``_INDEX_PAGES``: an address names
        a few people in a scope (one by its guard, and any whose erasure was cut), so one page is the rule; past the
        cap the job fails, named, rather than leave a person unread."""
        request: dict[str, Any] = {
            'sort_condition': '#s = :s', 'IndexName': PARTICIPANTS_LISTING_INDEX, 'Select': 'SPECIFIC_ATTRIBUTES',
            'ProjectionExpression': '#k', 'ExpressionAttributeNames': {'#s': 'gsi1sk', '#k': 'pk'},
            'ExpressionAttributeValues': {':s': address}}
        rows = query_all(_PagedIndex(table_view(scope, self._participants), people_index_pk(workspace=scope)), request)
        prefix = (scope.prefix if scope is not None else '') + PERSON_PARTITION_PREFIX
        return [str(row['pk']).removeprefix(prefix) for row in rows if str(row.get('pk', '')).startswith(prefix)]

    def _erase(self, entry: str, only: str | None) -> bool:
        """Erase one saved person in its scope (a workspace's exports closed first), then take it off the saved rows;
        False when it is refused, or when its guard's index row is left holding the address: it is saved again on the
        job's own row (its ``ttl`` pushed ``SAVED_FOR`` past this run) and counted. A person found gone has its tail
        finished first (``finish_erasure``). Any other API error fails the job (``ParticipantNotErased``)."""
        scope, person_id = parsed_entry(entry, only)
        if scope is not None:
            exports.note_workspace(self._run, scope, self._aggregates)
        try:
            removed = self._erased(scope, person_id)
        except (*_REFUSALS, _StillThere):
            # Its type only (never a message: none may quote the address); the entry stays saved for a later erasure.
            workspaces.count(self._run, NOT_ERASED_COUNTER)
            self._save(job_scope(self._run), [entry])
            return False
        except ApiError as error:
            raise ParticipantNotErased(type(error).__name__) from error
        if removed is None:
            # Gone already, maybe by an erasure cut after its META went: its tail is finished before it is forgotten.
            removed = finish_erasure(self._participants, person_id, str(self._address), workspace=scope)
        else:
            workspaces.count(self._run, PARTICIPANT_COUNTER)
        if int(removed.get('index_rows_kept') or 0) and not self._guard_back(scope):
            # Every try conflicted and no guard of the address is back: the row still holds the address's hash, so
            # the entry stays saved for the next erasure (which unlists it) and the job is not complete.
            workspaces.count(self._run, INDEX_KEPT_COUNTER)
            self._save(job_scope(self._run), [entry])
            return False
        self._forget(entry)
        return True

    def _guard_back(self, scope: WorkspaceScope | None) -> bool:
        """Whether a guard of the address is there in ``scope`` (a person re-added meanwhile), read strongly
        consistent: then the index row the erasure kept lists it, and is that person's."""
        item = scoped_calls(self._participants, scope).get_item(
            Key=email_guard_key(str(self._address), workspace=scope), ConsistentRead=True).get('Item')
        return item is not None

    def _erased(self, scope: WorkspaceScope | None, person_id: str) -> dict[str, int] | None:
        """``erase_person``'s counts, or None when the person is gone (a consistent read says so); ``_StillThere``
        when it keeps answering "not found" for a person a consistent read still finds."""
        for _try in range(_TRIES):
            try:
                return erase_person(self._participants, person_id, legal_basis=str(self._run.get('legal_basis') or ''),
                                    actor=self._actor(), workspace=scope)
            except NotFoundError:
                if not self._present(scope, person_id):
                    return None  # erased already: by an earlier try, a concurrent job, or by id
        raise _StillThere(person_id)

    def _present(self, scope: WorkspaceScope | None, person_id: str) -> bool:
        """Whether the person's ``META`` is there, read strongly consistent."""
        item = scoped_calls(self._participants, scope).get_item(Key=person_key(person_id, workspace=scope),
                                                                ConsistentRead=True).get('Item')
        return item is not None

    def _actor(self) -> dict[str, str]:
        """Who erases: the admin who started the job (their sub), as the erasure job (``kind``, ``job_id``)."""
        return {'sub': str(self._run.get('started_by_sub') or 'system'), 'kind': ACTOR_KIND,
                'job_id': str(self._run.get('job_id') or self._run['run_id'])}

    # ── The saved rows ────────────────────────────────────────────────────────────────────────────────────────────

    def _view(self, scope: WorkspaceScope | None) -> WorkspaceTable | DeploymentTable:
        """voc-aggregates in ``scope`` (a workspace's job partition through the layer)."""
        return table_view(scope, self._aggregates)

    def _key(self, scope: WorkspaceScope | None) -> dict[str, str]:
        return {'pk': job_partition(scope), 'sk': f'{SAVED_PREFIX}{sha256_hex(str(self._address))}'}

    def _ttl(self, ahead: timedelta) -> int:
        return int((self._clock() + ahead).timestamp())

    def _save(self, scope: WorkspaceScope | None, entries: list[str]) -> None:
        """Add ``entries`` to ``scope``'s saved set, its ``ttl`` ``SAVED_FOR`` ahead."""
        self._view(scope).update_item(
            self._key(scope), UpdateExpression='ADD #people :people SET #at = :now, #ttl = :ttl',
            ExpressionAttributeNames={'#people': SAVED_PEOPLE, '#at': 'updated_at', '#ttl': 'ttl'},
            ExpressionAttributeValues={':people': set(entries), ':now': now_iso(), ':ttl': self._ttl(SAVED_FOR)})

    def _forget(self, entry: str) -> None:
        """Take ``entry`` off the job's saved row and, for a workspace's person, off that workspace's (a row that is
        gone is left gone: the condition fails and nothing is created)."""
        job = job_scope(self._run)
        ws = _scope_of(entry)
        scopes = [job] if ws is None or (job is not None and job.ws == ws) else [
            job, scope_from_message({WORKSPACE_FIELD: ws})]
        for scope in scopes:
            try:
                self._view(scope).update_item(self._key(scope), UpdateExpression='DELETE #people :people',
                                              ConditionExpression='attribute_exists(pk)',
                                              ExpressionAttributeNames={'#people': SAVED_PEOPLE},
                                              ExpressionAttributeValues={':people': {entry}})
            except ClientError as error:
                if not is_conditional_check_failure(error):
                    raise
                continue
            if scope is not job:
                # Another scope's row this run emptied (a workspace's): its ttl brought forward too.
                self._expire(scope)

    def _saved(self, scope: WorkspaceScope | None, only: str | None, skip: set[str]) -> tuple[list[str], bool]:
        """The people ``scope``'s saved row names (sorted, but ``skip``, at most ``MAX_SAVED``, each checked: a
        workspace's row may name that workspace's people only), and whether the row exists."""
        item = self._view(scope).get_item(self._key(scope), ConsistentRead=True).get('Item')
        if item is None:
            return [], False
        people = item.get(SAVED_PEOPLE)
        if people is None:
            return [], True
        if not isinstance(people, set):
            raise ValueError(_BAD_STATE)
        listed = [each for each in sorted(people) if each not in skip][:MAX_SAVED]
        for each in listed:
            parsed_entry(each, only if scope is None else scope.ws)
        return listed, True

    def _expire(self, scope: WorkspaceScope | None) -> None:
        """``scope``'s emptied saved row gets its ``ttl`` ``EMPTIED_FOR`` ahead (removed by the table's TTL, usually
        within a few days after its ``ttl``); a row that names someone again meanwhile keeps the ``ttl`` its save set."""
        try:
            self._view(scope).update_item(
                self._key(scope), UpdateExpression='SET #ttl = :ttl',
                ConditionExpression='attribute_exists(pk) AND attribute_not_exists(#people)',
                ExpressionAttributeNames={'#ttl': 'ttl', '#people': SAVED_PEOPLE},
                ExpressionAttributeValues={':ttl': self._ttl(EMPTIED_FOR)})
        except ClientError as error:
            if not is_conditional_check_failure(error):
                raise
