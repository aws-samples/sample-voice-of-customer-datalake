"""The default engineering flows (docs/autonomous-engineering.md "Default flows"): six ``voc-workflow/2`` templates.

They live in ONE file, ``engineering_flow_templates.json`` beside this module, which the web app imports too
(``frontend/src/api/engineeringTemplates.ts``): the agents API lists them (``GET /workflows/templates``) and the
workflow library offers them ("Start from a template"). A template is never stored: "create from template" is the
library's own ``POST /workflows`` with the template's definition (a copy the person edited, or not), so it gets the
same validation, the same 409 where the engineering module is off, and, from the assistant, the same approval card.
``shared/test/test_engineering_templates.py`` validates every one with the server's rules.
"""
from __future__ import annotations

import copy
import json
from functools import cache
from pathlib import Path
from typing import Any, Final

TEMPLATES_FILE: Final = Path(__file__).with_name('engineering_flow_templates.json')
TEMPLATES_SCHEMA: Final = 'voc-workflow-templates/1'


@cache
def _templates() -> tuple[dict[str, Any], ...]:
    document = json.loads(TEMPLATES_FILE.read_text(encoding='utf-8'))
    if document.get('schema') != TEMPLATES_SCHEMA:
        raise ValueError(f'{TEMPLATES_FILE.name} is not {TEMPLATES_SCHEMA}')
    return tuple(document['templates'])


def list_templates() -> list[dict[str, Any]]:
    """Every template (``template_id``, ``name``, ``description``, ``definition``), in the file's order; a copy."""
    return copy.deepcopy(list(_templates()))
