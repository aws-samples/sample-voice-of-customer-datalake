"""Lockstep: the frontend's copy of the built-in workflow is the server's.

``frontend/src/test/builtinWorkflow.json`` feeds the editor test that rebuilds
the built-in "Reviews → Prototype" workflow through the editor's own actions
(``frontend/src/components/WorkflowEditor/rebuildBuiltin.test.ts``). That test
only proves something while the copy equals
:func:`shared.workflow_schema.default_template`, so this fails the moment either
side changes alone: update the JSON by hand to match the template (numbers
compare by value, so ``280`` equals ``280.0``).
"""
import json
from pathlib import Path

from shared import workflow_schema

FIXTURE = Path(__file__).resolve().parents[3] / 'frontend' / 'src' / 'test' / 'builtinWorkflow.json'


def test_the_frontend_fixture_is_the_builtin_template():
    assert json.loads(FIXTURE.read_text(encoding='utf-8')) == workflow_schema.default_template()


def test_the_builtin_template_is_valid():
    result = workflow_schema.validate_definition(workflow_schema.default_template())
    assert result.valid, result.to_dict()
