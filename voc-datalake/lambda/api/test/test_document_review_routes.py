"""Document comments, review links and the reviewer routes, end to end through projects_handler.

``shared/document_review_routes.py`` is included by ``projects_handler``, so these drive the
real handler (its project-access middleware included) against a moto projects table. Project
callers are app-pool claims; reviewers are board-pool claims (``shared.engagement_identity``).
docs/document-review.md is the contract.
"""
import json
from collections.abc import Iterator
from contextlib import ExitStack
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

from shared import document_share
from shared.converse import ConverseResult
from shared.test.moto_tables import create_pk_sk_table

BOARD_POOL = 'us-east-1_boardpool'
APP_POOL = 'us-east-1_testpool'
OWNER = {'sub': 'owner-sub', 'email': 'owner@corp.example', 'name': 'Olive Owner'}
EDITOR = {'sub': 'editor-sub', 'email': 'ed@corp.example', 'name': 'Ed Editor'}
VIEWER = {'sub': 'viewer-sub', 'email': 'vi@corp.example', 'name': 'Vi Viewer'}
STRANGER = {'sub': 'stranger-sub', 'email': 'st@corp.example'}
V1 = {'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d1', 'document_id': 'd1', 'document_type': 'prfaq', 'version': 1,
      'title': 'Launch (v1)', 'base_title': 'Launch', 'content': 'First draft of the launch.',
      'created_at': '2026-10-01T00:00:00+00:00'}
V2 = {**V1, 'sk': 'PRFAQ#d2', 'document_id': 'd2', 'version': 2, 'title': 'Launch (v2)',
      'content': 'Second draft of the launch.', 'created_at': '2026-10-02T00:00:00+00:00'}
COMMENTS = '/projects/p1/documents/d1/comments'
SHARE = '/projects/p1/documents/d1/share'


def _reviewer(email='rev@partner.example', *, pool=BOARD_POOL, verified='true'):
    return {'sub': f'board-{email}', 'email': email, 'email_verified': verified, 'name': 'Rev Iewer',
            'iss': f'https://cognito-idp.us-east-1.amazonaws.com/{pool}'}


@pytest.fixture
def table(monkeypatch) -> Iterator:
    monkeypatch.setenv('BOARD_USER_POOL_ID', BOARD_POOL)
    monkeypatch.setenv('APP_USER_POOL_ID', APP_POOL)
    with mock_aws():
        projects = create_pk_sk_table('projects')
        projects.put_item(Item={
            'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'P', 'owner_sub': 'owner-sub',
            'visibility': 'private',
            'members': {'editor-sub': {'role': 'editor'}, 'viewer-sub': {'role': 'viewer'}}})
        projects.put_item(Item=V1)
        projects.put_item(Item=V2)
        projects.put_item(Item={**V1, 'sk': 'DOC#c1', 'document_id': 'c1', 'document_type': 'custom'})
        with ExitStack() as stack:
            stack.enter_context(patch('projects_handler.get_projects_table', return_value=projects))
            stack.enter_context(patch('shared.document_review_routes.get_projects_table', return_value=projects))
            yield projects


@pytest.fixture
def call(request, api_gateway_event, lambda_context):
    """Run one request through projects_handler, against the ``table`` world."""
    request.getfixturevalue('table')
    from projects_handler import lambda_handler

    def _call(method, path, claims, body=None):
        return call_route(lambda_handler, api_gateway_event, lambda_context, method=method, path=path,
                          body=body, claims=claims)
    return _call


def _comment(call, claims=OWNER, text='A note', anchor=None, path=COMMENTS):
    response, body = call('POST', path, claims, {'text': text, **({'anchor': anchor} if anchor else {})})
    assert response['statusCode'] == 200, body
    return body['thread']


def _review_path(share, *rest):
    """``/review/{share_id}[/rest…]`` for a link the team created."""
    return '/'.join([f'/review/{share["share_id"]}', *rest])


def _share(call, claims=OWNER, **values):
    response, body = call('POST', SHARE, claims, values or {'expires_in_days': 30})
    assert response['statusCode'] == 200, body
    return body['share']


# ── project members: comments ───────────────────────────────────────────────

def test_a_viewer_may_comment_and_every_version_lists_the_series_threads(call):
    thread = _comment(call, VIEWER, anchor={'exact': 'launch', 'prefix': 'the '})
    assert thread['author'] == {'kind': 'user', 'name': 'Vi Viewer', 'sub': 'viewer-sub'}
    assert (thread['document_id'], thread['version']) == ('d1', 1)
    response, body = call('GET', '/projects/p1/documents/d2/comments', VIEWER)
    assert response['statusCode'] == 200
    assert [t['comment_id'] for t in body['threads']] == [thread['comment_id']]
    assert body['can_edit'] is False
    assert body['share'] is None


def test_an_editor_lists_with_can_edit(call):
    assert call('GET', COMMENTS, EDITOR)[1]['can_edit'] is True


def test_a_non_member_of_a_private_project_gets_404(call):
    assert call('GET', COMMENTS, STRANGER)[0]['statusCode'] == 404
    assert call('POST', COMMENTS, STRANGER, {'text': 'x'})[0]['statusCode'] == 404


def test_comments_on_a_custom_document_are_refused(call):
    response, body = call('GET', '/projects/p1/documents/c1/comments', OWNER)
    assert response['statusCode'] == 400
    assert 'PR/FAQ and PRD' in json.dumps(body)


def test_an_unknown_document_is_404(call):
    assert call('GET', '/projects/p1/documents/nope/comments', OWNER)[0]['statusCode'] == 404


def test_a_malformed_comment_is_400(call):
    assert call('POST', COMMENTS, OWNER, {'text': 'x', 'anchor': {'exact': ''}})[0]['statusCode'] == 400


def test_reply_resolve_and_reopen_by_a_viewer(call):
    thread = _comment(call)
    base = f'{COMMENTS}/{thread["comment_id"]}'
    replied = call('POST', f'{base}/replies', VIEWER, {'text': 'Agreed'})[1]['thread']
    assert [r['text'] for r in replied['replies']] == ['Agreed']
    resolved = call('POST', f'{base}/resolve', VIEWER)[1]['thread']
    assert (resolved['status'], resolved['status_by']) == ('resolved', 'Vi Viewer')
    assert call('POST', f'{base}/reopen', VIEWER)[1]['thread']['status'] == 'open'


def test_a_reply_past_fifty_is_409(call, table):
    thread = _comment(call)
    key = {'pk': f'DCOMMENTS#p1#{thread["series_id"]}', 'sk': f'C#{thread["comment_id"]}'}
    table.update_item(Key=key, UpdateExpression='SET replies = :r',
                      ExpressionAttributeValues={':r': [{'reply_id': str(n), 'text': 'r'} for n in range(50)]})
    response, _ = call('POST', f'{COMMENTS}/{thread["comment_id"]}/replies', OWNER, {'text': 'one more'})
    assert response['statusCode'] == 409


def test_an_unknown_comment_is_404(call):
    assert call('POST', f'{COMMENTS}/dc_{"0" * 26}/resolve', OWNER)[0]['statusCode'] == 404


def test_a_viewer_deletes_their_own_thread_but_not_anothers(call):
    own = _comment(call, VIEWER)
    other = _comment(call, OWNER)
    assert call('DELETE', f'{COMMENTS}/{other["comment_id"]}', VIEWER)[0]['statusCode'] == 403
    assert call('DELETE', f'{COMMENTS}/{own["comment_id"]}', VIEWER)[0]['statusCode'] == 200
    remaining = call('GET', COMMENTS, OWNER)[1]['threads']
    assert [t['comment_id'] for t in remaining] == [other['comment_id']]


def test_an_editor_deletes_anyones_thread(call):
    thread = _comment(call, VIEWER)
    assert call('DELETE', f'{COMMENTS}/{thread["comment_id"]}', EDITOR)[1] == {
        'success': True, 'comment_id': thread['comment_id']}
    assert call('GET', COMMENTS, OWNER)[1]['threads'] == []


def test_a_deleted_thread_is_recorded_as_its_deleter(call, table):
    thread = _comment(call, VIEWER)
    call('DELETE', f'{COMMENTS}/{thread["comment_id"]}', EDITOR)
    [row] = table.query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': 'AUDIT#delete'})['Items']
    assert (row['kind'], row['target']['comment_id'], row['actor']) == (
        'document_comment', thread['comment_id'], {'sub': 'editor-sub', 'kind': 'user'})


# ── project members: share links ────────────────────────────────────────────

def test_a_viewer_cannot_create_or_revoke_a_link(call):
    assert call('POST', SHARE, VIEWER, {'expires_in_days': 7})[0]['statusCode'] == 403
    _share(call)
    assert call('DELETE', SHARE, VIEWER)[0]['statusCode'] == 403
    assert call('GET', SHARE, VIEWER)[1]['share']['active'] is True


def test_an_editor_creates_one_link_per_series_from_any_version(call):
    share = _share(call, EDITOR, expires_in_days=7)
    assert share['path'] == _review_path(share)
    assert share['created_by_name'] == 'Ed Editor'
    response, again = call('POST', '/projects/p1/documents/d2/share', OWNER, {'expires_in_days': 90})
    assert response['statusCode'] == 200
    assert (again['created'], again['share']['share_id']) == (False, share['share_id'])
    assert call('GET', COMMENTS, VIEWER)[1]['share']['share_id'] == share['share_id']


@pytest.mark.parametrize('body', [{'expires_in_days': 91}, {'expires_in_days': 0}, {'audience': {'mode': 'list'}},
                                  {'audience': {'mode': 'anyone'}, 'note': 'x'}])
def test_a_malformed_link_request_is_400(call, body):
    assert call('POST', SHARE, OWNER, body)[0]['statusCode'] == 400


def test_revoking_turns_the_link_off_for_its_reviewer(call):
    share = _share(call)
    assert call('DELETE', SHARE, EDITOR)[1] == {'success': True, 'revoked': True}
    assert call('GET', SHARE, OWNER)[1]['share'] is None
    response, body = call('GET', _review_path(share), _reviewer())
    assert response['statusCode'] == 404
    assert document_share.LINK_GONE in json.dumps(body)
    assert call('DELETE', SHARE, EDITOR)[1]['revoked'] is False


# ── reviewers ───────────────────────────────────────────────────────────────

def test_a_reviewer_reads_the_newest_version_and_no_team_threads(call):
    _comment(call, OWNER, text='internal only')
    share = _share(call)
    response, body = call('GET', _review_path(share), _reviewer())
    assert response['statusCode'] == 200
    assert (body['document']['document_id'], body['document']['version']) == ('d2', 2)
    assert body['document']['content'] == 'Second draft of the launch.'
    assert body['threads'] == []
    assert body['viewer'] == {'email': 'rev@partner.example', 'name': 'Rev Iewer'}
    assert 'internal only' not in json.dumps(body)


def test_a_reviewer_comments_on_the_newest_version_and_sees_only_their_own(call):
    share = _share(call)
    path = _review_path(share, 'comments')
    mine = _comment(call, _reviewer(), text='from rev', path=path)
    _comment(call, _reviewer('other@partner.example'), text='from other', path=path)
    assert (mine['document_id'], mine['author']) == ('d2', {'kind': 'reviewer', 'name': 'Rev Iewer'})
    assert mine['from_review_link'] is True
    body = call('GET', _review_path(share), _reviewer())[1]
    assert [t['text'] for t in body['threads']] == ['from rev']
    assert 'other@partner.example' not in json.dumps(body)
    team = call('GET', COMMENTS, OWNER)[1]['threads']
    assert {t['author'].get('email') for t in team} == {'rev@partner.example', 'other@partner.example'}


def test_a_reviewer_replies_only_on_their_own_thread(call):
    share = _share(call)
    base = _review_path(share, 'comments')
    mine = _comment(call, _reviewer(), path=base)
    theirs = _comment(call, _reviewer('other@partner.example'), path=base)
    team = _comment(call, OWNER)
    ok, replied = call('POST', f'{base}/{mine["comment_id"]}/replies', _reviewer(), {'text': 'more'})
    assert ok['statusCode'] == 200
    assert replied['thread']['replies'][0]['text'] == 'more'
    for other in (theirs, team):
        assert call('POST', f'{base}/{other["comment_id"]}/replies', _reviewer(), {'text': 'x'})[0]['statusCode'] == 404


def test_a_reviewer_past_the_daily_budget_gets_429(call, monkeypatch):
    monkeypatch.setattr(document_share, 'MAX_REVIEWER_WRITES_PER_DAY', 2)
    share = _share(call)
    path = _review_path(share, 'comments')
    _comment(call, _reviewer(), path=path)
    _comment(call, _reviewer(), path=path)
    response, body = call('POST', path, _reviewer(), {'text': 'third'})
    assert response['statusCode'] == 429
    assert 'rate_limited' in json.dumps(body)
    assert _comment(call, _reviewer('other@partner.example'), path=path)['text'] == 'A note'


def test_a_list_link_refuses_an_address_outside_it(call):
    share = _share(call, audience={'mode': 'list', 'domains': ['partner.example']})
    assert call('GET', _review_path(share), _reviewer())[0]['statusCode'] == 200
    response, _ = call('GET', _review_path(share), _reviewer('eve@evil.example'))
    assert response['statusCode'] == 404


def test_an_expired_link_is_gone(call, monkeypatch):
    share = _share(call, expires_in_days=1)
    later = document_share._now_epoch() + 86_400
    monkeypatch.setattr(document_share, '_now_epoch', lambda: later)
    assert call('GET', _review_path(share), _reviewer())[0]['statusCode'] == 404
    assert call('POST', _review_path(share, 'comments'), _reviewer(), {'text': 'x'})[0]['statusCode'] == 404


@pytest.mark.parametrize('claims', [
    _reviewer(verified='false'), _reviewer(pool='us-east-1_foreign'), {**_reviewer(), 'email': ''},
])
def test_an_unverified_or_foreign_sign_in_is_403(call, claims):
    share = _share(call)
    assert call('GET', _review_path(share), claims)[0]['statusCode'] == 403


def test_a_link_whose_series_has_no_version_left_is_gone(call, table):
    share = _share(call)
    for key in ({'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d1'}, {'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d2'}):
        table.delete_item(Key=key)
    assert call('GET', _review_path(share), _reviewer())[0]['statusCode'] == 404


# ── persona review start ────────────────────────────────────────────────────

PERSONA_REVIEW = '/projects/p1/documents/d1/persona-review'


def test_starting_a_persona_review_answers_202_with_the_job(call, table):
    table.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#a', 'persona_id': 'a', 'name': 'Ann'})
    with patch('projects_handler.assist_jobs.start', return_value={'success': True, 'job_id': 'job_x'}) as start:
        response, body = call('POST', PERSONA_REVIEW, EDITOR, {'persona_ids': ['a']})
    assert response['statusCode'] == 202
    assert body['job_id'] == 'job_x'
    args, kwargs = start.call_args
    assert args[1] == 'assist_persona_review'
    assert json.loads(args[2]['body_json']) == {'persona_ids': ['a']}
    assert args[2]['document_id'] == 'd1'
    assert kwargs['initiated_by'] == 'editor-sub'


def test_a_viewer_cannot_start_a_persona_review(call):
    assert call('POST', PERSONA_REVIEW, VIEWER, {})[0]['statusCode'] == 403


@pytest.mark.parametrize('body', [{'persona_ids': [f'p{n}' for n in range(7)]}, {'persona_ids': []}])
def test_more_than_six_or_no_persona_ids_is_400(call, body):
    assert call('POST', PERSONA_REVIEW, OWNER, body)[0]['statusCode'] == 400


def test_a_project_without_personas_is_400(call):
    response, body = call('POST', PERSONA_REVIEW, OWNER, {})
    assert response['statusCode'] == 400
    assert 'no personas' in json.dumps(body)


def test_the_persona_review_work_files_verbatim_comments_on_the_document(table):
    import projects_handler

    table.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#a', 'persona_id': 'a', 'name': 'Ann'})
    reply = json.dumps({'stance': 'positive', 'verdict': 'Good.', 'comments': [
        {'quote': 'First draft of the launch.', 'comment': 'Clear'}, {'quote': 'Not in the text at all', 'comment': 'x'}]})
    with patch('shared.document_review.converse', return_value=reply) as converse:
        result = projects_handler._persona_review_work({'project_id': 'p1', 'document_id': 'd1',
                                                        'body_json': json.dumps({'persona_ids': None})})
    assert converse.call_count == 1
    assert converse.call_args.kwargs['surface'] == 'documents'
    assert (result['filed'], result['personas'][0]['dropped']) == (2, 1)
    assert table.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d1'})['Item']['content'] == V1['content']


# ── revise from comments ────────────────────────────────────────────────────

REVISE = '/projects/p1/documents/d2/revise-from-comments'
ADDRESSED = '/projects/p1/documents/d2/comments/addressed'
MCP_EDITOR = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'editor-sub'}


@pytest.fixture
def aggregates(request):
    """The aggregates table the way-of-working rows live in (the moto world of ``table``).

    The suite's autouse default (conftest) answers every caller AI-driven; here the stored row decides.
    """
    request.getfixturevalue('table')
    from shared import ai_mode
    from shared.test.moto_tables import create_pk_sk_table

    rows = create_pk_sk_table('aggregates')

    def stored(tbl, sub):
        return ai_mode.ai_mode_of(tbl.get_item(Key=ai_mode.ai_mode_key(sub), ConsistentRead=True).get('Item'))
    with patch('projects_handler.get_aggregates_table', return_value=rows), \
            patch('shared.ai_mode.get_ai_mode', side_effect=stored):
        yield rows


def _mode(aggregates, sub, mode, **unlocks):
    aggregates.put_item(Item={'pk': f'USERFLAGS#{sub}', 'sk': 'ai_mode', 'mode': mode, **unlocks})


def _answered(call, claims=OWNER):
    thread = _comment(call, claims, text='Say which launch', path='/projects/p1/documents/d2/comments',
                      anchor={'exact': 'Second draft'})
    call('POST', f'/projects/p1/documents/d2/comments/{thread["comment_id"]}/resolve', claims)
    return thread


def _start_revise(call, claims=EDITOR, body=None):
    with patch('projects_handler.assist_jobs.start', return_value={'success': True, 'job_id': 'job_r'}) as start:
        response, answer = call('POST', REVISE, claims, body if body is not None else {})
    return response, answer, start


MCP_OWNER = {'sub': 'mcp:tok_2', 'voc:acting_subject': 'owner-sub'}


@pytest.mark.parametrize(('mode', 'unlocks', 'interactive', 'autonomous'), [
    ('human_driven', {}, 'recommendations', 'recommendations'),
    ('human_driven', {'ai_writing_prfaq': True}, 'proposal', 'recommendations'),
    ('human_driven', {'ai_writing_prd': True}, 'recommendations', 'recommendations'),
    ('ai_assisted', {}, 'proposal', 'recommendations'),
    ('ai_driven', {}, 'applied', 'applied'),
])
def test_the_outcome_is_the_ai_writing_gate_then_the_callers_mode(call, aggregates, mode, unlocks, interactive,
                                                                  autonomous):
    """The full matrix: the person in the app (interactive) and their MCP token (autonomous, as the owner)."""
    _answered(call)
    _mode(aggregates, 'editor-sub', mode, **unlocks)
    _mode(aggregates, 'owner-sub', mode, **unlocks)
    assert _start_revise(call, EDITOR)[2].call_args.args[2]['outcome'] == interactive
    assert _start_revise(call, MCP_OWNER)[2].call_args.args[2]['outcome'] == autonomous


@pytest.mark.parametrize(('claims', 'failing_sub'), [(EDITOR, 'editor-sub'), (MCP_EDITOR, 'editor-sub'),
                                                     (MCP_EDITOR, 'owner-sub')])
@pytest.mark.usefixtures('aggregates')
def test_a_mode_that_cannot_be_read_fails_the_start_not_recommends(call, claims, failing_sub):
    """Like every other AI-writing route: the caller's (or, autonomous, the owner's) read failing is an error."""
    from botocore.exceptions import ClientError

    from shared import ai_mode

    _answered(call)

    def flaky(_table, sub):
        if sub == failing_sub:
            raise ClientError({'Error': {'Code': 'ThrottlingException'}}, 'GetItem')
        return ai_mode.AiMode(mode=ai_mode.MODE_AI_DRIVEN)
    with patch('shared.ai_mode.get_ai_mode', side_effect=flaky):
        response, body, start = _start_revise(call, claims)
    assert response['statusCode'] == 403
    assert 'Could not check your way of working' in json.dumps(body)
    start.assert_not_called()


@pytest.mark.usefixtures('aggregates')
def test_the_callers_mode_is_read_once(call):
    from shared import ai_mode

    _answered(call)
    with patch('shared.ai_mode.get_ai_mode', return_value=ai_mode.AiMode(mode=ai_mode.MODE_AI_DRIVEN)) as read:
        _, _, start = _start_revise(call)
    assert start.call_args.args[2]['outcome'] == 'applied'
    assert [c.args[1] for c in read.call_args_list] == ['editor-sub']


@pytest.mark.parametrize(('mode', 'outcome'), [('ai_assisted', 'proposal'), ('ai_driven', 'applied')])
def test_starting_a_revision_answers_202_with_the_outcome_of_the_way_of_working(call, aggregates, mode, outcome):
    thread = _answered(call)
    _mode(aggregates, 'editor-sub', mode)
    response, body, start = _start_revise(call)
    assert (response['statusCode'], body['job_id']) == (202, 'job_r')
    args, kwargs = start.call_args
    config = args[2]
    assert args[1] == 'assist_revise_from_comments'
    assert (config['document_id'], config['outcome']) == ('d2', outcome)
    # The series the pass read: a save of its proposal is checked against it (PUT revise_job_id).
    assert config['series_id'] == _series_of_launch()
    assert json.loads(config['body_json']) == {'thread_ids': [thread['comment_id']]}
    assert config['actor'] == {'sub': 'editor-sub', 'kind': 'user'}
    assert config['category_scope']['all'] is True
    assert len(config['revise_id']) == 24
    assert kwargs['initiated_by'] == 'editor-sub'


@pytest.mark.parametrize(('editor_mode', 'owner_mode', 'outcome'), [
    ('ai_driven', 'ai_driven', 'applied'),
    ('ai_driven', 'ai_assisted', 'recommendations'),
    ('ai_assisted', 'ai_driven', 'recommendations'),
])
def test_an_mcp_caller_revises_only_when_it_and_the_owner_are_ai_driven(call, aggregates, editor_mode, owner_mode,
                                                                        outcome):
    _answered(call)
    _mode(aggregates, 'editor-sub', editor_mode)
    _mode(aggregates, 'owner-sub', owner_mode)
    response, _, start = _start_revise(call, MCP_EDITOR)
    assert response['statusCode'] == 202
    assert start.call_args.args[2]['outcome'] == outcome
    assert start.call_args.args[2]['actor']['kind'] == 'mcp'


def test_the_owner_revising_through_mcp_is_checked_once(call, aggregates):
    _answered(call)
    _mode(aggregates, 'owner-sub', 'ai_driven')
    _, _, start = _start_revise(call, MCP_OWNER)
    assert start.call_args.args[2]['outcome'] == 'applied'


@pytest.mark.usefixtures('aggregates')
def test_a_viewer_cannot_start_a_revision(call):
    _answered(call)
    assert _start_revise(call, VIEWER)[0]['statusCode'] == 403


@pytest.mark.usefixtures('aggregates')
def test_a_revision_with_nothing_to_revise_from_is_400(call):
    _comment(call, OWNER, path='/projects/p1/documents/d2/comments')
    response, body, start = _start_revise(call)
    assert response['statusCode'] == 400
    assert 'No comments to revise from' in json.dumps(body)
    start.assert_not_called()


@pytest.mark.parametrize('body', [{'thread_ids': []}, {'thread_ids': ['x']}, {'personas': []}])
@pytest.mark.usefixtures('aggregates')
def test_a_malformed_revision_body_is_400(call, body):
    assert _start_revise(call, body=body)[0]['statusCode'] == 400


@pytest.mark.usefixtures('aggregates')
def test_revising_a_custom_document_is_400(call):
    response, _ = call('POST', '/projects/p1/documents/c1/revise-from-comments', OWNER, {})
    assert response['statusCode'] == 400


def _revise_work(config, reply):
    import projects_handler

    answered = ConverseResult(text=json.dumps(reply), model_id=REVISE_MODEL)
    with patch('shared.document_review.converse'), patch('shared.document_revision.converse_detailed',
                                                         return_value=answered) as converse:
        result = projects_handler._revise_work(config)
    return result, converse


#: The model the stubbed pass reports answering on.
REVISE_MODEL = 'global.anthropic.claude-sonnet-5-5'


def _work_config(thread_ids, outcome):
    return {'project_id': 'p1', 'document_id': 'd2', 'body_json': json.dumps({'thread_ids': thread_ids}),
            'outcome': outcome, 'revise_id': 'rid', 'actor': {'sub': 'editor-sub', 'kind': 'user'},
            'category_scope': {'all': True, 'categories': []}}


REVISE_REPLY = {'recommendations': [{'thread': 'T1', 'text': 'Name the launch.'}],
                'changes': [{'threads': ['T1'], 'before': 'Second draft', 'after': 'Final draft', 'reason': 'Asked'},
                            {'threads': ['T1'], 'before': 'not in it', 'after': 'x'}]}


def test_the_revision_work_proposes_grounded_changes_and_writes_nothing(call, table):
    thread = _answered(call)
    with patch('projects_handler.projects.feedback_table', None):
        result, converse = _revise_work(_work_config([thread['comment_id']], 'proposal'), REVISE_REPLY)
    assert converse.call_args.kwargs['surface'] == 'documents'
    assert (result['outcome'], result['base_document_id'], result['base_version'], result['dropped']) == (
        'proposal', 'd2', 2, 1)
    assert [c['after'] for c in result['changes']] == ['Final draft']
    assert table.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d2'})['Item']['content'] == V2['content']


def test_the_applied_revision_is_a_new_version_and_its_threads_show_addressed(call, table):
    thread = _answered(call)
    with patch('projects_handler.projects.feedback_table', None):
        result, _ = _revise_work(_work_config([thread['comment_id']], 'applied'), REVISE_REPLY)
    assert result['applied_version']['version'] == 3
    assert result['addressed_thread_ids'] == [thread['comment_id']]
    [listed] = call('GET', COMMENTS, VIEWER)[1]['threads']
    assert (listed['addressed']['version'], listed['addressed']['by_kind']) == (3, 'ai')
    assert 'by_sub' not in listed['addressed']
    v3 = table.query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': 'PROJECT#p1'})['Items']
    [new] = [row for row in v3 if row.get('document_id') == result['applied_version']['document_id']]
    assert (new['version'], new['edit_kind'], new['content'], new['edited_by']) == (
        3, 'revise', 'Final draft of the launch.', {'sub': 'editor-sub', 'kind': 'user'})
    assert new['llm_metadata'] == {'model': REVISE_MODEL, 'prompt_version': '1.0.0'}
    assert (result['model_id'], result['prompt_version']) == (REVISE_MODEL, '1.0.0')
    with patch('projects.projects_table', table):
        [listed_v3, *_] = call('GET', '/projects/p1/documents/d2/versions', VIEWER)[1]['versions']
    assert listed_v3['llm_metadata'] == {'model': REVISE_MODEL, 'prompt_version': '1.0.0',
                                         'model_label': 'Claude Sonnet 5.5'}
    assert table.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d2'})['Item']['content'] == V2['content']


def test_the_revision_work_reads_the_documents_evidence(call, table):
    thread = _answered(call)
    table.update_item(Key={'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d2'}, UpdateExpression='SET input_feedback_ids = :i',
                      ExpressionAttributeValues={':i': ['fb1']})
    with patch('projects_handler.projects.feedback_table') as feedback:
        feedback.query.return_value = {'Items': [{'feedback_id': 'fb1', 'original_text': 'Launch it soon'}]}
        _, converse = _revise_work(_work_config([thread['comment_id']], 'recommendations'), REVISE_REPLY)
    assert '[fb1]' in converse.call_args.kwargs['prompt']


# ── addressed ───────────────────────────────────────────────────────────────

def _stored_thread(table, comment_id):
    from shared import document_comments, document_series

    series = document_series.series_of('p1', V2)['series_id']
    return document_comments.get_thread(table, 'p1', series, comment_id)


def test_an_editor_marks_threads_addressed_by_the_paths_version(call, table):
    thread = _answered(call)
    other = _comment(call, OWNER)
    response, body = call('POST', ADDRESSED, EDITOR, {'thread_ids': [thread['comment_id'], f'dc_{"0" * 26}']})
    assert response['statusCode'] == 200
    [marked] = body['threads']
    assert marked['comment_id'] == thread['comment_id']
    assert (marked['addressed']['version'], marked['addressed']['by_kind']) == (2, 'user')
    assert 'addressed_history' not in marked
    stored = _stored_thread(table, thread['comment_id'])
    assert stored is not None
    [entry] = stored['addressed_history']
    assert (entry['version'], entry['document_id'], entry['by_sub'], entry['addressed']) == (2, 'd2', 'editor-sub', True)
    listed = {t['comment_id']: t for t in call('GET', COMMENTS, OWNER)[1]['threads']}
    assert listed[other['comment_id']]['addressed'] is None
    replied = call('POST', f'{COMMENTS}/{thread["comment_id"]}/replies', OWNER, {'text': 'later'})[1]['thread']
    assert replied['addressed']['version'] == 2


def test_the_version_is_the_paths_document_and_a_body_version_is_refused(call):
    thread = _answered(call)
    response, body = call('POST', '/projects/p1/documents/d1/comments/addressed', OWNER,
                          {'thread_ids': [thread['comment_id']]})
    assert (response['statusCode'], body['threads'][0]['addressed']['version']) == (200, 1)
    assert call('POST', ADDRESSED, OWNER, {'thread_ids': [thread['comment_id']], 'version': 7})[0]['statusCode'] == 400


def test_clearing_appends_to_the_history_and_answers_null(call, table):
    """The canvas's Undo of an applied pass: the restored version clears the mark (D1: nothing rewritten)."""
    thread = _answered(call)
    call('POST', ADDRESSED, OWNER, {'thread_ids': [thread['comment_id']]})
    response, body = call('POST', '/projects/p1/documents/d1/comments/addressed', OWNER,
                          {'thread_ids': [thread['comment_id']], 'addressed': False})
    assert (response['statusCode'], body['threads'][0]['addressed']) == (200, None)
    stored = _stored_thread(table, thread['comment_id'])
    assert stored is not None
    history = stored['addressed_history']
    assert [(e['document_id'], e['addressed']) for e in history] == [('d2', True), ('d1', False)]
    [listed] = call('GET', COMMENTS, OWNER)[1]['threads']
    assert listed['addressed'] is None


def test_a_document_without_a_version_is_400(call, table):
    table.put_item(Item={**V1, 'sk': 'PRFAQ#d0', 'document_id': 'd0', 'version': None})
    thread = _answered(call)
    response, body = call('POST', '/projects/p1/documents/d0/comments/addressed', OWNER,
                          {'thread_ids': [thread['comment_id']]})
    assert response['statusCode'] == 400
    assert 'no saved version' in json.dumps(body)


def test_an_mcp_caller_marks_threads_addressed_by_the_ai(call):
    thread = _answered(call)
    body = call('POST', ADDRESSED, MCP_EDITOR, {'thread_ids': [thread['comment_id']]})[1]
    assert body['threads'][0]['addressed']['by_kind'] == 'ai'


def test_a_viewer_cannot_mark_threads_addressed(call):
    thread = _answered(call)
    assert call('POST', ADDRESSED, VIEWER, {'thread_ids': [thread['comment_id']]})[0]['statusCode'] == 403


@pytest.mark.parametrize('body', [{}, {'addressed': True}, {'thread_ids': []},
                                  {'thread_ids': [f'dc_{"0" * 26}'], 'addressed': 'yes'}])
def test_a_malformed_addressed_body_is_400(call, body):
    assert call('POST', ADDRESSED, OWNER, body)[0]['statusCode'] == 400


def test_marking_unknown_threads_addressed_is_404(call):
    assert call('POST', ADDRESSED, OWNER, {'thread_ids': [f'dc_{"0" * 26}']})[0]['statusCode'] == 404


def test_marking_past_the_history_cap_is_409_and_writes_nothing(call, table, monkeypatch):
    from shared import document_comments

    monkeypatch.setattr(document_comments, 'MAX_ADDRESSED_HISTORY', 2)
    thread = _answered(call)
    for _ in range(2):
        call('POST', ADDRESSED, OWNER, {'thread_ids': [thread['comment_id']]})
    response, body = call('POST', ADDRESSED, OWNER, {'thread_ids': [thread['comment_id']], 'addressed': False})
    assert response['statusCode'] == 409
    assert body == {'success': False, 'error': document_comments.ADDRESSED_FULL}
    stored = _stored_thread(table, thread['comment_id'])
    assert stored is not None
    assert len(stored['addressed_history']) == 2
    assert stored['addressed']['version'] == 2


def test_marking_past_the_cap_still_marks_the_other_threads_then_is_409(call, table, monkeypatch):
    from shared import document_comments

    monkeypatch.setattr(document_comments, 'MAX_ADDRESSED_HISTORY', 1)
    full, other = _answered(call), _answered(call)
    call('POST', ADDRESSED, OWNER, {'thread_ids': [full['comment_id']]})
    response, body = call('POST', ADDRESSED, OWNER, {'thread_ids': [full['comment_id'], other['comment_id']]})
    assert response['statusCode'] == 409
    assert document_comments.ADDRESSED_SOME_FULL in json.dumps(body)
    # Machine-readable: the client reads the code, never the sentence.
    assert body['code'] == 'addressed_some_full'
    assert 'marked_thread_ids' not in body
    marked, kept = _stored_thread(table, other['comment_id']), _stored_thread(table, full['comment_id'])
    assert marked is not None
    assert kept is not None
    assert marked['addressed']['version'] == 2
    assert len(kept['addressed_history']) == 1


# ── saving a proposal (PUT revise_job_id, D4: checked by the server) ────────

DOCUMENT_PUT = '/projects/p1/documents/d2'


@pytest.fixture
def documents(table):
    """The document routes (api/projects.py) write through their own table handle."""
    with patch('projects.projects_table', table):
        yield table


def _saved_version(table, document_id):
    rows = table.query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': 'PROJECT#p1'})['Items']
    [row] = [r for r in rows if r.get('document_id') == document_id]
    return row


def _series_of_launch():
    from shared.document_series import series_of

    return series_of('p1', V2)['series_id']


def _revise_job(**overrides):
    """A finished proposal pass the editor started on v2 (the jobs table's row, config included)."""
    row = {'pk': 'PROJECT#p1', 'sk': 'JOB#job_r1', 'job_id': 'job_r1', 'job_type': 'assist_revise_from_comments',
           'status': 'completed', 'project_id': 'p1', 'initiated_by': 'editor-sub',
           'config': {'document_id': 'd2', 'series_id': _series_of_launch()},
           'result': {'outcome': 'proposal', 'base_document_id': 'd2', 'base_version': 2, 'dropped': 0,
                      'changes': [{'change_id': 'c1', 'thread_ids': ['t1'], 'before': 'Second draft',
                                   'after': 'Final draft', 'reason': 'Asked'}]}}
    return {**row, **overrides}


@pytest.fixture
def jobs(request):
    """The jobs table the PUT reads the pass from (the moto world of ``table``, with ``documents``)."""
    from shared.test.moto_tables import create_pk_sk_table

    request.getfixturevalue('documents')
    rows = create_pk_sk_table('jobs')
    with patch('projects_handler.get_jobs_table', return_value=rows):
        yield rows


def _prfaq_rows(table):
    return [r for r in table.scan()['Items'] if r['sk'].startswith('PRFAQ#')]


def _save_proposal(call, content='Final draft of the launch.', claims=EDITOR, job_id='job_r1', **extra):
    return call('PUT', DOCUMENT_PUT, claims, {'content': content, 'edit_id': 'e1', 'expected_revision': 2,
                                              'revise_job_id': job_id, **extra})


def test_a_saved_proposal_is_recorded_as_a_revise_by_the_person_with_its_pass(call, documents, jobs):
    jobs.put_item(Item=_revise_job())
    response, body = _save_proposal(call)
    assert response['statusCode'] == 200, body
    row = _saved_version(documents, body['document']['document_id'])
    assert (row['version'], row['edit_kind'], row['edited_by'], row['revise_job_id']) == (
        3, 'revise', {'sub': 'editor-sub', 'kind': 'user'}, 'job_r1')
    assert 'llm_metadata' not in row


def test_a_saved_proposal_records_the_passs_model_and_prompt_and_history_lists_them(call, documents, jobs):
    recorded = {**_revise_job()['result'], 'model_id': 'global.anthropic.claude-haiku-5-5', 'prompt_version': '1.0.0'}
    jobs.put_item(Item=_revise_job(result=recorded))
    response, body = _save_proposal(call)
    assert response['statusCode'] == 200, body
    saved = _saved_version(documents, body['document']['document_id'])
    llm = {'model': 'global.anthropic.claude-haiku-5-5', 'prompt_version': '1.0.0'}
    assert (saved['llm_metadata'], saved['revise_job_id']) == (llm, 'job_r1')
    later_response, later = call('PUT', DOCUMENT_PUT, EDITOR, {'content': 'Mine.', 'edit_id': 'e2'})
    assert later_response['statusCode'] == 200, later
    assert 'llm_metadata' not in _saved_version(documents, later['document']['document_id'])
    listed = call('GET', DOCUMENT_PUT + '/versions', VIEWER)[1]['versions']
    assert [v['llm_metadata'] for v in listed[:2]] == [None, {**llm, 'model_label': 'Claude Haiku 5.5'}]


def test_a_later_plain_save_does_not_inherit_the_revise_provenance(call, documents, jobs):
    jobs.put_item(Item=_revise_job())
    _save_proposal(call)
    response, body = call('PUT', DOCUMENT_PUT, EDITOR, {'content': 'Mine.', 'edit_id': 'e2'})
    assert response['statusCode'] == 200, body
    row = _saved_version(documents, body['document']['document_id'])
    assert (row['version'], row['edit_kind']) == (4, 'edit')
    assert 'edited_by' not in row
    assert 'revise_job_id' not in row


def test_a_change_written_with_other_markup_still_counts(call, documents, jobs):
    """The canvas may serialise the accepted text differently: plain text is compared too."""
    jobs.put_item(Item=_revise_job(result={**_revise_job()['result'], 'changes': [
        {'change_id': 'c1', 'thread_ids': ['t1'], 'before': 'Second draft', 'after': '**Final**   draft'}]}))
    response, body = _save_proposal(call, content='Final draft of the launch.')
    assert response['statusCode'] == 200, body
    assert _saved_version(documents, body['document']['document_id'])['edit_kind'] == 'revise'


@pytest.mark.parametrize(('job', 'message'), [
    (None, 'That revision was not found in this project'),
    (_revise_job(job_type='assist_persona_review'), 'That revision was not found in this project'),
    (_revise_job(pk='PROJECT#p2', project_id='p2'), 'That revision was not found in this project'),
    (_revise_job(project_id='p2'), 'That revision was not found in this project'),
    (_revise_job(status='running'), 'That revision has no proposal to save'),
    (_revise_job(status='failed'), 'That revision has no proposal to save'),
    (_revise_job(result=None), 'That revision has no proposal to save'),
    (_revise_job(result={**_revise_job()['result'], 'outcome': 'recommendations'}), 'no proposal to save'),
    (_revise_job(result={**_revise_job()['result'], 'outcome': 'applied'}), 'no proposal to save'),
    (_revise_job(initiated_by='owner-sub'), 'That revision was started by someone else'),
    (_revise_job(initiated_by=None), 'That revision was started by someone else'),
    (_revise_job(config={'document_id': 'x', 'series_id': 'ser_another'}), 'That revision is of another document'),
    # The series is the job's from the start (6.07.00): a job without it matches no document.
    (_revise_job(config={}), 'That revision is of another document'),
    (_revise_job(result={**_revise_job()['result'], 'changes': []}), 'This save does not hold a change'),
    # A deletion of a passage the edited version never had.
    (_revise_job(result={**_revise_job()['result'], 'changes': [{'before': 'Third draft', 'after': '  '}]}),
     'This save does not hold a change'),
])
def test_a_save_naming_a_pass_that_does_not_check_out_is_400_and_writes_nothing(call, documents, jobs, job,
                                                                                message):
    if job is not None:
        jobs.put_item(Item=job)
    response, body = _save_proposal(call)
    assert response['statusCode'] == 400
    assert message in json.dumps(body)
    # The refused revise's code: the canvas offers "Save as my own edit" on it, not on the message.
    assert body['code'] == 'revise_refused'
    assert len(_prfaq_rows(documents)) == 2


@pytest.mark.parametrize(('before', 'after'), [
    # A deletion: an empty ``after`` (kept by the grounding).
    (' of the launch', ''),
    # A trim: an ``after`` that is a piece of its ``before`` occurs no more often than in v2.
    ('Second draft of the launch', 'Second draft'),
])
def test_a_deletion_or_trim_proposal_is_recorded_as_a_revise(call, documents, jobs, before, after):
    """The change is held when its ``before`` is gone and its ``after`` (if any) stays."""
    jobs.put_item(Item=_revise_job(result={**_revise_job()['result'], 'changes': [
        {'change_id': 'c1', 'thread_ids': ['t1'], 'before': before, 'after': after, 'reason': 'Asked'}]}))
    response, body = _save_proposal(call, content='Second draft.')
    assert response['statusCode'] == 200, body
    row = _saved_version(documents, body['document']['document_id'])
    assert (row['version'], row['edit_kind'], row['revise_job_id']) == (3, 'revise', 'job_r1')


def test_a_save_naming_an_expired_pass_is_400_though_the_row_is_still_there(call, documents, jobs):
    """DynamoDB deletes past the ttl lazily: a job read after it is gone all the same."""
    jobs.put_item(Item=_revise_job(ttl=1))
    response, body = _save_proposal(call)
    assert response['statusCode'] == 400
    assert 'That revision was not found in this project' in json.dumps(body)
    assert len(_prfaq_rows(documents)) == 2


@pytest.mark.parametrize('job', [None, _revise_job()])
def test_an_unchanged_save_naming_a_pass_is_the_no_op_not_a_400(call, documents, jobs, job):
    """Nothing to save is checked first: the pass is never checked, whether it checks out or not."""
    if job is not None:
        jobs.put_item(Item=job)
    response, body = _save_proposal(call, content=V2['content'])
    assert response['statusCode'] == 200, body
    assert (body['unchanged'], body['document']['document_id']) == (True, 'd2')
    assert len(_prfaq_rows(documents)) == 2


def test_an_after_already_in_the_document_with_nothing_else_changed_is_400(call, documents, jobs):
    """The text was there before the pass: the save holds nothing new from it."""
    jobs.put_item(Item=_revise_job(result={**_revise_job()['result'], 'changes': [
        {'change_id': 'c1', 'thread_ids': ['t1'], 'before': 'Second draft', 'after': 'the launch'}]}))
    response, body = _save_proposal(call, content='Second draft of the launch, and a line of mine.')
    assert response['statusCode'] == 400
    assert 'This save does not hold a change from that revision' in json.dumps(body)
    assert len(_prfaq_rows(documents)) == 2


def test_a_hand_rewrite_of_the_before_is_not_a_trim_and_is_400(call, documents, jobs):
    """The before is gone and the after stays, but the after is no piece of the before: not this change."""
    jobs.put_item(Item=_revise_job(result={**_revise_job()['result'], 'changes': [
        {'change_id': 'c1', 'thread_ids': ['t1'], 'before': 'Second draft', 'after': 'the launch'}]}))
    response, body = _save_proposal(call, content='My own words of the launch.')
    assert response['statusCode'] == 400
    assert 'This save does not hold a change from that revision' in json.dumps(body)
    assert len(_prfaq_rows(documents)) == 2


def test_a_save_without_any_of_the_changes_is_400_and_writes_nothing(call, documents, jobs):
    jobs.put_item(Item=_revise_job())
    response, body = _save_proposal(call, content='My own words about the launch.')
    assert response['statusCode'] == 400
    assert 'This save does not hold a change from that revision' in json.dumps(body)
    assert len(_prfaq_rows(documents)) == 2


def test_another_version_of_the_same_series_may_be_saved_with_the_pass(call, documents, jobs):
    """The pass read v2; the person saves over v1's page of the same series (the server picks the series' next)."""
    jobs.put_item(Item=_revise_job())
    response, body = call('PUT', '/projects/p1/documents/d1', EDITOR,
                          {'content': 'Final draft of the launch.', 'revise_job_id': 'job_r1'})
    assert response['statusCode'] == 200, body
    assert _saved_version(documents, body['document']['document_id'])['edit_kind'] == 'revise'


def test_someone_else_saving_the_editors_pass_is_400(call, jobs):
    jobs.put_item(Item=_revise_job())
    response, body = _save_proposal(call, claims=OWNER)
    assert response['statusCode'] == 400
    assert 'started by someone else' in json.dumps(body)


def test_a_plain_save_stays_an_edit_with_no_edited_by(call, documents):
    response, saved = call('PUT', DOCUMENT_PUT, EDITOR, {'content': 'Mine.', 'edit_id': 'e2'})
    assert response['statusCode'] == 200, saved
    row = _saved_version(documents, saved['document']['document_id'])
    assert row['edit_kind'] == 'edit'
    assert 'edited_by' not in row


@pytest.mark.parametrize('kind', ['revise', 'restore', 'edit', 1, ['revise']])
def test_an_edit_kind_in_the_body_is_ignored_like_any_other_unknown_key(call, documents, kind):
    """The server records what a save is (a revise only from a pass it checked): a client's word is never read."""
    response, saved = call('PUT', DOCUMENT_PUT, EDITOR, {'content': 'Final draft of the launch.', 'edit_id': 'e3',
                                                         'edit_kind': kind})
    assert response['statusCode'] == 200, saved
    row = _saved_version(documents, saved['document']['document_id'])
    assert (row['version'], row['edit_kind']) == (3, 'edit')
    assert 'edited_by' not in row
    assert 'revise_job_id' not in row


@pytest.mark.usefixtures('documents')
@pytest.mark.parametrize('job_id', [1, '', 'not an id!', ['job_r1'], 'x' * 65])
def test_a_malformed_revise_job_id_is_400(call, job_id):
    response, body = call('PUT', DOCUMENT_PUT, EDITOR, {'content': 'Mine.', 'revise_job_id': job_id})
    assert response['statusCode'] == 400
    assert 'revise_job_id must be' in json.dumps(body)
    assert 'code' not in body


def test_a_revise_save_of_a_custom_document_is_400(call, jobs):
    jobs.put_item(Item=_revise_job(initiated_by='owner-sub'))
    response, body = call('PUT', '/projects/p1/documents/c1', OWNER, {'content': 'Final draft', 'revise_job_id': 'job_r1'})
    assert response['statusCode'] == 400
    assert 'PR/FAQ and PRD' in json.dumps(body)
