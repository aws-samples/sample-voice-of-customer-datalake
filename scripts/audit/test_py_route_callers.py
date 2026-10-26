"""py_route_callers finds planted uncalled routes and stays quiet on every real caller shape."""
from __future__ import annotations

import pytest
from audit_common import CDK_DIR, AuditError
from py_route_callers import callers_in, findings, main, routes_in

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
