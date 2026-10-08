"""Tests for memory_handler.py — every /memory route against moto."""
import json

import pytest
from moto_helpers import invoke, rest_event

import memory_handler
from shared import memory_store as store
from shared.test.memory_fixtures import (
    ADMIN_CLAIMS,
    MCP_CLAIMS,
    OTHER_CLAIMS,
    RAW_BUCKET,
    REVIEWER_CLAIMS,
    USER_CLAIMS,
    memory_world,
    relations_reply,
)


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as w:
        monkeypatch.setattr(memory_handler, 'RAW_DATA_BUCKET', RAW_BUCKET)
        monkeypatch.setattr(memory_handler, 'MEMORY_QUEUE_URL', w.queue_url)
        monkeypatch.setattr(memory_handler, 'get_s3_client', lambda: w.s3)
        monkeypatch.setattr(memory_handler, 'get_sqs_client', lambda: w.sqs)
        w.flag_reviewer(REVIEWER_CLAIMS['sub'])
        yield w


@pytest.fixture
def call(world, lambda_context):
    def _call(method, path, *, claims=USER_CLAIMS, body=None, params=None, path_params=None):
        event = rest_event(method, path, claims=claims, body=body, path_params=path_params)
        event['queryStringParameters'] = params
        return invoke(memory_handler, event, lambda_context, memory=world.memory, aggregates=world.aggregates)
    return _call


def _add(call, statement, *, scope='company', claims=REVIEWER_CLAIMS, kind='product'):
    status, body = call('POST', '/memory', claims=claims, body={'scope': scope, 'statement': statement, 'kind': kind})
    assert status == 200, body
    return body['memory']


# ── Add + list ───────────────────────────────────────────────────────────────
def test_curator_company_add_is_live_and_listed_for_everyone(call):
    memory = _add(call, 'Customers want faster refunds')
    assert memory['status'] == 'active'
    assert memory['source_kind'] == 'user_explicit'
    assert 'embedding' not in memory
    assert 'supporter_set' not in memory
    assert 'owner_sub' not in memory
    status, body = call('GET', '/memory', claims=OTHER_CLAIMS, params={'scope': 'company'})
    assert status == 200
    assert [m['statement'] for m in body['items']] == ['Customers want faster refunds']


def test_non_curator_company_add_is_proposed(call):
    assert _add(call, 'Customers want faster refunds', claims=USER_CLAIMS)['status'] == 'proposed'


def test_personal_memories_are_private_to_their_owner(call):
    memory = _add(call, 'Prefers short answers always', scope='personal', claims=USER_CLAIMS, kind='working_style')
    status, body = call('GET', '/memory', params={'scope': 'personal'})
    assert [m['memory_id'] for m in body['items']] == [memory['memory_id']]
    status, body = call('GET', '/memory', claims=OTHER_CLAIMS, params={'scope': 'personal'})
    assert body['items'] == []
    # Another user — even an admin — cannot address it by id.
    for claims in (OTHER_CLAIMS, ADMIN_CLAIMS):
        status, _ = call('POST', f"/memory/{memory['memory_id']}/forget", claims=claims,
                         path_params={'memory_id': memory['memory_id']})
        assert status == 404


def test_list_pages_with_a_cursor(call):
    for i in range(3):
        _add(call, f'Customers want feature number {i} quickly please')
    status, body = call('GET', '/memory', params={'scope': 'company', 'limit': '2'})
    assert status == 200
    first = body['items']
    status, body = call('GET', '/memory', params={'scope': 'company', 'limit': '2', 'cursor': body['next_cursor']})
    ids = {m['memory_id'] for m in first} | {m['memory_id'] for m in body['items']}
    assert len(ids) == 3
    status, _ = call('GET', '/memory', params={'scope': 'company', 'cursor': 'garbage!!'})
    assert status == 400


def test_stats_are_admin_only_counts(call):
    _add(call, 'Prefers short answers always', scope='personal', claims=USER_CLAIMS, kind='working_style')
    status, body = call('GET', '/memory/stats', claims=ADMIN_CLAIMS)
    assert status == 200
    assert body['personal']['active'] == 1
    assert 'statement' not in json.dumps(body)
    assert call('GET', '/memory/stats', claims=REVIEWER_CLAIMS)[0] == 403


# ── Confirm, edit, forget, restore, merge ────────────────────────────────────
def test_confirm_counts_each_person_once(call):
    memory = _add(call, 'Customers want faster refunds')
    path = f"/memory/{memory['memory_id']}/confirm"
    pp = {'memory_id': memory['memory_id']}
    status, body = call('POST', path, claims=OTHER_CLAIMS, path_params=pp)
    assert (status, body['counted'], body['memory']['supporters']) == (200, True, 2)
    status, body = call('POST', path, claims=OTHER_CLAIMS, path_params=pp)
    assert (body['counted'], body['memory']['supporters']) == (False, 2)


def test_company_edits_need_a_curator(call):
    memory = _add(call, 'Customers want faster refunds')
    pp = {'memory_id': memory['memory_id']}
    path = f"/memory/{memory['memory_id']}"
    assert call('PUT', path, claims=USER_CLAIMS, body={'statement': 'Customers want instant refunds'},
                path_params=pp)[0] == 403
    status, body = call('PUT', path, claims=REVIEWER_CLAIMS,
                        body={'statement': 'Customers want instant refunds', 'kind': 'customer'}, path_params=pp)
    assert status == 200
    assert (body['memory']['statement'], body['memory']['kind']) == ('Customers want instant refunds', 'customer')


def test_forget_tombstones_and_restore_revives(call, world):
    memory = _add(call, 'Customers want faster refunds')
    pp = {'memory_id': memory['memory_id']}
    status, body = call('POST', f"/memory/{memory['memory_id']}/forget", claims=REVIEWER_CLAIMS, path_params=pp)
    assert (status, body['memory']['status'], body['memory']['tombstoned']) == (200, 'archived', True)
    # Automation cannot bring it back: the same statement lands in review instead.
    outcome = store.write_automated(world.memory, [store.Candidate(
        statement='Customers want faster refunds', kind='product', scope='company', confidence=0.95,
        source_kind='extracted', source={'type': 'session', 'ref': 's', 'at': 'x'}, supporter='h-z')])
    assert outcome.proposed == 1
    status, body = call('POST', f"/memory/{memory['memory_id']}/restore", claims=REVIEWER_CLAIMS, path_params=pp)
    assert (status, body['memory']['status'], body['memory']['tombstoned']) == (200, 'active', False)


def test_merge(call):
    a = _add(call, 'Refunds take too long for customers')
    b = _add(call, 'Delivery tracking is unclear to customers')
    status, body = call('POST', '/memory/merge', claims=REVIEWER_CLAIMS,
                        body={'ids': [a['memory_id'], b['memory_id']], 'statement': 'Refunds and tracking are slow'})
    assert status == 200
    assert body['memory']['status'] == 'active'
    assert call('POST', '/memory/merge', claims=USER_CLAIMS,
                body={'ids': [a['memory_id'], b['memory_id']], 'statement': 'Nope nope nope'})[0] in (403, 409)
    assert call('POST', '/memory/merge', claims=REVIEWER_CLAIMS,
                body={'ids': [a['memory_id']], 'statement': 'Too few to merge'})[0] == 400


# ── Review queue ─────────────────────────────────────────────────────────────
def _conflict_pair(call, world):
    old = _add(call, 'Customers prefer monthly billing plans')
    world.converse.return_value = relations_reply(['contradicts'])
    store.write_automated(world.memory, [store.Candidate(
        statement='Customers now prefer yearly billing plans', kind='customer', scope='company', confidence=0.9,
        source_kind='extracted', source={'type': 'session', 'ref': 's', 'at': 'x'}, supporter='h-z')])
    new = next(r for r in world.memories() if r['status'] == 'conflict')
    return old, new


def test_review_lists_conflicts_with_a_suggestion(call, world):
    old, new = _conflict_pair(call, world)
    status, body = call('GET', '/memory/review', claims=REVIEWER_CLAIMS)
    assert status == 200
    [entry] = body['items']
    assert entry['memory']['memory_id'] == new['memory_id']
    assert [m['memory_id'] for m in entry['linked']] == [old['memory_id']]
    # The explicit side wins the suggestion.
    assert entry['suggestion']['winner_id'] == old['memory_id']
    status, body = call('GET', '/memory/review', claims=USER_CLAIMS)
    assert body['items'] == []


@pytest.mark.parametrize('action', ['keep_both', 'keep', 'replace', 'merge'])
def test_resolve(call, world, action):
    old, new = _conflict_pair(call, world)
    body = {'action': action}
    if action == 'keep':
        body['winner_id'] = old['memory_id']
    if action in ('replace', 'merge'):
        body['statement'] = 'Customers choose between monthly and yearly billing'
    status, result = call('POST', f"/memory/review/{new['memory_id']}/resolve", claims=REVIEWER_CLAIMS, body=body,
                          path_params={'memory_id': new['memory_id']})
    assert status == 200, result
    assert result['memory']['status'] == 'active'
    assert result['memory']['conflicts_with'] == []
    statuses = {r['memory_id']: (r['status'], r.get('tombstoned')) for r in world.memories()}
    if action == 'keep':
        assert statuses[new['memory_id']] == ('archived', True)
    if action == 'replace':
        assert statuses[old['memory_id']] == ('archived', True)
    if action == 'keep_both':
        assert statuses[old['memory_id']][0] == 'active'


# ── Imports ──────────────────────────────────────────────────────────────────
def test_import_stores_the_original_and_queues_chunk_zero(call, world):
    status, body = call('POST', '/memory/imports', claims=REVIEWER_CLAIMS,
                        body={'title': 'Wiki', 'url': 'https://wiki.example.com/p', 'content': 'Our customers... ' * 50})
    assert status == 202
    import_id = body['import_id']
    stored = json.loads(world.s3.get_object(Bucket=RAW_BUCKET, Key=f'memory-imports/{import_id}.json')['Body'].read())
    assert stored['title'] == 'Wiki'
    assert world.queued() == [{'kind': 'import', 'import_id': import_id, 'chunk': 0}]
    status, body = call('GET', f'/memory/imports/{import_id}', claims=REVIEWER_CLAIMS,
                        path_params={'import_id': import_id})
    assert (status, body['import']['status']) == (200, 'queued')
    status, body = call('GET', '/memory/imports', claims=REVIEWER_CLAIMS)
    assert [i['import_id'] for i in body['items']] == [import_id]


# ── Internal routes ──────────────────────────────────────────────────────────
def test_retrieve_returns_company_and_own_personal(call):
    _add(call, 'Customers want faster refunds')
    _add(call, 'Prefers refunds answers short', scope='personal', claims=USER_CLAIMS, kind='working_style')
    _add(call, 'Prefers refunds answers long', scope='personal', claims=OTHER_CLAIMS, kind='working_style')
    status, body = call('POST', '/memory/retrieve', body={'query': 'refunds', 'k': 5})
    assert status == 200
    statements = {m['statement'] for m in body['items']}
    assert statements == {'Customers want faster refunds', 'Prefers refunds answers short'}
    assert set(body['items'][0]) == {'memory_id', 'scope', 'kind', 'statement', 'supporters'}
    # An MCP credential recalls as its minter (sub-user): company + the minter's own
    # personal memories, never another user's (global MCP, docs/mcp.md).
    status, body = call('POST', '/memory/retrieve', claims=MCP_CLAIMS, body={'query': 'refunds'})
    assert {m['statement'] for m in body['items']} == {'Customers want faster refunds', 'Prefers refunds answers short'}
    assert call('POST', '/memory/retrieve', body={})[0] == 400


def test_conflict_check_reports_only_contradictions(call, world):
    _add(call, 'Customers prefer monthly billing plans')
    world.converse.return_value = relations_reply(['contradicts'])
    status, body = call('GET', '/memory/conflict-check', params={'statement': 'Customers prefer yearly billing plans'})
    assert status == 200
    assert [c['statement'] for c in body['conflicts']] == ['Customers prefer monthly billing plans']
    assert world.converse.call_args.kwargs['service_tier'] is None  # interactive: never Flex
    world.converse.return_value = relations_reply(['same'])
    status, body = call('GET', '/memory/conflict-check', params={'statement': 'Customers prefer monthly billing'})
    assert body['conflicts'] == []
    assert call('GET', '/memory/conflict-check')[0] == 400


# ── Category access and forgotten memories (security review) ────────────────
def _file_under(world, memory: dict, categories: list[str]) -> None:
    """File an existing company memory under feedback ``categories``."""
    world.memory.update_item(Key={'pk': store.COMPANY_PK, 'sk': f"{store.MEMORY_SK_PREFIX}{memory['memory_id']}"},
                             UpdateExpression='SET categories = :c', ExpressionAttributeValues={':c': categories})
    store.clear_pool_cache()


def _restrict(world, claims: dict, categories: list[str]) -> None:
    from shared.category_access import access_key
    world.aggregates.put_item(Item={**access_key(claims['sub']), 'categories': categories})


def test_company_memories_about_a_hidden_category_are_hidden_like_its_reviews(call, world):
    checkout = _add(call, 'Checkout customers want a guest option')
    _file_under(world, checkout, ['checkout'])
    _add(call, 'The company sells in five countries')  # no category: general knowledge
    _restrict(world, OTHER_CLAIMS, ['billing'])

    _, listed = call('GET', '/memory', claims=OTHER_CLAIMS, params={'scope': 'company'})
    _, recalled = call('POST', '/memory/retrieve', claims=OTHER_CLAIMS, body={'query': 'customers checkout guest'})

    assert [m['statement'] for m in listed['items']] == ['The company sells in five countries']
    assert all('guest' not in m['statement'] for m in recalled['items'])


def test_an_unrestricted_reader_still_sees_every_company_memory(call, world):
    checkout = _add(call, 'Checkout customers want a guest option')
    _file_under(world, checkout, ['checkout'])

    _, listed = call('GET', '/memory', claims=OTHER_CLAIMS, params={'scope': 'company'})

    assert [m['statement'] for m in listed['items']] == ['Checkout customers want a guest option']


def test_forgotten_company_memories_are_for_curators_only(call):
    memory = _add(call, 'Customers want faster refunds')
    status, _ = call('POST', f"/memory/{memory['memory_id']}/forget", claims=REVIEWER_CLAIMS,
                     path_params={'memory_id': memory['memory_id']})
    assert status == 200

    status, _ = call('GET', '/memory', claims=OTHER_CLAIMS, params={'scope': 'company', 'status': 'archived'})
    assert status == 403
    status, body = call('GET', '/memory', claims=REVIEWER_CLAIMS, params={'scope': 'company', 'status': 'archived'})
    assert status == 200
    assert [m['statement'] for m in body['items']] == ['Customers want faster refunds']


# ── The production GET sweep, in process (F1) ────────────────────────────────
# reports/memory-prod-sweep-*.txt runs these exact routes against production as
# e2e-admin and e2e-user. Before the F1 fix the four personal/review rows were 502
# there (and passed here: moto accepted the key-attribute filter). Under the
# strict-Query and strict-IAM guards (lambda/conftest.py) they now answer here as
# production must, with seeded rows so every filter actually runs.
PROD_SWEEP = [
    # (path, query, status for e2e-admin, status for e2e-user)
    ('/memory', {'scope': 'company'}, 200, 200),
    ('/memory', {'scope': 'company', 'status': 'proposed'}, 200, 200),
    ('/memory', {'scope': 'personal'}, 200, 200),
    ('/memory', {'scope': 'personal', 'status': 'archived'}, 200, 200),
    ('/memory', {'scope': 'personal', 'kind': 'product', 'q': 'checkout'}, 200, 200),
    ('/memory/review', None, 200, 200),
    ('/memory/stats', None, 200, 403),
    ('/memory/imports', None, 200, 403),
]


@pytest.mark.parametrize(('path', 'params', 'admin_status', 'user_status'), PROD_SWEEP)
def test_the_production_get_sweep_answers(call, path, params, admin_status, user_status):
    _add(call, 'Checkout must keep the basket', scope='personal', claims=USER_CLAIMS)
    _add(call, 'Checkout must keep the basket', scope='personal', claims=ADMIN_CLAIMS)
    _add(call, 'Refunds should be instant', claims=USER_CLAIMS)  # proposed: in the review queue
    for claims, expected in ((ADMIN_CLAIMS, admin_status), (USER_CLAIMS, user_status)):
        status, body = call('GET', path, claims=claims, params=params)
        assert status == expected, (claims['cognito:username'], path, params, body)


def test_personal_list_filters_by_kind_and_text(call):
    _add(call, 'Checkout must keep the basket', scope='personal', claims=USER_CLAIMS)
    _add(call, 'Prefers short answers', scope='personal', claims=USER_CLAIMS, kind='working_style')
    status, body = call('GET', '/memory', claims=USER_CLAIMS, params={'scope': 'personal', 'kind': 'product', 'q': 'checkout'})
    assert status == 200
    assert [m['statement'] for m in body['items']] == ['Checkout must keep the basket']


def test_review_lists_the_callers_own_proposed_personal_memories(call, world):
    """The personal half of GET /memory/review (list_personal, the F1 502)."""
    mine = _add(call, 'I review drafts on Fridays', scope='personal', claims=USER_CLAIMS, kind='working_style')
    row = store.get_item(world.memory, store.memory_key(store.scope_pk('personal', USER_CLAIMS['sub']), mine['memory_id']))
    assert row is not None
    store.set_fields(world.memory, row, {'status': 'proposed'}, now=memory_handler._now())
    status, body = call('GET', '/memory/review', claims=USER_CLAIMS)
    assert status == 200
    assert [e['memory']['memory_id'] for e in body['items']] == [mine['memory_id']]
