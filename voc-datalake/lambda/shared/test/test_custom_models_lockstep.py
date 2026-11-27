"""The deployment's own models are read in three places (7.65.00); drift would offer a model one side refuses.

lib/utils/custom-models.ts checks the registry at synth and writes ``CUSTOM_MODELS``; shared/custom_models.py and the
stream Lambda's bedrock/custom-models.ts read it. These tests read the two TypeScript files and pin their constants
to this module's, and the CDK spec (lib/utils/custom-models.test.ts) pins the value it writes to the fixture the
Python and stream suites read (lib/test-support/custom-models-env.json). Positive controls first: each constant must
parse out of its source (shared/test/repo_paths.py, "Conventions").
"""
from __future__ import annotations

import re

import pytest

from shared import custom_models
from shared.model_config import PICKER_SURFACES, PRODUCT_EXTRACT_SURFACE, WEB_SEARCH_SURFACE
from shared.test.repo_paths import repo_root

CDK = (repo_root() / 'lib' / 'utils' / 'custom-models.ts').read_text(encoding='utf-8')
STREAM = (repo_root() / 'lambda' / 'stream' / 'src' / 'bedrock' / 'custom-models.ts').read_text(encoding='utf-8')


def _number(source: str, name: str) -> int:
    found = re.search(rf'(?:export )?const {name} = ([\d_]+);', source)
    assert found, f'{name} not found'
    return int(found.group(1).replace('_', ''))


def _string(source: str, name: str) -> str:
    found = re.search(rf"(?:export )?const {name} = '([^']+)';", source)
    assert found, f'{name} not found'
    return found.group(1)


def _strings(source: str, name: str) -> tuple[str, ...]:
    found = re.search(rf'(?:export )?const {name}[^=]*= \[(.*?)\]', source, re.DOTALL)
    assert found, f'{name} not found'
    return tuple(re.findall(r"'([a-z_]+)'", found.group(1)))


@pytest.mark.parametrize('source', [CDK, STREAM], ids=['cdk', 'stream'])
@pytest.mark.parametrize(('name', 'value'), [
    ('MAX_CUSTOM_MODELS', custom_models.MAX_CUSTOM_MODELS),
    ('DEFAULT_CONTEXT_WINDOW', custom_models.DEFAULT_CONTEXT_WINDOW),
    ('DEFAULT_MAX_OUTPUT_TOKENS', custom_models.DEFAULT_MAX_OUTPUT_TOKENS),
])
def test_the_numbers_match(source, name, value):
    """The CDK's and the stream's copies of the registry's numbers are the Python one's."""
    assert _number(source, name) == value


@pytest.mark.parametrize('source', [CDK, STREAM])
def test_the_env_name_matches(source):
    assert _string(source, 'CUSTOM_MODELS_ENV') == custom_models.CUSTOM_MODELS_ENV


@pytest.mark.parametrize('name', ['CUSTOM_MODEL_SURFACES', 'TOOL_SURFACES', 'JSON_SURFACES'])
def test_the_cdk_surface_lists_match(name):
    assert _strings(CDK, name) == getattr(custom_models, name)


def test_every_picker_surface_but_the_web_search_one_and_the_product_extract_is_open_to_a_custom_model():
    """The product extract (7.104.00) asks for adaptive thinking, an effort and a JSON schema: Claude's only."""
    closed = (WEB_SEARCH_SURFACE, PRODUCT_EXTRACT_SURFACE)
    assert tuple(s for s in PICKER_SURFACES if s not in closed) == custom_models.CUSTOM_MODEL_SURFACES


def test_only_the_assistant_and_the_prototype_builder_parse_no_json():
    """A model without ``json`` may serve only these two (its answers elsewhere are parsed as JSON)."""
    assert set(custom_models.CUSTOM_MODEL_SURFACES) - set(custom_models.JSON_SURFACES) == {'chat', 'prototype'}
    assert set(custom_models.TOOL_SURFACES) <= set(custom_models.CUSTOM_MODEL_SURFACES)
