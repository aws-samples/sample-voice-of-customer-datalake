"""Test support: a run's copy of a default flow, written as the run's start writes it (``flow/record.py``)."""
from __future__ import annotations

from typing import Any

from boto3.dynamodb.types import TypeSerializer

from engineering.flow.record import flow_item
from engineering.rows import run_pk
from shared.engineering_templates import list_templates
from shared.workflow_schema import encode_definition

TEMPLATES = {template['template_id']: template['definition'] for template in list_templates()}


def put_flow(client: Any, table: str, run_id: str, template: str = 'bug-hunt-and-fix', *, revision: int = 3,
             definition: str | None = None) -> None:
    """The run's ``FLOW`` row with a template's definition (or ``definition``, as stored text), on a low-level
    client."""
    text = encode_definition(TEMPLATES[template]) if definition is None else definition
    item = flow_item(run_pk('default', run_id), workflow_id='wf_flow', revision=revision, definition=text,
                     at='2026-11-14T09:00:00Z')
    serializer = TypeSerializer()
    client.put_item(TableName=table, Item={name: serializer.serialize(value) for name, value in item.items()})
