"""The memory API inside a workspace (api/memory_handler.py): its memories, its admins curating, its viewers reading."""
from __future__ import annotations

import boto3
from cross_workspace_worlds import A_MARK, ADA_MEMBER_ONLY, B_MARK, WS_A, memory_world

VIEWER = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'}
#: In the deployment's admins group, but only a viewer of workspace A.
ADMIN_VIEWER = {**VIEWER, 'cognito:groups': '[admins, users]'}


def _pks() -> set[str]:
    table = boto3.resource('dynamodb', region_name='us-east-1').Table('memory')
    return {str(row['pk']) for row in table.scan(ConsistentRead=True)['Items']}


def test_a_memory_added_inside_a_workspace_is_kept_and_recalled_there(lambda_context):
    with memory_world(lambda_context) as world:
        status, body = world.call('POST', '/memory', ws=WS_A, caller=ADA_MEMBER_ONLY,
                                  body={'scope': 'personal', 'statement': 'I prefer weekly digests of refunds'})
        assert status == 200
        assert f'WS#{WS_A}#MEM#user#sub-ada' in _pks()
        status, body = world.call('POST', '/memory/retrieve', ws=WS_A, caller=ADA_MEMBER_ONLY,
                                  body={'query': 'refunds'})
        assert status == 200
        statements = ' '.join(item['statement'] for item in body['items'])
        assert A_MARK in statements
        assert B_MARK not in statements
        assert 'before workspaces' not in statements


def test_a_viewer_reads_but_does_not_write(lambda_context):
    with memory_world(lambda_context) as world:
        assert world.call('GET', '/memory', ws=WS_A, caller=VIEWER)[0] == 200
        before = _pks()
        status, _ = world.call('POST', '/memory', ws=WS_A, caller=VIEWER,
                               body={'scope': 'personal', 'statement': 'I prefer weekly digests of refunds'})
        assert status == 403
        assert world.call('POST', '/memory/mem_a0/confirm', ws=WS_A, caller=VIEWER)[0] == 403
        assert _pks() == before


def test_the_workspaces_admins_curate_and_the_deployments_admins_group_grants_nothing_there(lambda_context):
    with memory_world(lambda_context) as world:
        assert world.call('POST', '/memory/mem_a0/forget', ws=WS_A, caller=ADMIN_VIEWER)[0] == 403
        assert world.call('GET', '/memory', ws=WS_A, caller=ADMIN_VIEWER,
                          query={'status': 'archived'})[0] == 403
        assert world.call('POST', '/memory/mem_a0/forget', ws=WS_A, caller=ADA_MEMBER_ONLY)[0] == 200
        status, body = world.call('GET', '/memory', ws=WS_A, caller=ADA_MEMBER_ONLY, query={'status': 'archived'})
        assert status == 200
        assert 'mem_a0' in {item['memory_id'] for item in body['items']}


def test_page_imports_wait_for_their_extraction_inside_a_workspace(lambda_context):
    with memory_world(lambda_context) as world:
        before = _pks()
        status, body = world.call('POST', '/memory/imports', ws=WS_A, caller=ADA_MEMBER_ONLY,
                                  body={'title': 'Returns policy', 'content': 'Buyers may return within thirty days.'})
        assert status == 409
        assert 'workspace' in body['error']
        assert _pks() == before


def test_a_write_resolves_fresh_and_a_read_from_the_warm_cache(lambda_context):
    """A removed member writes nothing there at once; the assistant's recall on every run costs no extra read."""
    from unittest.mock import patch

    import memory_handler

    with memory_world(lambda_context) as world:
        with patch.object(memory_handler, 'request_workspace', wraps=memory_handler.request_workspace) as resolve:
            world.call('POST', '/memory/retrieve', ws=WS_A, caller=ADA_MEMBER_ONLY, body={'query': 'refunds'})
            world.call('GET', '/memory', ws=WS_A, caller=ADA_MEMBER_ONLY)
            world.call('POST', '/memory/mem_a0/confirm', ws=WS_A, caller=ADA_MEMBER_ONLY)
        assert [call.kwargs['fresh'] for call in resolve.call_args_list] == [False, False, True]


def test_the_memory_reviewer_flag_grants_nothing_inside_a_workspace(lambda_context):
    with memory_world(lambda_context) as world:
        aggregates = boto3.resource('dynamodb', region_name='us-east-1').Table('aggregates')
        aggregates.put_item(Item={'pk': 'USERFLAGS#sub-vic', 'sk': 'config', 'memory_reviewer': True})
        assert world.call('POST', '/memory/mem_a0/forget', ws=WS_A, caller=VIEWER)[0] == 403
        assert world.call('GET', '/memory', ws=WS_A, caller=VIEWER, query={'status': 'archived'})[0] == 403
        # The same flag still makes them a curator of the deployment's memories.
        assert world.call('GET', '/memory', ws=None, caller=VIEWER, query={'status': 'archived'})[0] == 200


def test_a_memory_is_tagged_and_hidden_against_the_workspaces_own_categories(lambda_context):
    """D8: the workspace's categories decide inside it, never the deployment's (a workspace saves its own, 7.08.00)."""
    from shared.category_access import access_key
    from shared.workspace_settings import settings_key

    with memory_world(lambda_context) as world:
        aggregates = boto3.resource('dynamodb', region_name='us-east-1').Table('aggregates')
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                                  'categories': [{'name': 'shipping', 'subcategories': []}]})
        aggregates.put_item(Item={**settings_key(WS_A, 'categories'),
                                  'categories': [{'name': 'warranty', 'subcategories': []},
                                                 {'name': 'recalls', 'subcategories': []}]})
        status, body = world.call('POST', '/memory', ws=WS_A, caller=ADA_MEMBER_ONLY,
                                  body={'scope': 'company', 'statement': 'Buyers ask how long the cover lasts',
                                        'categories': ['warranty', 'shipping']})
        assert status == 200
        # The workspace's category is kept; the deployment's, unknown in the workspace, is dropped.
        assert body['memory']['categories'] == ['warranty']
        # A member restricted to warranty: a memory naming the workspace's other category is withheld from them.
        aggregates.put_item(Item={**access_key('sub-vic'), 'categories': ['warranty']})
        world.call('POST', '/memory', ws=WS_A, caller=ADA_MEMBER_ONLY,
                   body={'scope': 'company', 'statement': 'Recalls spike after each launch'})
        _, everything = world.call('GET', '/memory', ws=WS_A, caller=ADA_MEMBER_ONLY)
        assert 'Recalls spike' in ' '.join(item['statement'] for item in everything['items'])
        _, listed = world.call('GET', '/memory', ws=WS_A, caller=VIEWER)
        statements = ' '.join(item['statement'] for item in listed['items'])
        assert 'Recalls spike' not in statements


def test_an_editors_company_memory_waits_for_the_workspaces_admins(lambda_context):
    from cross_workspace_worlds import WS_A as ws

    editor = {'sub': 'sub-edi', 'cognito:username': 'edi', 'cognito:groups': 'users'}
    with memory_world(lambda_context) as world:
        workspaces = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
        workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'MEMBER#sub-edi', 'role': 'editor'})
        status, body = world.call('POST', '/memory', ws=ws, caller=editor,
                                  body={'scope': 'company', 'statement': 'Buyers want invoices emailed monthly'})
        assert (status, body['memory']['status']) == (200, 'proposed')
        _, queue = world.call('GET', '/memory/review', ws=ws, caller=ADA_MEMBER_ONLY)
        assert body['memory']['memory_id'] in {entry['memory']['memory_id'] for entry in queue['items']}
