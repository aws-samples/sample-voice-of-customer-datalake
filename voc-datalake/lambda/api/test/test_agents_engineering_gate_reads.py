"""The quality gates' reads beside the run workspace (7.52.00's integration): ``GET /agents/engineering/gates`` answers
the briefs without their text, ``GET …/gates/briefs/<id>`` one brief with it, and ``?connection=<id>`` each pack's
tools' versions as that connection's newest gate record holds them, and when (engineering/registry/gate_records.py),
on the run workspace's world (engineering/test/run_workspace_world.py: a run of ``conn-storefront`` whose gate runner
recorded ``python``'s version)."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import call as _call
from engineering_run_workspace_fixture import workspace_api

from engineering.test import run_workspace_world as world
from shared import engineering_templates

GATES = '/agents/engineering/gates'
NOW = datetime(2026, 11, 17, 10, 0, tzinfo=UTC)


class _Now(datetime):
    @classmethod
    def now(cls, tz: Any = None) -> datetime:
        return NOW if tz is None else NOW.astimezone(tz)


@pytest.fixture(autouse=True)
def api() -> Any:
    with workspace_api() as reached, patch('shared.agents_engineering_registry_routes.datetime', _Now):
        yield reached


def test_the_gates_carry_each_brief_without_its_text_and_the_brief_route_gives_it(lambda_context: Any) -> None:
    status, body = _call(lambda_context, 'GET', GATES)
    assert status == 200, body
    bundled = {brief['id']: brief for brief in engineering_templates.bundle()['gates']['briefs']}
    assert [sorted(brief) for brief in body['briefs']] == [['bytes', 'digest', 'id', 'packs', 'path']] * len(bundled)
    # (no connection named: no recorded versions, never one made up)
    assert ({pack['recorded'] for pack in body['packs']}, body['connection']) == ({None}, None)
    status, brief = _call(lambda_context, 'GET', f'{GATES}/briefs/python-ts')
    assert status == 200, brief
    assert brief == {name: bundled['python-ts'][name] for name in ('id', 'path', 'packs', 'digest', 'bytes', 'text')}
    assert _call(lambda_context, 'GET', f'{GATES}/briefs/nope')[0] == 404


def test_a_connections_packs_carry_the_versions_its_newest_gate_record_holds(lambda_context: Any) -> None:
    status, body = _call(lambda_context, 'GET', GATES, query={'connection': 'conn-storefront'})
    assert status == 200, body
    recorded = {pack['id']: pack['recorded'] for pack in body['packs']}
    assert recorded['python'] == {'tool_versions': {'python': 'Python 3.14.0'}, 'run_id': world.RUN,
                                  'at': world.at(24)}
    assert (recorded['java'], recorded['typescript'], body['connection']) == (None, None, 'conn-storefront')
    # (another connection's runs are not this one's: nothing recorded for it)
    other = _call(lambda_context, 'GET', GATES, query={'connection': 'conn-elsewhere'})[1]
    assert {pack['recorded'] for pack in other['packs']} == {None}
    assert _call(lambda_context, 'GET', GATES, query={'connection': 'Not An Id'})[0] == 400


def test_the_brief_is_403_for_anyone_but_an_administrator(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', f'{GATES}/briefs/java', claims=USER)[0] == 403


@pytest.mark.parametrize(('kind', 'ident', 'path'), [
    ('skill', 'understander', 'agents/understander/SKILL.md'), ('card', 'fixer', 'agents/fixer/agent.yaml'),
    ('flow', 'tenets', 'flows/tenets.yaml'), ('brief', 'java', 'gates/briefs/java.md')])
def test_a_templates_source_is_its_text_as_the_repository_holds_it(lambda_context: Any, kind: str, ident: str,
                                                                    path: str) -> None:
    # (7.52.00's integration: the app's read-only source view, from the bundle)
    import hashlib
    from pathlib import Path

    status, source = _call(lambda_context, 'GET', f'/agents/engineering/templates/{kind}/{ident}/source')
    assert status == 200, source
    root = Path(engineering_templates.__file__).resolve().parents[2] / 'templates' / 'orchestration'
    raw = (root / path).read_bytes()
    assert (source['kind'], source['id'], source['path'], source['text']) == (kind, ident, path, raw.decode())
    assert source['digest'] == f'sha256:{hashlib.sha256(raw).hexdigest()}'
    assert (source['template_version'] is None) == (kind == 'brief')


def test_a_template_of_no_kind_or_none_of_that_id_is_refused(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', '/agents/engineering/templates/skill/nobody/source')[0] == 404
    assert _call(lambda_context, 'GET', '/agents/engineering/templates/script/fixer/source')[0] == 400
    assert _call(lambda_context, 'GET', '/agents/engineering/templates/flow/tenets/source', claims=USER)[0] == 403
