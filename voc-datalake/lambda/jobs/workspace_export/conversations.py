"""A workspace's conversations in its export (7.24.00; docs/multi-workspace.md, "Export and delete", step 2): not
included; only how many people have any is counted.

A person's assistant conversations are theirs, and the export goes to the workspace's admins, so the export holds
none of them, as it holds no personal memory (memory.py), and no conversation total either. The manifest says only
how many people (current or former members) have at least one conversation in the workspace: no subject,
conversation id, message or count of conversations leaves. That number still reveals something: two exports compared
show how many people started (or stopped) keeping conversations in between, so whether a given member started using
the assistant can be seen when they are the only change (the manifest's note says so).

The count reads voc-conversations through the workspace layer only (shared/ws_repo.py ``WorkspaceTable.query``):

* the workspace's list of conversation owners, ``WS#{ws}#CONVERSANTS`` (shared/conversations.py ``conversant_key``),
  a page of at most ``OWNER_PAGE`` rows at a time, projected to ``sk`` alone (each row's ``sk`` is an owner's
  subject; the job's grant there allows the row's key and nothing else, so never ``first_at``);
* for each owner, one Query of ``WS#{ws}#USER#{sub}`` (``conversation_partition``) with the key condition
  ``_CONVERSATION_ROWS`` (their ``CONV#`` rows, so no ``RUNCANCEL#`` marker counts), ``Select COUNT`` and ``Limit``
  1: it reads at most one row and answers whether they have any. No row is ever returned. IAM cannot hold the job to
  that request (lib/stacks/workspace-export-worker.ts): only this module keeps it a yes-or-no.

Load: one Query of the list per 100 owners and one per owner, each reading at most one row (billed by that row's
size, so at most one conversation's, rounded up to 4 KB); the cost grows with the number of owners, not with how many
conversations they keep or how long those are.

The subjects stay in the run's checkpoint, the hand-over's event, never in the zip, the manifest or the job row.
That event is the function's own asynchronous invoke: it has no failure destination or dead-letter queue, and the job
never logs an event (shared/invocation_cost.py logs numbers only).
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Final

from jobs.workspace_export.pages import items, last_key, start
from shared.carried_values import count_of, flag_or, key_or_none
from shared.conversations import CONVERSATION_SK_PREFIX, conversation_partition
from shared.ws_repo import WorkspaceScope, WorkspaceTable, conversants_pk

__all__ = ['ConversationCount', 'carried_state', 'fresh_state']

#: The owners one page of the list yields, at most (the checkpoint carries those still to count).
OWNER_PAGE: Final = 100
#: The list's rows, projected to the owner's subject alone (``dynamodb:Attributes`` ``sk``).
_OWNERS_ONLY: Final = {'Select': 'SPECIFIC_ATTRIBUTES', 'ProjectionExpression': '#sk',
                       'ExpressionAttributeNames': {'#sk': 'sk'}}
#: Whether an owner has any conversation (``sk CONV#{id}``): a count of at most one row.
_CONVERSATION_ROWS: Final = {'sort_condition': 'begins_with(#sk, :conversation)', 'Select': 'COUNT', 'Limit': 1,
                             'ExpressionAttributeNames': {'#sk': 'sk'},
                             'ExpressionAttributeValues': {':conversation': CONVERSATION_SK_PREFIX}}
#: The checkpoint's fields: the list's next page, whether it is read to its end, the owners of its page still to
#: count (the first is next), how many people have any so far, the end.
_FIELDS: Final = ('owners', 'owners_done', 'subs', 'people', 'done')


def fresh_state() -> dict[str, Any]:
    """The state of a count not begun."""
    return {'owners': None, 'owners_done': False, 'subs': [], 'people': 0, 'done': False}


def carried_state(value: object, scope: WorkspaceScope) -> dict[str, Any]:
    """A carried count's state (the hand-over event's ``conversation_count``), checked whole for ``scope``; ValueError
    naming the field for any of the wrong shape (the job then fails: handler.py ``_fail_malformed``). An absent state,
    or an absent field, is the fresh state's (a flag carried as null too: shared/carried_values.py ``flag_or``). The
    list's cursor must be a key of ``scope``'s own owner list."""
    if value is None:
        return fresh_state()
    if not isinstance(value, Mapping) or set(value) - set(_FIELDS):
        raise ValueError('conversation_count is not a count state')
    state = {**fresh_state(), **value}
    subs = state['subs']
    if not isinstance(subs, list) or len(subs) > OWNER_PAGE or not all(isinstance(sub, str) and sub for sub in subs):
        raise ValueError('subs is not a page of owners')
    owners = key_or_none(state['owners'], 'owners')
    if owners is not None and owners['pk'] != conversants_pk(scope):
        raise ValueError("owners is not this workspace's owner list")
    return {'owners': owners, 'owners_done': flag_or(state['owners_done'], 'owners_done', default=False),
            'subs': list(subs), 'people': count_of(state['people'], 'people'),
            'done': flag_or(state['done'], 'done', default=False)}


class ConversationCount:
    """How many of one workspace's members (current or former) keep any conversation there, through its view of
    voc-conversations."""

    def __init__(self, scope: WorkspaceScope, conversations: WorkspaceTable) -> None:
        self.scope = scope
        self._conversations = conversations

    def count(self, state: dict[str, Any], time_left: Callable[[], bool]) -> bool:
        """Go on counting from ``state`` (``carried_state``'s fields), one Query at a time. True once done; False
        when ``time_left`` says no after a Query with more to do, ``state`` then where the next invocation goes on
        (the hand-over rule of memory.py's counts: one Query at least per invocation, one at most past the
        reserve)."""
        while not state['done']:
            if state['subs']:
                self._has_any(state)
            elif state['owners_done']:
                break
            else:
                self._owners_page(state)
            if (state['subs'] or not state['owners_done']) and not time_left():
                return False
        state['done'] = True
        return True

    def _owners_page(self, state: dict[str, Any]) -> None:
        page = self._conversations.query('pk', conversants_pk(self.scope), Limit=OWNER_PAGE, **_OWNERS_ONLY,
                                         **start(state['owners']))
        state['subs'] = [item['sk'] for item in items(page) if isinstance(item.get('sk'), str) and item['sk']]
        state['owners'] = last_key(page)
        state['owners_done'] = state['owners'] is None

    def _has_any(self, state: dict[str, Any]) -> None:
        """Whether the first owner still to count has any conversation: one row at most."""
        first, *rest = state['subs']
        page = self._conversations.query('pk', conversation_partition(first, self.scope), **_CONVERSATION_ROWS)
        state['people'] += 1 if int(page.get('Count') or 0) > 0 else 0
        state['subs'] = rest
