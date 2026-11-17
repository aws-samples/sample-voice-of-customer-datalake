"""The default engineering flows (docs/autonomous-engineering.md "Default flows"): six ``voc-workflow/2`` templates.

They are compiled from voc-datalake/templates/orchestration/flows/ into the orchestration bundle (7.50.00), whose
copy every Lambda that stages lambda/ ships beside this module (``orchestration_bundle.json``; the web app imports the
same bundle, ``frontend/src/api/engineeringTemplates.ts``): the agents API lists them (``GET /workflows/templates``,
the same shape as before) and the workflow library offers them ("Start from a template"). A template is never
stored: "create from template" is the library's own ``POST /workflows`` with the template's definition (a copy the
person edited, or not), so it gets the same validation, the same 409 where the engineering module is off, and, from
the assistant, the same approval card. ``shared/test/test_engineering_templates.py`` validates every one with the
server's rules, and ``npm run orchestration:validate`` holds the copy to a fresh compile.

``bundle()`` is the whole bundle, for the other readers beside this one (``shared/agent_seed.py``: the seeded agents).
"""
from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from functools import cache
from pathlib import Path
from typing import Any, Final

BUNDLE_FILE: Final = Path(__file__).with_name('orchestration_bundle.json')
BUNDLE_SCHEMA: Final = 'voc-orchestration-bundle/1'
#: What a listed template holds (GET /workflows/templates answers these fields, as it always has).
TEMPLATE_FIELDS: Final = ('template_id', 'name', 'description', 'definition')


@cache
def bundle() -> Mapping[str, Any]:
    """The orchestration bundle beside this module (read once per container)."""
    document = json.loads(BUNDLE_FILE.read_text(encoding='utf-8'))
    if not isinstance(document, Mapping) or document.get('schema') != BUNDLE_SCHEMA:
        raise ValueError(f'{BUNDLE_FILE.name} is not {BUNDLE_SCHEMA}')
    return document


def list_templates() -> list[dict[str, Any]]:
    """Every template (``template_id``, ``name``, ``description``, ``definition``), in the bundle's order; a copy."""
    return [{field: copy.deepcopy(flow[field]) for field in TEMPLATE_FIELDS} for flow in bundle()['flows']]
