"""A series' comment threads and its persona review per workspace (docs/multi-workspace.md, the project plan, 3e;
7.37.00).

shared/document_comments.py and shared/document_review.py take a keyword-only ``workspace``: in one, a thread is
``WS#{ws}#DCOMMENTS#{project}#{series}`` / ``C#{id}``, every call goes through shared/ws_repo.py ``ws_table``, and a
new thread first lists its series in the project's own partition (``WS#{ws}#PROJECT#{id}`` /
``COMMENT_SERIES#{series}``); without one every request is the one sent before (pinned below on a recording table).
Three scopes hold the same project and series ids here: the deployment and two workspaces. Series ids are the same
in every scope (shared/document_series.py ``series_id``: project ids are unique in the deployment).
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from shared import document_comments as dc
from shared.document_review import run_review
from shared.project_keys import comments_pk, project_pk
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import OutOfScopeError, WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
SCOPES = (None, A, B)
PROJECT = 'proj_shared_id'
SERIES = 'ser_' + 'a' * 24
DOCUMENT = {'document_id': 'doc_1', 'version': 1, 'content': 'Parcels arrive late every Friday in the north.'}


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('voc-projects-test')


def _name(scope) -> str:
    return 'deployment' if scope is None else scope.ws


def _thread(table, scope, text: str = '') -> dict[str, Any]:
    item = dc.thread_item(project_id=PROJECT, series_id=SERIES, document=DOCUMENT,
                          author=dc.user_author('sub-ada', 'Ada'), text=text or _name(scope), anchor=None,
                          workspace=scope)
    dc.put_thread(table, item, workspace=scope)
    return item


def _partition(table, pk: str) -> list[dict]:
    return table.query(KeyConditionExpression=Key('pk').eq(pk), ConsistentRead=True)['Items']


def test_each_scope_reads_and_writes_only_its_own_threads(table):
    made = {_name(scope): _thread(table, scope) for scope in SCOPES}
    for scope in SCOPES:
        assert [row['text'] for row in dc.list_threads(table, PROJECT, SERIES, workspace=scope)] == [_name(scope)]
        own = made[_name(scope)]
        assert (dc.get_thread(table, PROJECT, SERIES, own['comment_id'], workspace=scope) or {}).get('text') == (
            _name(scope))
        others = [item for name, item in made.items() if name != _name(scope)]
        assert [dc.get_thread(table, PROJECT, SERIES, item['comment_id'], workspace=scope) for item in others] == [
            None, None]


def test_a_workspace_thread_is_in_the_workspaces_series_partition(table):
    item = _thread(table, A)
    assert item['pk'] == f'WS#{A.ws}#DCOMMENTS#{PROJECT}#{SERIES}'
    assert item['pk'] == comments_pk(PROJECT, SERIES, workspace=A)
    assert _partition(table, comments_pk(PROJECT, SERIES)) == []


def test_a_workspace_thread_lists_its_series_in_the_project_first_and_once(table):
    _thread(table, A, 'first')
    [listed] = _partition(table, project_pk(PROJECT, workspace=A))
    _thread(table, A, 'second')
    assert _partition(table, project_pk(PROJECT, workspace=A)) == [listed]
    assert (listed['sk'], listed['series_id']) == (f'COMMENT_SERIES#{SERIES}', SERIES)
    # The deployment keeps no list (its requests are the ones sent before), nor does the other workspace.
    _thread(table, None)
    assert _partition(table, project_pk(PROJECT)) == []
    assert _partition(table, project_pk(PROJECT, workspace=B)) == []


def test_a_reply_a_status_and_a_delete_stay_in_their_scope(table):
    made = {_name(scope): _thread(table, scope) for scope in SCOPES}
    thread = made[A.ws]
    replied = dc.append_reply(table, thread, dc.reply_item(dc.user_author('sub-bo', 'Bo'), 'Agreed'), workspace=A)
    assert [reply['text'] for reply in replied['replies']] == ['Agreed']
    assert dc.set_status(table, thread, dc.STATUS_RESOLVED, 'Bo', workspace=A)['status'] == dc.STATUS_RESOLVED
    for scope in (None, B):
        [row] = dc.list_threads(table, PROJECT, SERIES, workspace=scope)
        assert (row['status'], row['replies']) == (dc.STATUS_OPEN, [])
    dc.delete_thread(table, thread, workspace=A)
    assert dc.list_threads(table, PROJECT, SERIES, workspace=A) == []
    assert [len(dc.list_threads(table, PROJECT, SERIES, workspace=scope)) for scope in (None, B)] == [1, 1]


def _addressed(version: int, *, addressed: bool = True) -> dict[str, Any]:
    return dc.addressed_entry(version=version, document_id=f'doc_{version}', by_kind=dc.ADDRESSED_BY_USER,
                              by_sub='sub-ada', addressed=addressed)


def test_an_addressed_mark_stays_in_its_scope(table):
    """Revise from comments' mark (voc-wiki's ``record_addressed``, merged in 7.37.00) is kept in the thread's own
    workspace: the deployment's and the other workspace's threads of the same ids keep no mark."""
    made = {_name(scope): _thread(table, scope) for scope in SCOPES}
    marked = dc.record_threads_addressed(table, [made[A.ws]], _addressed(2), workspace=A)
    assert [row['addressed']['version'] for row in marked] == [2]
    cleared = dc.record_addressed(table, marked[0], _addressed(3, addressed=False), workspace=A)
    assert (cleared['addressed'], len(cleared['addressed_history'])) == (None, 2)
    for scope in (None, B):
        [row] = dc.list_threads(table, PROJECT, SERIES, workspace=scope)
        assert ('addressed' in row, 'addressed_history' in row) == (False, False)


@pytest.mark.parametrize('owner', [None, B], ids=['deployment', 'other-workspace'])
def test_an_addressed_mark_on_another_scopes_thread_is_refused_and_nothing_changes(table, owner):
    other = _thread(table, owner)
    before = table.scan()['Items']
    with pytest.raises(OutOfScopeError, match='outside the workspace'):
        dc.record_addressed(table, other, _addressed(2), workspace=A)
    with pytest.raises(OutOfScopeError, match='outside the workspace'):
        dc.record_threads_addressed(table, [other], _addressed(2), workspace=A)
    assert table.scan()['Items'] == before


def test_the_deployments_addressed_mark_is_the_request_sent_before(table):
    item = _thread(table, None)
    recording = Recording(table)
    entry = _addressed(2)
    dc.record_addressed(recording, item, entry)
    assert recording.calls == [('update_item', {
        'Key': {'pk': item['pk'], 'sk': item['sk']},
        'UpdateExpression': ('SET addressed_history = list_append(if_not_exists(addressed_history, :empty), :entry), '
                             'addressed = :current, updated_at = :now'),
        'ConditionExpression': ('attribute_exists(sk) AND (attribute_not_exists(addressed_history) '
                                'OR size(addressed_history) < :max)'),
        'ExpressionAttributeValues': {':empty': [], ':entry': [dict(entry)], ':max': dc.MAX_ADDRESSED_HISTORY,
                                      ':now': entry['at'], ':current': dict(entry)},
        'ReturnValues': 'ALL_NEW', 'ReturnValuesOnConditionCheckFailure': 'ALL_OLD'})]


@pytest.mark.parametrize('call', [
    lambda table, other: dc.put_thread(table, other, workspace=A),
    lambda table, other: dc.append_reply(table, other, dc.reply_item({'kind': 'user'}, 'x'), workspace=A),
    lambda table, other: dc.set_status(table, other, dc.STATUS_RESOLVED, 'Bo', workspace=A),
    lambda table, other: dc.delete_thread(table, other, workspace=A),
], ids=['put', 'reply', 'status', 'delete'])
@pytest.mark.parametrize('owner', [None, B], ids=['deployment', 'other-workspace'])
def test_a_thread_of_another_scope_is_refused_and_nothing_changes(table, call, owner):
    other = dc.thread_item(project_id=PROJECT, series_id=SERIES, document=DOCUMENT, author={'kind': 'user'},
                           text='theirs', anchor=None, workspace=owner)
    before = table.scan()['Items']
    with pytest.raises(OutOfScopeError, match=r'outside the workspace|its own series'):
        call(table, other)
    assert table.scan()['Items'] == before


def test_a_thread_whose_partition_is_not_its_series_is_refused_before_its_series_is_listed(table):
    item = {**dc.thread_item(project_id=PROJECT, series_id=SERIES, document=DOCUMENT, author={'kind': 'user'},
                             text='x', anchor=None, workspace=A), 'series_id': 'ser_' + 'b' * 24}
    with pytest.raises(OutOfScopeError, match="its own series' partition"):
        dc.put_thread(table, item, workspace=A)
    assert table.scan()['Items'] == []


class Recording:
    """A table that records each request it is sent, then sends it."""

    def __init__(self, table: Any) -> None:
        self.table, self.calls = table, []

    def __getattr__(self, method: str) -> Any:
        def call(**request: Any) -> Any:
            self.calls.append((method, request))
            return getattr(self.table, method)(**request)
        return call


def test_the_deployments_requests_are_the_ones_sent_before(table):
    """Each request the one sent before; since 7.47.00 (3g-d) a new thread first lists its series in the deployment's
    series registry (read, then put if absent), the requests it adds."""
    recording = Recording(table)
    item = dc.thread_item(project_id=PROJECT, series_id=SERIES, document=DOCUMENT, author={'kind': 'user'},
                          text='x', anchor=None)
    dc.put_thread(recording, item)
    dc.get_thread(recording, PROJECT, SERIES, item['comment_id'])
    dc.list_threads(recording, PROJECT, SERIES)
    dc.delete_thread(recording, item)
    key = {'pk': f'DCOMMENTS#{PROJECT}#{SERIES}', 'sk': f"C#{item['comment_id']}"}
    listed_at = recording.calls[1][1]['Item']['listed_at']
    assert recording.calls == [
        ('get_item', {'Key': {'pk': 'COMMENT_SERIES_IDS', 'sk': f'{PROJECT}#{SERIES}'}, 'ProjectionExpression': 'pk'}),
        ('put_item', {'Item': {'pk': 'COMMENT_SERIES_IDS', 'sk': f'{PROJECT}#{SERIES}', 'project_id': PROJECT,
                               'series_id': SERIES, 'listed_at': listed_at},
                      'ConditionExpression': 'attribute_not_exists(pk)'}),
        ('put_item', {'Item': item, 'ConditionExpression': 'attribute_not_exists(sk)'}),
        ('get_item', {'Key': key, 'ConsistentRead': True}),
        ('query', {'KeyConditionExpression': Key('pk').eq(key['pk']) & Key('sk').begins_with('C#'),
                   'ConsistentRead': True}),
        ('delete_item', {'Key': key}),
    ]


def _persona_reply(_prompt: str, _system: str) -> str:
    return json.dumps({'stance': 'mixed', 'verdict': 'Fridays worry me.',
                       'comments': [{'quote': 'arrive late every Friday', 'comment': 'Fix Fridays first.'}]})


def test_a_persona_review_in_a_workspace_files_into_that_workspace_only(table):
    persona = {'persona_id': 'persona_1', 'name': 'Budget Traveller'}
    result = run_review(table, project_id=PROJECT, series_id=SERIES, document=DOCUMENT, document_type='prd',
                        personas=[persona], invoke=_persona_reply, workspace=A)
    assert result['filed'] == 2
    rows = dc.list_threads(table, PROJECT, SERIES, workspace=A)
    assert sorted(row['text'] for row in rows) == ['Fix Fridays first.', 'Fridays worry me.']
    assert [dc.list_threads(table, PROJECT, SERIES, workspace=scope) for scope in (None, B)] == [[], []]
    # A second run on the same version files nothing twice (it reads the workspace's own threads).
    again = run_review(table, project_id=PROJECT, series_id=SERIES, document=DOCUMENT, document_type='prd',
                       personas=[persona], invoke=_persona_reply, workspace=A)
    assert again['filed'] == 0


def test_the_deployments_threads_never_stop_a_workspaces_review(table):
    """The dedupe reads the workspace's threads: the same persona's comment in the deployment is not seen there."""
    persona = {'persona_id': 'persona_1', 'name': 'Budget Traveller'}
    run_review(table, project_id=PROJECT, series_id=SERIES, document=DOCUMENT, document_type='prd',
               personas=[persona], invoke=_persona_reply)
    result = run_review(table, project_id=PROJECT, series_id=SERIES, document=DOCUMENT, document_type='prd',
                        personas=[persona], invoke=_persona_reply, workspace=A)
    assert result['filed'] == 2
    assert len(dc.list_threads(table, PROJECT, SERIES)) == 2
