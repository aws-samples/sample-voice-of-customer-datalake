"""The editor's lists of engineering roles and gate packs (shared.workflow_engineering) are the platform's own."""
from __future__ import annotations

from typing import Any

import pytest

from engineering.board.api import POSTERS
from engineering.bus.schema import ROLES
from engineering.connectors.identity import AGENT_ROLES
from engineering.quality_gate.gate import (
    DEFAULT_REVIEWERS,
    MAX_ROUNDS,
    PARAMS,
    REVIEWER_KEYS,
    GateConfig,
    GateConfigError,
)
from engineering.quality_gate.packs import default_packs_dir, load_packs
from shared import workflow_engineering


def test_the_roles_are_the_agent_catalogs() -> None:
    assert set(workflow_engineering.ENGINEERING_ROLES) == AGENT_ROLES


def test_a_boards_roles_are_the_ones_its_api_and_queues_serve() -> None:
    assert set(POSTERS) == set(workflow_engineering.BOARD_POSTERS)
    # Every task role claims a board's tasks but the gate runner, which claims only its quality gate step's.
    assert set(workflow_engineering.BOARD_CLAIMERS) == ROLES - {'gate-runner'}
    assert 'gate-runner' in ROLES


def test_the_packs_are_the_gate_packs_on_disk() -> None:
    on_disk = tuple(sorted(pack.id for pack in load_packs(default_packs_dir())))
    assert on_disk == workflow_engineering.GATE_PACKS


def test_the_rounds_are_the_gates() -> None:
    assert workflow_engineering.MAX_GATE_ROUNDS == MAX_ROUNDS


def test_the_gate_settings_are_the_gates_own() -> None:
    assert PARAMS - {'node_id', 'node_title'} == workflow_engineering.GATE_SETTINGS
    assert REVIEWER_KEYS == workflow_engineering.REVIEWER_SETTINGS
    assert {reviewer.name: reviewer.advisory for reviewer in DEFAULT_REVIEWERS} == workflow_engineering.DEFAULT_REVIEWERS


@pytest.mark.parametrize('params', [
    {}, {'max_rounds': 2, 'packs': ['python-ts'], 'final_go_model': 'm'}, {'reviewers': [{'name': 'quality'}]},
    {'reviewers': [{'name': 'docs', 'focus': 'Are the docs true?', 'advisory': True}]},
    {'reviewers': [{'name': 'quality'}, {'name': 'docs', 'focus': 'Are the docs true?', 'advisory': True}]},
    {'reviewers': [{'name': 'quality'}, {'name': 'quality'}]},
    {'reviewers': [{'name': 'first-principles'}]}, {'reviewers': [{'name': 'first-principles', 'advisory': False}]},
    {'reviewers': [{'name': 'security', 'advisory': True}, {'name': 'first-principles'}]},
    {'reviewers': [{'name': 'docs'}]}, {'reviewers': [{'name': 'Docs', 'focus': 'f'}]},
    {'reviewers': [{'name': 'quality', 'colour': 'red'}]}, {'reviewers': [{'name': 'quality', 'advisory': 'yes'}]},
    {'reviewers': []}, {'colour': 'red'}, {'final_go_model': None}, {'max_rounds': None},
    {'packs': [{}]}, {'packs': ['python-ts', 7]}, {'packs': [['python-ts']]}, {'reviewers': [{'name': ['x']}]},
])
def test_a_gate_step_the_editor_accepts_is_one_the_gate_runs(params: dict[str, Any]) -> None:
    accepted = not workflow_engineering.params_issues('quality_gate', params)
    try:
        GateConfig.from_params(params)
        runs = True
    except GateConfigError:
        runs = False
    assert accepted == runs


@pytest.mark.parametrize('params', [
    {'packs': None},                                        # the gate reads null as auto; the editor asks for 'auto'
    {'packs': ['go']},                                      # the gate refuses an unknown pack later, when it plans
    {'reviewers': [{'name': 'docs', 'focus': '   '}]},      # the gate takes a blank focus; the editor does not
])
def test_where_the_two_differ_the_editor_is_the_stricter(params: dict[str, Any]) -> None:
    """Nothing the editor saves fails when it runs: these the editor refuses and the gate's settings would take."""
    assert workflow_engineering.params_issues('quality_gate', params)
    GateConfig.from_params(params)
