"""py_doc_refs reports comments naming missing code, paths and routes, and not the ones that resolve."""
from __future__ import annotations

from pathlib import Path

from audit_common import CDK_DIR
from py_assembly import Assembly
from py_doc_refs import Known, findings, main, repo_tokens, route_table

from conftest import TreeMaker

HANDLER = '''
"""Feedback API.

Serves ``GET /feedback/{id}`` and ``POST /feedback-forms/{id}/submit``; a fragment like POST /submit too.
"""
from aws_lambda_powertools.event_handler import APIGatewayRestResolver

app = APIGatewayRestResolver()


@app.get('/feedback/<feedback_id>')
def get_feedback(feedback_id):
    # Delegates to `load_item` in shared/items.py (lambda/shared/items.py).
    return load_item(feedback_id)


@app.post('/feedback-forms/<form_id>/submit')
def submit(form_id):
    # Stale: `handle_service_error` maps it; see lambda/shared/gone.py and GET /feedback/{id}/history.
    # History, not a pointer: this used to call `retired_helper()`.
    # A library name resolves: `ReturnConsumedCapacity`.
    return form_id
'''
ITEMS = '''
def load_item(item_id):
    return {'id': item_id}
'''


def test_missing_names_paths_and_routes_are_found(make_tree: TreeMaker, tmp_path: Path) -> None:
    cdk = make_tree({'voc-datalake/lambda/api/feedback_handler.py': HANDLER,
                     'voc-datalake/lambda/shared/items.py': ITEMS}) / 'voc-datalake'
    library = tmp_path / 'site-packages'
    library.mkdir()
    (library / 'botocore_model.json').write_text('{"ReturnConsumedCapacity": {}}', encoding='utf-8')
    known = Known(cdk, cdk.parent, repo_tokens(cdk.parent), route_table(cdk, Assembly({}, {})))
    found, count = findings(known, [library])
    assert sorted((f.kind, f.key) for f in found) == [
        ('missing-name', 'lambda/api/feedback_handler.py::handle_service_error'),
        ('missing-path', 'lambda/api/feedback_handler.py::lambda/shared/gone.py'),
        ('missing-route', 'lambda/api/feedback_handler.py::GET /feedback/{id}/history'),
    ]
    assert count > 0


def test_the_real_tree_is_clean() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
