"""Steering's way to the agents (7.51.00): relayed to a role, it lands in the role's inbox and wakes its live agents;
the coordinator's tools relay it and set the run's direction, and refuse anyone but an agent or a role of the run."""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest

from engineering.runtime.harness.coordinator import steered
from engineering.runtime.harness.skills import Skill
from engineering.runtime.harness.tools import ToolBox
from engineering.runtime.test.conftest import World
from engineering.runtime.test.harness_fakes import world as harness_world
from engineering.runtime.test.test_engineering_delivery import SLEEP, _deliver, _for, _inbox, _until
from engineering.skills.templates import bundled


def test_steering_relayed_to_a_role_is_recorded_for_it_and_wakes_its_live_agents(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, 'working')
    world.launch(agent_id='hunter-2', role='hunter', task_id='task-2', code=SLEEP)
    _until(world, 1010, 'working', agent_id='hunter-2')
    relay = _for({'kind': 'role', 'id': 'fixer'}, type='msg.steer', refs={'s3': []},
                 **{'from': {'kind': 'conductor', 'id': 'coordinator-1'}})
    answer = _deliver(world, relay, 1100)
    assert set(answer['woken']) == {'fixer-1'}   # (the fixers, never the hunter)
    assert [str(row['sk']).split('#')[1] for row in _inbox(world)] == ['role:fixer']


@dataclass
class Planner:
    relayed: list[tuple[str, str, str]] = field(default_factory=list)
    directions: list[str] = field(default_factory=list)

    def steer(self, *, run_id: str, to_kind: str, to_id: str, text: str) -> str:
        del run_id
        self.relayed.append((to_kind, to_id, text))
        return 'E-RELAY'

    def set_direction(self, *, run_id: str, text: str) -> int:
        del run_id
        self.directions.append(text)
        return len(self.directions)


def _coordinator(tmp_path) -> tuple[ToolBox, Planner]:
    w = harness_world(tmp_path, role='coordinator')
    planner = Planner()
    w.session.context.planner = planner   # type: ignore[assignment]
    template = bundled().skill('coordinator')
    assert template is not None
    assert isinstance(template.skill, Skill)
    return ToolBox(w.session.context, template.skill), planner


def test_the_coordinators_card_offers_relay_steering_and_set_direction(tmp_path):
    tools, _ = _coordinator(tmp_path)
    assert {'relay_steering', 'set_direction'} <= {spec.name for spec in tools.specs}


def test_relay_steering_names_an_agent_or_a_role_and_set_direction_a_new_version(tmp_path):
    tools, planner = _coordinator(tmp_path)
    relayed = tools.call('relay_steering', {'to': 'fixer-2', 'text': 'Keep the public signature.'})
    assert (relayed.error, json.loads(relayed.text)['to']) == (False, {'kind': 'agent', 'id': 'fixer-2'})
    assert not tools.call('relay_steering', {'to': 'commit-reviewer', 'text': 'Look at the tests.'}).error
    assert planner.relayed == [('agent', 'fixer-2', 'Keep the public signature.'),
                               ('role', 'commit-reviewer', 'Look at the tests.')]
    assert json.loads(tools.call('set_direction', {'text': 'Fix only the parser.'}).text) == {'direction': 1}


@pytest.mark.parametrize('to', ['coordinator-1', 'coordinator', 'coach', 'human:user-1', 'run', 'fixer', ''])
def test_relay_steering_never_names_the_orchestrator_a_person_or_the_run(to: str):
    if to == 'fixer':
        assert steered(to) == ('role', 'fixer')
        return
    with pytest.raises(ValueError, match='an agent of the run'):
        steered(to)


def test_a_relay_over_a_bus_summary_is_refused_before_the_board(tmp_path):
    tools, planner = _coordinator(tmp_path)
    assert tools.call('relay_steering', {'to': 'fixer-2', 'text': 'é' * 600}).error
    assert planner.relayed == []
