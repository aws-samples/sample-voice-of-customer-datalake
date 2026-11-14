"""Properties of a project id's deployment-wide claim (shared/ws_repo.py ``claim_project_id``, ``project_claim``,
``release_project_claim`` and ``WorkspaceTable.transact_write_items``'s ``claim``).

The claim is the one row a workspace writes outside its own partitions: it names the workspace a project id belongs
to, so a public link or an MCP pin that knows only the id is routed there. A claim written for another workspace, one
written without the project's own rows, one a caller could build or change, or a release that frees another team's
claim would let one team take or reach another's project. The tables are recording doubles.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from hypothesis import given
from hypothesis import strategies as st

from shared.test.ws_properties import PROPERTY, exactly, two_workspace_ids
from shared.ws_repo import (
    MAX_TRANSACT_ITEMS,
    PROJECT_CLAIM_INDEX,
    OutOfScopeError,
    ProjectClaim,
    WorkspaceScope,
    claim_project_id,
    project_claim,
    release_project_claim,
    ws_table,
)

PROJECTS = 'voc-projects'
#: Project ids as the code makes them: letters, digits, ``_`` and ``-``, 1 to 128.
PROJECT_IDS = st.from_regex(r'[A-Za-z0-9_-]{1,128}', fullmatch=True)
#: Not a project id: empty, too long, a ``#`` (which would name another row's key), ``/``, a space, a line break.
NOT_PROJECT_IDS = st.one_of(st.sampled_from(['', 'a#b', 'PROJECT#x', 'a/b', 'a b', 'a\n', 'x' * 129, 'é']),
                            st.integers(), st.none())
NOT_THE_DEPLOYMENT = 'a project claim names a workspace, never the deployment'
NOT_A_CLAIM = "a transaction's claim is a project claim of its own workspace"


def _projects_table() -> MagicMock:
    backing = MagicMock()
    backing.name = PROJECTS
    return backing


def _entry(ws: str, n: int) -> dict[str, Any]:
    return {'Put': {'Item': {'pk': f'WS#{ws}#PROJECT#p{n}', 'sk': 'META'}}}


# A claim is made only for a real workspace, of a well-formed project id, with its time; it carries exactly those.
@PROPERTY
@given(two_workspace_ids(), PROJECT_IDS, NOT_PROJECT_IDS,
       st.sampled_from([None, 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'acme', 7]))
def test_a_claim_is_made_for_a_workspace_and_a_project_id_only(pair, project_id, bad_id, not_a_scope):
    scope = WorkspaceScope(pair[0])
    claim = claim_project_id(project_id, workspace=scope, claimed_at='2026-11-14T08:00:00+00:00')
    assert (claim.scope, claim.project_id, claim.claimed_at) == (scope, project_id, '2026-11-14T08:00:00+00:00')
    with pytest.raises(OutOfScopeError, match=exactly(NOT_THE_DEPLOYMENT)):
        claim_project_id(project_id, workspace=not_a_scope, claimed_at='t')
    with pytest.raises(ValueError, match=exactly('a project claim says when it was made')):
        claim_project_id(project_id, workspace=scope, claimed_at='')
    with pytest.raises(OutOfScopeError, match=exactly('a project claim names a project id')):
        claim_project_id(bad_id, workspace=scope, claimed_at='t')

# A claim cannot be forged, changed or extended: only claim_project_id builds one, nothing can be set or deleted on
# it, and no subclass of it can be declared.
@PROPERTY
@given(two_workspace_ids(), PROJECT_IDS, st.sampled_from(['_scope', '_project_id', '_claimed_at', 'scope', 'x']))
def test_a_claim_cannot_be_forged_or_changed(pair, project_id, name):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    with pytest.raises(TypeError, match=exactly('a project claim is built by claim_project_id only')):
        ProjectClaim(object(), theirs, project_id, 't')
    claim = claim_project_id(project_id, workspace=mine, claimed_at='t')
    with pytest.raises(AttributeError, match=exactly('a ProjectClaim cannot be changed')):
        setattr(claim, name, theirs)
    with pytest.raises(AttributeError, match=exactly('a ProjectClaim cannot be changed')):
        delattr(claim, name)
    assert claim.scope == mine
    with pytest.raises(TypeError, match=exactly('a ProjectClaim cannot be subclassed')):
        type('Forged', (ProjectClaim,), {})


# A transaction with a claim puts the claim first, built by the view from its own workspace and table (never from the
# caller's), on a new key only, beside the project's rows, counted in the 100; a claim of another workspace, anything
# that is not the claim type itself, a claim object built around its constructor, or a table that is not
# voc-projects refuses the whole transaction before anything is sent.
@PROPERTY
@given(two_workspace_ids(), PROJECT_IDS, st.integers(min_value=1, max_value=4))
def test_a_claim_is_written_with_its_workspace_rows_or_not_at_all(pair, project_id, rows):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    entries = [_entry(mine.ws, n) for n in range(rows)]
    claim = claim_project_id(project_id, workspace=mine, claimed_at='2026-11-14T08:00:00+00:00')
    backing = _projects_table()
    with patch.dict('os.environ', {'PROJECTS_TABLE': PROJECTS}):
        ws_table(mine, backing).transact_write_items(entries, claim=claim)
        sent = backing.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        assert sent[PROJECT_CLAIM_INDEX] == {'Put': {
            'TableName': PROJECTS, 'ConditionExpression': 'attribute_not_exists(pk)',
            'Item': {'pk': f'PROJECT_ID#{project_id}', 'sk': 'CLAIM', 'workspace_id': mine.ws,
                     'claimed_at': '2026-11-14T08:00:00+00:00'}}}
        assert sent[1:] == [{'Put': {**entry['Put'], 'TableName': PROJECTS}} for entry in entries]

        forged = object.__new__(ProjectClaim)
        subclassless = MagicMock(spec=ProjectClaim, scope=mine, project_id=project_id, claimed_at='t')
        backing = _projects_table()
        for bad in (claim_project_id(project_id, workspace=theirs, claimed_at='t'), forged, subclassless,
                    {'pk': f'PROJECT_ID#{project_id}', 'sk': 'CLAIM'}):
            with pytest.raises(OutOfScopeError, match=exactly(NOT_A_CLAIM)):
                ws_table(mine, backing).transact_write_items(entries, claim=bad)
        with pytest.raises(ValueError, match=exactly(f'a TransactWriteItems takes 1 to 100 entries, '
                                                     f'not {MAX_TRANSACT_ITEMS + 1}')):
            ws_table(mine, backing).transact_write_items([_entry(mine.ws, n) for n in range(MAX_TRANSACT_ITEMS)],
                                                         claim=claim)
        with pytest.raises(OutOfScopeError, match=exactly('a key outside the workspace')):
            ws_table(mine, backing).transact_write_items([*entries, _entry(theirs.ws, 9)], claim=claim)
    for environment in ({'PROJECTS_TABLE': 'voc-aggregates'}, {}):
        with patch.dict('os.environ', environment, clear=True), \
                pytest.raises(OutOfScopeError, match=exactly('a project claim is written in the projects table only')):
            ws_table(mine, backing).transact_write_items(entries, claim=claim)
    nameless = _projects_table()
    nameless.name = ''
    with patch.dict('os.environ', {'PROJECTS_TABLE': ''}), \
            pytest.raises(OutOfScopeError, match=exactly('a project claim is written in the projects table only')):
        ws_table(mine, nameless).transact_write_items(entries, claim=claim)
    assert not backing.meta.client.transact_write_items.called
    # Exactly 100 with the claim goes through.
    with patch.dict('os.environ', {'PROJECTS_TABLE': PROJECTS}):
        full = _projects_table()
        ws_table(mine, full).transact_write_items([_entry(mine.ws, n) for n in range(MAX_TRANSACT_ITEMS - 1)],
                                                  claim=claim)
        assert len(full.meta.client.transact_write_items.call_args.kwargs['TransactItems']) == MAX_TRANSACT_ITEMS


# Reading a claim routes to the workspace it names (one consistent read of that field only), to none when there is
# no claim, and never to the deployment when the claim names no workspace id.
@PROPERTY
@given(two_workspace_ids(), PROJECT_IDS, st.sampled_from(['', 'acme', 'WS#x', 7, None]), NOT_PROJECT_IDS)
def test_a_claim_routes_to_the_workspace_it_names(pair, project_id, malformed, bad_id):
    mine = WorkspaceScope(pair[0])
    table = MagicMock()
    table.get_item.return_value = {'Item': {'workspace_id': mine.ws}}
    assert project_claim(table, project_id) == mine
    table.get_item.assert_called_once_with(Key={'pk': f'PROJECT_ID#{project_id}', 'sk': 'CLAIM'},
                                           ConsistentRead=True, ProjectionExpression='#ws',
                                           ExpressionAttributeNames={'#ws': 'workspace_id'})
    table.get_item.return_value = {}
    assert project_claim(table, project_id) is None
    table.get_item.return_value = {'Item': {'workspace_id': malformed}}
    with pytest.raises(ValueError, match=exactly('a project claim names no workspace')):
        project_claim(table, project_id)
    table = MagicMock()
    with pytest.raises(OutOfScopeError, match=exactly('a project claim names a project id')):
        project_claim(table, bad_id)
    assert not table.get_item.called


# A workspace frees only its own claim: the delete is conditional on the claim naming it, a claim of another
# workspace (or none) is left and answered False, any other fault is raised, and the deployment frees nothing.
@PROPERTY
@given(two_workspace_ids(), PROJECT_IDS, st.sampled_from(['ConditionalCheckFailedException', 'ThrottlingException']))
def test_a_workspace_frees_its_own_claim_only(pair, project_id, code):
    mine = WorkspaceScope(pair[0])
    table = MagicMock()
    assert release_project_claim(table, project_id, workspace=mine) is True
    table.delete_item.assert_called_once_with(Key={'pk': f'PROJECT_ID#{project_id}', 'sk': 'CLAIM'},
                                              ConditionExpression='#ws = :ws',
                                              ExpressionAttributeNames={'#ws': 'workspace_id'},
                                              ExpressionAttributeValues={':ws': mine.ws})
    error = ClientError({'Error': {'Code': code, 'Message': ''}}, 'DeleteItem')
    table.delete_item.side_effect = error
    if code == 'ConditionalCheckFailedException':
        assert release_project_claim(table, project_id, workspace=mine) is False
    else:
        with pytest.raises(ClientError) as raised:
            release_project_claim(table, project_id, workspace=mine)
        assert raised.value is error
    table = MagicMock()
    not_scopes: list[Any] = [None, mine.ws]
    for not_a_scope in not_scopes:
        with pytest.raises(OutOfScopeError, match=exactly(NOT_THE_DEPLOYMENT)):
            release_project_claim(table, project_id, workspace=not_a_scope)
    assert not table.delete_item.called
