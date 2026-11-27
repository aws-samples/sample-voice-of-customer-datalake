"""End to end: the global MCP endpoint driven exactly as an external MCP client drives it.

The global MCP server needs an end-to-end test. Each case below opens a real MCP
session against ``mcp_global_handler.lambda_handler`` — ``initialize`` →
``notifications/initialized`` → ``tools/list`` → ``tools/call`` — over the REST
proxy event API Gateway delivers, with tokens minted through the REAL token API
(``mcp_tokens_handler``) and every tool delegated to the REAL domain handlers
(projects, agents, metrics) against moto tables. The user directory (Cognito) is an
in-memory fake at the boto3 surface, and Step Functions is a mock; nothing else
between the JSON-RPC frame and the DynamoDB row is stubbed.

The cases the spec names:
  (a) a read-only token reads, and is refused a write;
  (b) a write token creates (and updates) a document;
  (c) a revoked or an expired token is refused — at the handshake too;
  (d) a project-scoped token is refused outside its project;
  (e) a non-admin token is refused ``agents_run`` (and an admin's works, until demoted);
  (f) a project-scoped token reads a form's response, and an email to the inbox, without the contact fields the
      pin removes, and an address typed into an open answer as the source's PII policy stored it (7.104.00).

Live testing with Cowork / Copilot / Amazon Quick / Kiro needs a deployment
(docs/mcp.md); this is the strongest check possible without one.
"""
from __future__ import annotations

from collections.abc import Generator, Iterable
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from global_mcp_world import (
    ALPHA,
    ALPHA_DOC,
    BETA,
    FORM_CONTACT_ANSWER,
    FORM_FEEDBACK_ID,
    FORM_METADATA,
    FORM_TEXT,
    FORM_TYPED_EMAIL,
    GAMMA,
    INBOX_FEEDBACK_ID,
    INBOX_SENDER,
    McpReply,
    global_mcp_world,
    inbox_item,
    tool_payload,
)

from shared import mcp_global_tokens as gt

READ_TOOLS = {'feedback_search', 'feedback_get', 'feedback_get_metrics', 'feedback_list_categories',
              'feedback_list_dimensions', 'feedback_get_catalogue', 'memory_search', 'company_get_context',
              'projects_list', 'projects_get', 'projects_get_job', 'documents_get',
              'documents_list_prototype_feedback', 'agents_list', 'agents_get_run',
              'feature_requests_search', 'radar_read', 'prioritization_get', 'documents_get_prototype_draft',
              'documents_get_prototype_outline', 'documents_get_prototype_walkthrough', 'library_search',
              'forms_get_results', 'forms_list', 'forms_get', 'forms_get_responses', 'forms_get_report', 'product_get'}
WRITE_TOOLS = {'documents_create', 'documents_update', 'documents_revise_from_comments',
               'documents_mark_comments_addressed', 'projects_generate', 'feedback_edit', 'prioritization_score',
               'feature_requests_write', 'documents_draft_prototype_revision', 'documents_apply_prototype_draft',
               'documents_discard_prototype_draft', 'documents_set_prototype_walkthrough',
               'documents_draft_prototype_walkthrough', 'product_write'}


def _values_in(reply: McpReply, values: Iterable[str]) -> set[str]:
    """Which of ``values`` a tool result's text holds, anywhere in it (``structuredContent`` is the same payload). The
    text is decoded out of the JSON-RPC body first (7.104.00 review, Q1): a split of the body on quotes found a value
    only as a whole string of ``structuredContent``, never inside a longer one or in the escaped text."""
    assert reply.body is not None
    text = reply.body['result']['content'][0]['text']
    return {value for value in values if value in text}


@pytest.fixture
def world(lambda_context):
    with global_mcp_world(lambda_context) as built:
        yield built


def _connected(world, minted):
    client = world.client(minted)
    reply = client.connect()
    assert reply.status == 200, reply.body
    assert reply.body['result']['serverInfo']['name'] == 'voc-datalake-global'
    assert reply.body['result']['protocolVersion'] == '2025-06-18'
    return client


class TestReadOnlyToken:
    def test_sees_only_read_tools_and_reads_what_its_minter_can(self, world):
        client = _connected(world, world.mint('alice', scope='read'))

        assert set(client.tool_names()) == READ_TOOLS

        is_error, listed = tool_payload(client.call('projects_list'))
        # Alice owns alpha and can see the public gamma; bob's private beta is invisible.
        assert not is_error
        assert sorted(p['project_id'] for p in listed['projects']) == [ALPHA, GAMMA]

        is_error, document = tool_payload(client.call('documents_get', {'project_id': ALPHA, 'document_id': ALPHA_DOC}))
        assert not is_error
        assert document['document']['content'] == 'Customers want faster refunds.'
        assert 'pk' not in document['document']
        assert 'sk' not in document['document']

    def test_a_project_the_minter_cannot_see_is_not_found(self, world):
        client = _connected(world, world.mint('alice', scope='read'))

        is_error, message = tool_payload(client.call('projects_get', {'project_id': BETA}))

        assert is_error
        assert 'HTTP 404' in message

    def test_a_write_is_refused_before_any_domain_call(self, world):
        minted = world.mint('alice', scope='read')
        client = _connected(world, minted)
        calls_before = len(world.lambdas.calls)

        is_error, message = tool_payload(client.call('documents_create', {
            'project_id': ALPHA, 'title': 'Nope', 'content': 'x'}))

        assert is_error
        assert 'read-only' in message
        assert len(world.lambdas.calls) == calls_before
        latest = world.audit('alice', minted['token_id'])[0]
        assert {k: latest[k] for k in ('tool', 'project_id', 'outcome')} == {
            'tool': 'documents_create', 'project_id': ALPHA, 'outcome': gt.OUTCOME_DENIED}

    def test_the_delegated_call_acts_as_the_minter_never_as_admin(self, world):
        client = _connected(world, world.mint('root', scope='read'))
        client.call('projects_list')

        _, event = world.lambdas.calls[-1]
        claims = event['requestContext']['authorizer']['claims']
        assert claims['sub'].startswith('mcp:tok_')
        assert claims['voc:acting_subject'] == world.subs['root']
        assert claims['cognito:groups'] == ''
        assert 'voc:mcp_op' not in claims
        assert 'Authorization' not in event['headers']


class TestWriteToken:
    def test_creates_then_updates_a_document_in_a_project_the_minter_owns(self, world):
        minted = world.mint('alice', scope='write')
        client = _connected(world, minted)
        assert set(client.tool_names()) >= WRITE_TOOLS
        assert 'agents_run' not in client.tool_names()

        is_error, created = tool_payload(client.call('documents_create', {
            'project_id': ALPHA, 'title': 'Refund plan', 'content': '# Plan\nRefund in 3 days.'}))
        assert not is_error, created
        document_id = created['document']['document_id']

        stored = world.projects.get_item(Key={'pk': f'PROJECT#{ALPHA}', 'sk': f'DOC#{document_id}'})['Item']
        assert stored['title'] == 'Refund plan'
        assert stored['document_type'] == 'custom'

        is_error, _ = tool_payload(client.call('documents_update', {
            'project_id': ALPHA, 'document_id': document_id, 'content': 'Refund in 2 days.'}))
        assert not is_error
        stored = world.projects.get_item(Key={'pk': f'PROJECT#{ALPHA}', 'sk': f'DOC#{document_id}'})['Item']
        assert stored['content'] == 'Refund in 2 days.'

        events = world.audit('alice', minted['token_id'])
        assert [(e['tool'], e['outcome'], e['project_id']) for e in events[:2]] == [
            ('documents_update', 'ok', ALPHA), ('documents_create', 'ok', ALPHA)]
        # Never the arguments or the content.
        assert all(set(e) == {'tool', 'at', 'project_id', 'outcome'} for e in events)

    def test_cannot_write_where_the_minter_may_not(self, world):
        client = _connected(world, world.mint('alice', scope='write'))

        is_error, message = tool_payload(client.call('documents_create', {
            'project_id': BETA, 'title': 'Sneaky', 'content': 'x'}))

        assert is_error
        assert 'HTTP 404' in message
        assert world.projects.query(
            KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': f'PROJECT#{BETA}'},
        )['Count'] == 1


class TestDeadTokens:
    def test_a_revoked_token_is_refused_immediately(self, world):
        minted = world.mint('alice', scope='write')
        client = _connected(world, minted)
        status, revoked = world.tokens_api('alice', 'DELETE', f"/connect/tokens/{minted['token_id']}")
        assert status == 200
        assert revoked['token']['status'] == gt.STATUS_REVOKED

        assert client.request('tools/list').status == 401
        assert client.call('projects_list').status == 401
        # A fresh session cannot even complete the handshake.
        assert world.client(minted).connect().status == 401

    def test_an_expired_token_is_refused(self, world):
        minted = world.mint('alice', scope='read', expires_in_days=1)
        world.expire(minted)

        reply = world.client(minted).request('tools/list')

        assert reply.status == 401
        assert reply.body['error']['code'] == -32001
        assert reply.headers['WWW-Authenticate'].startswith('Bearer')

    def test_a_disabled_minter_takes_their_tokens_with_them(self, world):
        minted = world.mint('alice', scope='read')
        world.cognito.disable('alice')

        assert world.client(minted).request('tools/list').status == 401

    def test_a_tampered_secret_is_refused(self, world):
        minted = world.mint('alice', scope='read')
        forged = minted['token'][:-4] + ('0000' if not minted['token'].endswith('0000') else '1111')

        assert world.client(forged).request('tools/list').status == 401


class TestProjectScopedToken:
    def test_is_neither_offered_nor_let_call_the_forms_tools(self, world):
        # (S1, 7.104.00 review) The forms are the scope's, never one project's, and a form's responses carry its
        # respondents' contact answers: a pinned token, even a read-only one, gets none of the five forms tools.
        minted = world.mint('alice', scope='read', project_id=ALPHA)
        client = _connected(world, minted)
        forms = sorted(name for name in READ_TOOLS if name.startswith('forms_'))
        assert len(forms) == 5
        assert set(client.tool_names()) == READ_TOOLS - set(forms)
        calls_before = len(world.lambdas.calls)
        for name in forms:
            is_error, message = tool_payload(client.call(name, {} if name == 'forms_list' else {'form_id': 'ff_1'}))
            assert is_error
            assert message == f'{name} reaches beyond one project; this token is scoped to one project'
        assert len(world.lambdas.calls) == calls_before
        assert [event['outcome'] for event in world.audit('alice', minted['token_id'])[:5]] == [gt.OUTCOME_DENIED] * 5

    def test_reads_a_form_response_without_its_respondents_contact_fields(self, world):
        # (S1, 7.104.00 review) What the Connect page promises: a pinned token, which gets no forms tool, does not
        # read a respondent's contact fields through the feedback reads either. feedback_get and feedback_search (the
        # newest, and a query) leave out metadata's submitter_email, submitter_name and email and every contact_info
        # answer: no value of the contact answer is anywhere in the three answers. The response's other answers, its
        # path and the item itself stay; the item has no author, and is as an unpinned token reads it but for metadata.
        client = _connected(world, world.mint('alice', scope='read', project_id=ALPHA))
        kept = {key: value for key, value in FORM_METADATA.items()
                if key not in ('submitter_email', 'submitter_name', 'email')}
        kept['form_answers'] = {qid: answer for qid, answer in FORM_METADATA['form_answers'].items()
                                if qid != 'q_contact'}

        replies = [client.call('feedback_get', {'feedback_id': FORM_FEEDBACK_ID}),
                   *(client.call('feedback_search', arguments)
                     for arguments in ({'days': 1}, {'days': 1, 'query': 'refunds'}))]
        is_error, item = tool_payload(replies[0])
        assert not is_error
        assert (item['feedback_id'], item['original_text'], item['metadata']) == (FORM_FEEDBACK_ID, FORM_TEXT, kept)
        for reply in replies[1:]:
            is_error, found = tool_payload(reply)
            assert not is_error
            assert [(row['feedback_id'], row['metadata']) for row in found['items']] == [(FORM_FEEDBACK_ID, kept)]
        assert [_values_in(reply, FORM_CONTACT_ANSWER.values()) for reply in replies] == [set()] * 3
        _, whole = tool_payload(_connected(world, world.mint('alice', scope='read')).call(
            'feedback_get', {'feedback_id': FORM_FEEDBACK_ID}))
        assert 'author' not in item
        assert {key: value for key, value in item.items() if key != 'metadata'} == {
            key: value for key, value in whole.items() if key != 'metadata'}

    def test_an_email_typed_into_an_open_answer_follows_the_source_policy_not_the_pin(self, world):
        # (S1, S3, S4, 7.104.00 review) The pin removes the named contact fields only. An address typed into an
        # open-text question (an email-typed input) is the respondent's own words: a pinned token reads it as the
        # source's PII policy stored it, in form_answers and in the item's text (here allow, so as typed; redact would
        # have run it through the PII redaction before it was stored).
        client = _connected(world, world.mint('alice', scope='read', project_id=ALPHA))

        is_error, item = tool_payload(client.call('feedback_get', {'feedback_id': FORM_FEEDBACK_ID}))
        assert (is_error, item['metadata']['form_answers']['q_reply']) == (False, FORM_TYPED_EMAIL)
        assert FORM_TYPED_EMAIL in item['original_text']
        found = client.call('feedback_search', {'days': 1, 'query': 'refunds'})
        assert _values_in(found, [FORM_TYPED_EMAIL]) == {FORM_TYPED_EMAIL}

    def test_reads_an_inbox_email_without_its_sender(self, world):
        # (S2, 7.104.00 review) The email inbox keeps its sender's name, else address, as the item's top-level author
        # and the address as metadata.email: a pinned token reads neither, through feedback_get or feedback_search,
        # and the rest of the item as stored.
        world.feedback.put_item(Item=inbox_item())
        client = _connected(world, world.mint('alice', scope='read', project_id=ALPHA))
        stored = {key: value for key, value in inbox_item()['metadata'].items() if key != 'email'}

        replies = [client.call('feedback_get', {'feedback_id': INBOX_FEEDBACK_ID}),
                   client.call('feedback_search', {'days': 1, 'query': 'export'})]
        is_error, item = tool_payload(replies[0])
        assert (is_error, 'author' in item, item['metadata']) == (False, False, stored)
        is_error, found = tool_payload(replies[1])
        assert [(row['feedback_id'], 'author' in row) for row in found['items']] == [(INBOX_FEEDBACK_ID, False)]
        assert [_values_in(reply, INBOX_SENDER.values()) for reply in replies] == [set()] * 2

    def test_an_unpinned_token_reads_the_contact_fields_as_before(self, world):
        world.feedback.put_item(Item=inbox_item())
        client = _connected(world, world.mint('alice', scope='read'))

        form = client.call('feedback_get', {'feedback_id': FORM_FEEDBACK_ID})
        is_error, item = tool_payload(form)
        assert (is_error, item['metadata']) == (False, FORM_METADATA)
        is_error, found = tool_payload(client.call('feedback_search', {'days': 1, 'query': 'refunds'}))
        assert (is_error, [row['metadata'] for row in found['items']]) == (False, [FORM_METADATA])
        inbox = client.call('feedback_get', {'feedback_id': INBOX_FEEDBACK_ID})
        is_error, mail = tool_payload(inbox)
        assert (is_error, mail['author'], mail['metadata']) == (False, INBOX_SENDER['author'], inbox_item()['metadata'])
        # (Q1) The pinned tests' check finds every value in these answers, so it fails once one reaches a pinned token.
        assert (_values_in(form, FORM_CONTACT_ANSWER.values()), _values_in(inbox, INBOX_SENDER.values())) == (
            set(FORM_CONTACT_ANSWER.values()), set(INBOX_SENDER.values()))

    def test_is_confined_to_its_project(self, world):
        minted = world.mint('alice', scope='write', project_id=ALPHA)
        client = _connected(world, minted)

        is_error, listed = tool_payload(client.call('projects_list'))
        assert not is_error
        assert [p['project_id'] for p in listed['projects']] == [ALPHA]

        # Gamma is public — alice herself could read it, but this token cannot.
        calls_before = len(world.lambdas.calls)
        is_error, message = tool_payload(client.call('projects_get', {'project_id': GAMMA}))
        assert is_error
        assert f'scoped to project {ALPHA}' in message
        assert len(world.lambdas.calls) == calls_before
        assert world.audit('alice', minted['token_id'])[0]['outcome'] == gt.OUTCOME_DENIED

    def test_defaults_project_tools_to_its_project(self, world):
        client = _connected(world, world.mint('alice', scope='write', project_id=ALPHA))

        is_error, created = tool_payload(client.call('documents_create', {'title': 'Pinned', 'content': 'Hi'}))

        assert not is_error
        assert world.projects.get_item(
            Key={'pk': f'PROJECT#{ALPHA}', 'sk': f"DOC#{created['document']['document_id']}"},
        ).get('Item')

    @staticmethod
    def _prd_with_a_thread(world) -> str:
        """A PRD in alpha with one comment thread on the whole document; answers the thread's id."""
        from shared import document_comments, document_series

        prd = {'pk': f'PROJECT#{ALPHA}', 'sk': 'PRD#prd_a1', 'document_id': 'prd_a1', 'document_type': 'prd',
               'version': 1, 'title': 'Refunds (v1)', 'base_title': 'Refunds', 'content': 'Refund in 3 days.'}
        world.projects.put_item(Item=prd)
        series = document_series.series_of(ALPHA, prd)['series_id']
        thread = document_comments.thread_item(project_id=ALPHA, series_id=series, document=prd,
                                               author=document_comments.user_author('s', 'Ann'), text='Faster?',
                                               anchor=None, workspace=None)
        document_comments.put_thread(world.projects, thread, workspace=None)
        return thread['comment_id']

    @staticmethod
    @contextmanager
    def _assist_job_started() -> Generator[MagicMock]:
        """The pass's job start (an async worker invoke) as a mock answering ``job_r``; the world has no
        aggregates table, so the caller's category scope (captured into the job's config) is a fixed one."""
        with patch('projects_handler.assist_jobs.start', return_value={'success': True, 'job_id': 'job_r'}) as start, \
                patch('projects_handler._caller_category_scope', return_value={}):
            yield start

    def test_marks_comments_addressed_in_its_project_only(self, world):
        thread_id = self._prd_with_a_thread(world)
        minted = world.mint('alice', scope='write', project_id=ALPHA)
        client = _connected(world, minted)
        assert {'documents_revise_from_comments', 'documents_mark_comments_addressed'} <= set(client.tool_names())
        args = {'document_id': 'prd_a1', 'thread_ids': [thread_id]}

        with patch('shared.document_review_routes.get_projects_table', return_value=world.projects):
            is_error, marked = tool_payload(client.call('documents_mark_comments_addressed', args))
            assert not is_error, marked
            assert marked['threads'][0]['addressed'] == {
                'version': 1, 'at': marked['threads'][0]['addressed']['at'], 'by_kind': 'ai'}
            is_error, cleared = tool_payload(client.call('documents_mark_comments_addressed',
                                                         {**args, 'addressed': False}))
            assert not is_error, cleared
            assert cleared['threads'][0]['addressed'] is None
            # The tool passes thread_ids through: the route's 400 is the tool's error.
            is_error, refused = tool_payload(client.call('documents_mark_comments_addressed',
                                                         {**args, 'thread_ids': ['not a comment id']}))
            assert is_error
            assert 'thread_ids must be a list of 1 to 50 comment ids' in refused
        is_error, message = tool_payload(client.call('documents_mark_comments_addressed',
                                                     {**args, 'project_id': GAMMA}))
        assert is_error
        assert f'scoped to project {ALPHA}' in message
        assert world.audit('alice', minted['token_id'])[0]['tool'] == 'documents_mark_comments_addressed'

    def test_starts_revise_from_comments_in_its_project_only(self, world):
        thread_id = self._prd_with_a_thread(world)
        minted = world.mint('alice', scope='write', project_id=ALPHA)
        client = _connected(world, minted)

        with self._assist_job_started() as start:
            is_error, started = tool_payload(client.call('documents_revise_from_comments',
                                                         {'document_id': 'prd_a1', 'thread_ids': [thread_id]}))
            assert not is_error, started
            assert started['job_id'] == 'job_r'
            config = start.call_args.args[2]
            assert (config['project_id'], config['document_id']) == (ALPHA, 'prd_a1')
            assert config['body_json'] == f'{{"thread_ids": ["{thread_id}"]}}'
            is_error, message = tool_payload(client.call('documents_revise_from_comments',
                                                         {'document_id': 'prd_a1', 'project_id': GAMMA}))
            assert is_error
            assert f'scoped to project {ALPHA}' in message
            assert start.call_count == 1
        events = world.audit('alice', minted['token_id'])
        assert [(e['tool'], e['outcome']) for e in events[:2]] == [
            ('documents_revise_from_comments', gt.OUTCOME_DENIED), ('documents_revise_from_comments', gt.OUTCOME_OK)]

    def test_a_read_token_is_refused_both_review_tools(self, world):
        self._prd_with_a_thread(world)
        client = _connected(world, world.mint('alice', scope='read', project_id=ALPHA))
        assert not {'documents_revise_from_comments', 'documents_mark_comments_addressed'} & set(client.tool_names())
        calls_before = len(world.lambdas.calls)
        for name in ('documents_revise_from_comments', 'documents_mark_comments_addressed'):
            is_error, message = tool_payload(client.call(name, {'document_id': 'prd_a1', 'thread_ids': ['x']}))
            assert is_error
            assert 'read-only' in message
        assert len(world.lambdas.calls) == calls_before

    def test_the_names_before_6_10_still_work_unlisted_and_are_audited_under_the_new_names(self, world):
        thread_id = self._prd_with_a_thread(world)
        minted = world.mint('alice', scope='write', project_id=ALPHA)
        client = _connected(world, minted)
        listed = set(client.tool_names())
        assert not {'list_projects', 'generate', 'get_document', 'create_document'} & listed

        is_error, projects = tool_payload(client.call('list_projects'))
        assert not is_error
        assert [p['project_id'] for p in projects['projects']] == [ALPHA]
        # The old `generate` + `step: revise` + `mark_addressed` is documents_mark_comments_addressed.
        with patch('shared.document_review_routes.get_projects_table', return_value=world.projects):
            is_error, marked = tool_payload(client.call('generate', {
                'step': 'revise', 'document_id': 'prd_a1', 'thread_ids': [thread_id], 'mark_addressed': True}))
        assert not is_error, marked
        assert marked['threads'][0]['addressed']['version'] == 1
        # The old `generate` without `mark_addressed` starts a pass.
        with self._assist_job_started():
            is_error, started = tool_payload(client.call('generate', {
                'step': 'revise', 'document_id': 'prd_a1', 'thread_ids': [thread_id]}))
        assert (is_error, started['job_id']) == (False, 'job_r')
        events = world.audit('alice', minted['token_id'])
        assert [e['tool'] for e in events[:3]] == [
            'documents_revise_from_comments', 'documents_mark_comments_addressed', 'projects_list']

    def test_cannot_be_minted_for_a_project_the_minter_cannot_see(self, world):
        status, body = world.tokens_api('alice', 'POST', '/connect/tokens',
                                        {'name': 'x', 'scope': 'read', 'project_id': BETA})
        assert status == 404, body


class TestRunAgent:
    def test_a_non_admin_token_is_refused(self, world):
        client = _connected(world, world.mint('alice', scope='write'))
        assert 'agents_run' not in client.tool_names()

        is_error, message = tool_payload(client.call('agents_run', {'agent_id': world.agent_id}))

        assert is_error
        assert 'administrator' in message
        world.agents_env.sfn.start_execution.assert_not_called()

    def test_an_admin_minted_write_token_starts_a_run(self, world):
        minted = world.mint('root', scope='write')
        client = _connected(world, minted)
        assert 'agents_run' in client.tool_names()

        is_error, started = tool_payload(client.call('agents_run', {'agent_id': world.agent_id}))

        assert not is_error, started
        assert started['run']['agent_id'] == world.agent_id
        world.agents_env.sfn.start_execution.assert_called_once()
        assert world.audit('root', minted['token_id'])[0]['outcome'] == gt.OUTCOME_OK

    def test_an_admin_read_token_is_refused(self, world):
        client = _connected(world, world.mint('root', scope='read'))

        is_error, message = tool_payload(client.call('agents_run', {'agent_id': world.agent_id}))

        assert is_error
        assert 'read-only' in message

    def test_a_demoted_admins_token_stops_running_agents(self, world):
        client = _connected(world, world.mint('root', scope='write'))
        world.cognito.demote('root')

        is_error, message = tool_payload(client.call('agents_run', {'agent_id': world.agent_id}))

        assert is_error
        assert 'still an administrator' in message
        world.agents_env.sfn.start_execution.assert_not_called()


class TestAgentRuns:
    """`agents_get_run` follows a run `agents_run` started, with a READ token of anyone who sees the agent."""

    def _started_run(self, world) -> str:
        client = _connected(world, world.mint('root', scope='write'))
        is_error, started = tool_payload(client.call('agents_run', {'agent_id': world.agent_id}))
        assert not is_error, started
        return started['run']['run_id']

    def test_a_read_token_reads_the_run_by_id(self, world):
        run_id = self._started_run(world)
        client = _connected(world, world.mint('alice', scope='read'))

        is_error, body = tool_payload(client.call('agents_get_run', {'agent_id': world.agent_id, 'run_id': run_id}))

        assert not is_error, body
        assert (body['run']['run_id'], body['run']['agent_id']) == (run_id, world.agent_id)

    def test_without_a_run_id_it_lists_the_newest_runs(self, world):
        run_id = self._started_run(world)
        client = _connected(world, world.mint('alice', scope='read'))

        is_error, body = tool_payload(client.call('agents_get_run', {'agent_id': world.agent_id}))

        assert not is_error, body
        assert [run['run_id'] for run in body['items']] == [run_id]

    def test_an_unknown_run_is_a_tool_error_the_model_can_act_on(self, world):
        client = _connected(world, world.mint('alice', scope='read'))

        is_error, message = tool_payload(client.call('agents_get_run', {'agent_id': world.agent_id,
                                                                       'run_id': 'run_missing'}))

        assert is_error
        assert 'HTTP 404' in message


class TestTokenOwnership:
    def test_lists_only_my_tokens_and_never_a_secret(self, world):
        mine = world.mint('alice', scope='read')
        world.mint('bob', scope='read')

        status, body = world.tokens_api('alice', 'GET', '/connect/tokens')

        assert status == 200
        assert [t['token_id'] for t in body['tokens']] == [mine['token_id']]
        assert body['endpoint_path'] == '/mcp/global'
        assert all('secret_hash' not in t and 'token' not in t for t in body['tokens'])

    def test_someone_elses_token_cannot_be_revoked_or_audited(self, world):
        bobs = world.mint('bob', scope='read')

        assert world.tokens_api('alice', 'DELETE', f"/connect/tokens/{bobs['token_id']}")[0] == 404
        assert world.tokens_api('alice', 'GET', f"/connect/tokens/{bobs['token_id']}")[0] == 404
