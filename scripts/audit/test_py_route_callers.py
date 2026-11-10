"""py_route_callers finds planted uncalled routes and stays quiet on every real caller shape."""
from __future__ import annotations

import json

import pytest
from audit_common import CDK_DIR, AuditError
from py_route_callers import callers_in, findings, main, routes_in, unrouted
from route_targets import gateway_methods, python_routes, spa_requests, stream_requests

from conftest import TreeMaker

HANDLER = '''
@app.get('/things')
def list_things(): ...

@app.post('/things')
def add_thing(): ...

@app.get('/things/<thing_id>/runs')
def runs(): ...

@app.get('/things/stats')
def stats(): ...

@app.delete('/things/<thing_id>')
def delete_thing(): ...

@app.put('/things/<thing_id>/notes/<note_id>')
def edit_note(): ...

@app.get('/reports/<report_id>')
def report(): ...
'''
SPA = '''
const BASE = '/things'
export const api = {
  list: () => fetchApi(BASE),
  add: (body) => fetchApi('/things', { method: 'POST', body }),
  runs: (id) => fetchApi(`${thingPath(id)}/runs`),
  one: (id) => fetchApi(`/things/${id}`),
}
'''
PY_DELEGATE = "def read(r):\n    return RouteRequest(DOMAIN, 'GET', f'/reports/{r}')\n"


@pytest.fixture
def result(make_tree: TreeMaker) -> dict[str, str]:
    root = make_tree({'lambda/api/things_handler.py': HANDLER, 'frontend/src/api/thingsApi.ts': SPA,
                      'lambda/shared/mcp_tools.py': PY_DELEGATE,
                      'frontend/src/api/thingsApi.test.ts': "fetchApi('/things/stats')\nfetchApi('/things/1/notes/2')"})
    callers, _ = callers_in(root)
    return {f.key: f.kind for f in findings(routes_in(root), callers)}


def test_planted_uncalled_routes_are_found(result: dict[str, str]) -> None:
    assert result == {
        'PUT /things/<thing_id>/notes/<note_id>': 'no-caller',     # only a TEST names it
        'GET /things/stats': 'weak-caller-only',                   # only `/things/${id}` could produce it
        'DELETE /things/<thing_id>': 'method-uncalled',            # `/things/${id}` is read with GET
    }


def test_route_decorators_are_not_their_own_callers(make_tree: TreeMaker) -> None:
    root = make_tree({'lambda/api/x_handler.py': "@app.get('/lonely')\ndef lonely(): ...\n"})
    callers, _ = callers_in(root)
    assert [f.key for f in findings(routes_in(root), callers)] == ['GET /lonely']


def test_an_empty_tree_trips_the_vacuity_guard(make_tree: TreeMaker) -> None:
    root = make_tree({'lambda/api/x_handler.py': ''})
    with pytest.raises(AuditError, match='vacuity'):
        main(['--cdk-dir', str(root)])


def test_vacuity_guard_on_the_real_tree() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0


# ---- called-no-route: a request no route serves ---------------------------------------------------------------

ROUTER_HANDLER = '''
from shared import things_routes
app = create_api_resolver()
app.include_router(things_routes.app)

@app.get('/integrations/<source>/apps')
def apps(): ...
'''
ROUTER = "@app.get('/things/<thing_id>')\ndef thing(): ...\n"
STACK = '''
const chatResource = api.root.addResource('chat');
const chatStreamResource = chatResource.addResource('stream');
chatStreamResource.addMethod('POST', chatStreamIntegration, authMethodOptions);
const intSourceResource = api.root.addResource('integrations').addResource('{source}');
intSourceResource.addProxy({ defaultIntegration: integrationsIntegration, anyMethod: true });
'''
STREAM = '''
const a = { fn: 'settings', method: 'GET', path: `/settings/${route}`, resource: '/settings/{proxy+}' };
const b = { fn: 'projects', method: 'GET', path: '/projectz', resource: '/projectz' };
'''


def _coverage(*calls: tuple[str, str, str]) -> str:
    return json.dumps([{'file': 'api/client.ts', 'method': verb, 'call': call, 'probes': [{'path': probe}]}
                       for verb, call, probe in calls])


def test_requests_no_route_serves_are_found(make_tree: TreeMaker) -> None:
    root = make_tree({
        'lambda/api/things_handler.py': ROUTER_HANDLER, 'lambda/shared/things_routes.py': ROUTER,
        'lambda/api/settings_handler.py': "@app.get('/settings/model/capacity')\ndef cap(): ...\n",
        'lib/stacks/api-routes.ts': STACK, 'lambda/stream/src/tools/x.ts': STREAM,
        'lambda/stream/src/tools/x.test.ts': "const t = { method: 'GET', path: '/nowhere' };",
        'frontend/mock-coverage.json': _coverage(
            ('GET', '`/things/${id}`', '/things/t1'),                     # a mounted router serves it
            ('POST', "'/chat/stream'", '/chat/stream'),                    # an explicit gateway method (not Python)
            ('GET', '`/integrations/${source}/apps`', '/integrations/web/apps'),
            ('POST', '`/integrations/${source}/test`', '/integrations/web/test'),   # only the {proxy+} takes it
            ('DELETE', '`/things/${id}`', '/things/t1'),                   # path served, verb not
        ),
    })
    served = python_routes(root) + gateway_methods(root)
    requests = spa_requests(root) + stream_requests(root)
    assert sorted(f.key for f in unrouted(requests, served)) == [
        'DELETE /things/{}', 'GET /projectz', 'POST /integrations/{}/test']


def test_a_trailing_parameter_may_stand_for_several_segments(make_tree: TreeMaker) -> None:
    root = make_tree({'lambda/api/settings_handler.py': "@app.get('/settings/model/capacity')\ndef cap(): ...\n",
                      'lambda/stream/src/x.ts': STREAM.split('\n')[1]})
    assert list(unrouted(stream_requests(root), python_routes(root))) == []


def test_a_mounted_router_that_does_not_exist_is_an_error(make_tree: TreeMaker) -> None:
    root = make_tree({'lambda/api/things_handler.py': ROUTER_HANDLER})
    with pytest.raises(AuditError, match='mounted router'):
        python_routes(root)
