"""voc-retention: an erasure by email reaches the engineering agents' memory (7.84.00, projects 3g3-b; TENETS.md D5;
docs/multi-workspace.md, the project plan's 3g3-b).

With ``-c engineeringAgents=true`` the agents' memory (voc-engineering, engineering/agent_memory/store.py) keeps a
person's memories, and their name on the rows they wrote, approved or confirmed elsewhere, under their USER ID: the
Cognito ``sub`` of a signed-in user of this deployment (``WS#default#AMEM#PERSON#<sub>``), never their address. Its
erasure, ``erase_person_memories``, was an administrator's call on the store only; this phase makes it for the
person the erased address names, in the deployment's erasure by email without a source (a workspace's own erasure
stays in its workspace, D8: the engineering agents are the deployment's, scope ``default``, never a workspace's).

How the address is resolved to a ``sub``: the user directory, the one place that ties an address to an account. One
``AdminGetUser`` of the user pool with the address as its ``Username``: the pool signs in by email
(``signInAliases: { email: true, username: true }``, lib/stacks/core-auth.ts), and Cognito takes an alias wherever a username is asked for
(the users API's ``_refuse_last_platform_admin`` relies on the same); an email is an alias once it is verified, and an
alias names one account at most. Every pool made since #105 matches it whatever its case (``signInCaseSensitive:
false``), so the users API storing an address as it was typed costs nothing here. A pool made before #105
(``-c omitUserPoolUsernameConfiguration=true``, its username configuration create-only) matches the exact spelling
only: the job asks again with the address lower-cased (two calls at most), and an address stored in a third spelling
is not found there (erase again with the stored spelling). An account is taken for the person only when its ``email``
is the address (compared lower-cased) and is VERIFIED: one found by a username equal to the address that holds the
address unverified could be anyone's typing, so nothing is erased for it and the job counts it
(``agent_memory_accounts_not_erased``, its row then saying ``agent_memory_complete: false``). An address the guard's
rule refuses (participants.py ``guard_address``) names nobody, and nothing is read. A directory error other than "no
such user" fails the job. Not reached: an account deleted before the erasure (``DELETE /users/{username}`` removes the
sign-in, not its data, and the address no longer names it), an account whose email changed since (an erasure of its
current address reaches it), and an account whose email is unverified and is not its username (the pool resolves no
alias for it): for the last two an admin erases by the account's current, verified address too.

Saved before anything is erased, as the participants' ids are (participants.py): the subs a lookup resolves, with
those an earlier job of the address left, go into the job's partition of voc-aggregates (``JOB#erasure`` /
``AGENT_MEMORY#{sha256 of the lower-cased address}``, a string set ``people``, its ``ttl`` ``SAVED_FOR`` ahead), and
each is taken off once erased; once empty the row's ``ttl`` is brought to ``EMPTIED_FOR``. So a job cut short (a
failure, or a hand-over, which carries them in its cursor too) is finished by the next erasure of the address, even
once the account is gone. At most ``MAX_SAVED`` (past it the job fails, named).

Each person is erased by the store's own erasure (engineering/agent_memory/erasure.py ``erase_person_rows``): first
the tombstone (``AUDIT#tombstone#agent_memory_person`` / the sub's sha256, the job's legal basis, the actor: the admin
who started the job, ``kind`` ``erasure``, the job id; a rerun keeps the first) and a delete record (``AUDIT#delete``),
then every row naming them in another scope de-identified, then their partition deleted. The tombstone also refuses
the person to the memory from then on (store.py ``_erased``), a lasting refusal even for a person the memory never
held (no delete record is written then: nothing was deleted); an operator lifts it only by deleting that one
tombstone row with the account's own credentials (no role of the app may: the audit-row guard). One person a step; a
step cut short is finished by the next (the erasure reads what is left). Counted: ``agent_memory_people_erased`` (rows
of theirs deleted) and ``agent_memory_people_refused`` (the tombstone only). The job and audit rows say
``agent_memory_walked`` (the phase ended) and ``agent_memory_complete`` (walked, and no account left unverified): the
rerun rule is every such erasure whose row does not say ``agent_memory_complete: true``.

The cursor: ``{resolved: true, pending: [sub, …]}``; one of the wrong shape fails the job (ValueError).
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.agent_memory.erasure import erase_person_rows
from jobs.retention import workspaces
from jobs.retention.engineering_lineage import ENGINEERING_SCOPE, STORE_ENGINEERING
from jobs.retention.participants import (
    SAVED_PEOPLE,
    add_saved,
    erasure_actor,
    expire_saved,
    guard_address,
    take_off_saved,
    ttl_ahead,
)
from jobs.retention.runs import AGENT_MEMORY_WALKED, email_without_source, job_scope
from shared.digests import sha256_hex
from shared.erasure_jobs import job_partition
from shared.ingest_tables import table_view
from shared.retention import AGENT_MEMORY_COUNTER, AGENT_MEMORY_NOT_ERASED_COUNTER, AGENT_MEMORY_REFUSED_COUNTER

#: The saved row's sort key in the deployment's job partition (its string set is ``SAVED_PEOPLE``, as the
#: participants' row's).
SAVED_PREFIX: Final = 'AGENT_MEMORY#'
#: The most people a cursor carries, and a saved row may name.
MAX_SAVED: Final = 50
SAVED_FOR: Final = timedelta(days=30)
EMPTIED_FOR: Final = timedelta(days=1)
#: Cognito's answer for a username or alias that names no account.
_NO_SUCH_USER: Final = 'UserNotFoundException'
#: A Cognito ``sub`` (a UUID): the person id the memory keys a signed-in user by.
_SUB: Final = re.compile(r'\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')
_BAD_STATE: Final = 'a carried agent memory person is not one'


@dataclass(frozen=True)
class Account:
    """One account of the user directory: its ``sub``, its email as stored, and whether that email is verified."""

    sub: str
    email: str
    verified: bool


#: The directory's lookup of an address (as the erasure got it, trimmed): every account whose email it may be.
Directory = Callable[[str], list[Account]]


def cognito_directory(client: Any, pool_id: str) -> Directory:
    """The user pool's lookup (the module docstring): ``AdminGetUser`` with the address as typed, then (only when that
    names nobody, a pool made before #105) lower-cased; the first account found, or none. Any error but "no such user"
    is raised (the job fails)."""
    def lookup(address: str) -> list[Account]:
        for spelled in dict.fromkeys((address, address.lower())):
            account = _account(client, pool_id, spelled)
            if account is not None:
                return [account]
        return []
    return lookup


def _account(client: Any, pool_id: str, username: str) -> Account | None:
    try:
        user = client.admin_get_user(UserPoolId=pool_id, Username=username)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == _NO_SUCH_USER:
            return None
        raise
    attributes = {a.get('Name'): a.get('Value') for a in user.get('UserAttributes') or []}
    return Account(str(attributes.get('sub') or ''), str(attributes.get('email') or ''),
                   attributes.get('email_verified') == 'true')


def applies(run: Mapping[str, Any], tables: Mapping[str, Any], directory_configured: bool) -> bool:
    """The deployment's erasure by email without a source, with voc-engineering and the user pool configured (-c
    engineeringAgents=true)."""
    return (email_without_source(run) and job_scope(run) is None and STORE_ENGINEERING in tables
            and directory_configured)


def _checked(carried: object) -> list[str]:
    """A carried or saved list of subs (at most ``MAX_SAVED``, each a sub); ValueError otherwise."""
    return workspaces.checked_strings(carried, cap=MAX_SAVED, pattern=_SUB, error=_BAD_STATE)


class AgentMemoryEraser:
    """One erasure's walk of the agents' memory (the module docstring), one step at a time."""

    def __init__(self, run: dict[str, Any], tables: Mapping[str, Any], value: str, directory: Directory, *,
                 client: Any, clock: Callable[[], datetime] = workspaces.utc_now) -> None:
        """``client``: a low-level DynamoDB client (the store's erasure writes typed values; a resource's client
        would serialize them again)."""
        self._run = run
        self._aggregates = tables['aggregates']
        self._client, self._table = client, tables[STORE_ENGINEERING].name
        self._typed = value.strip()
        self._address = guard_address(value)
        self._directory = directory
        self._clock = clock

    def step(self, cursor: Mapping[str, Any] | None) -> dict[str, Any] | None:
        """One step from ``cursor`` (None: the start): resolve and save the people; then erase the next one; None
        once every one is erased (the saved row's ``ttl`` brought forward)."""
        if self._address is None:
            self._run[AGENT_MEMORY_WALKED] = True   # an address no account can hold: nothing to reach
            return None
        if not cursor:
            return {'resolved': True, 'pending': self._resolve()}
        if cursor.get('resolved') is not True:
            raise ValueError(_BAD_STATE)
        pending = _checked(cursor.get('pending'))
        if pending:
            self._erase(pending[0])
            return {'resolved': True, 'pending': pending[1:]}
        self._expire()
        self._run[AGENT_MEMORY_WALKED] = True
        return None

    # ── Resolve and save ──────────────────────────────────────────────────────────────────────────────────────────

    def _resolve(self) -> list[str]:
        """The verified account the address names (one at most: the alias rule; more than one verified, which the
        rule rules out, is taken for none and counted), and whom an earlier job of the address left saved; all saved
        before any is erased."""
        address = str(self._address)
        matching = [account for account in self._directory(self._typed)
                    if account.email.strip().lower() == address and _SUB.fullmatch(account.sub)]
        verified = [account.sub for account in matching if account.verified]
        taken = verified if len(verified) == 1 else []
        workspaces.count(self._run, AGENT_MEMORY_NOT_ERASED_COUNTER, len(matching) - len(taken))
        people = sorted({*taken, *self._saved()})
        if len(people) > MAX_SAVED:
            raise RuntimeError('More people were saved for one address than an erasure carries')
        if people:
            add_saved(self._view(), self._key(), people, ttl_ahead(self._clock, SAVED_FOR))
        return people

    def _view(self) -> Any:
        """voc-aggregates in the job's scope (the deployment's: ``applies`` takes no workspace's job)."""
        return table_view(job_scope(self._run), self._aggregates)

    def _key(self) -> dict[str, str]:
        return {'pk': job_partition(job_scope(self._run)), 'sk': f'{SAVED_PREFIX}{sha256_hex(str(self._address))}'}

    def _saved(self) -> list[str]:
        item = self._view().get_item(self._key(), ConsistentRead=True).get('Item')
        people = (item or {}).get(SAVED_PEOPLE)
        return [] if people is None else _checked(people)

    # ── Erase ─────────────────────────────────────────────────────────────────────────────────────────────────────

    def _erase(self, sub: str) -> None:
        """The person erased from the memory (its tombstone and delete record first), then taken off the saved row;
        counted erased when any row of theirs was deleted, else refused (the tombstone only)."""
        done = erase_person_rows(self._client, self._table, ENGINEERING_SCOPE, sub, actor=erasure_actor(self._run),
                                 legal_basis=str(self._run.get('legal_basis') or ''), now=self._clock())
        workspaces.count(self._run, AGENT_MEMORY_COUNTER if done.deleted else AGENT_MEMORY_REFUSED_COUNTER)
        take_off_saved(self._view(), self._key(), sub)

    def _expire(self) -> None:
        """The emptied saved row's ``ttl`` ``EMPTIED_FOR`` ahead (a row naming someone again keeps its own)."""
        expire_saved(self._view(), self._key(), ttl_ahead(self._clock, EMPTIED_FOR))
