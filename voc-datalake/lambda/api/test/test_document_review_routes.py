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
