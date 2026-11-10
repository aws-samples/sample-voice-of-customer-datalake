"""`warm_at_init` builds clients only during a Lambda on-demand/provisioned init, never in tests or under SnapStart.

The handlers whose first request used to build the DynamoDB resource (docs/lambda-sizing.md,
"Cold starts") call it at module level; the AST pin below keeps them doing so.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from shared import warm_init

LAMBDA_ROOT = Path(__file__).resolve().parents[2]

# Handler modules that build their AWS clients during INIT (their first request paid it before).
WARMED_HANDLERS = (
    'agents/heartbeat/handler.py', 'agents/conductor/handler.py', 'briefing/handler.py',
    'memory/scanner/handler.py', 'memory/retention/handler.py', 'jobs/retention/handler.py',
    'jobs/radar_scan/handler.py', 'api/agents_handler.py', 'api/ballots_handler.py',
    'api/projects_handler.py', 'api/radar_handler.py', 'api/logs_handler.py',
    # SnapStart functions: their snapshot is primed by shared.snapstart; this covers `$LATEST` environments.
    'api/memory_handler.py', 'api/mcp_tokens_handler.py', 'api/integrations_handler.py',
    'api/mcp_global_handler.py', 'api/engagement_handler.py',
)


@pytest.mark.parametrize('init_type', ['on-demand', 'provisioned-concurrency'])
def test_runs_every_factory_during_a_lambda_init(monkeypatch, init_type):
    monkeypatch.setenv(warm_init.INIT_TYPE_ENV, init_type)
    calls: list[str] = []

    warmed = warm_init.warm_at_init(lambda: calls.append('a'), lambda: calls.append('b'))

    assert warmed == 2
    assert calls == ['a', 'b']


@pytest.mark.parametrize('init_type', [None, 'snap-start', ''])
def test_builds_nothing_outside_a_lambda_init_or_under_snapstart(monkeypatch, init_type):
    if init_type is None:
        monkeypatch.delenv(warm_init.INIT_TYPE_ENV, raising=False)
    else:
        monkeypatch.setenv(warm_init.INIT_TYPE_ENV, init_type)
    calls: list[str] = []

    warmed = warm_init.warm_at_init(lambda: calls.append('a'))

    assert warmed == 0
    assert calls == []


def test_a_failing_factory_is_logged_and_the_rest_still_run(monkeypatch, caplog):
    monkeypatch.setenv(warm_init.INIT_TYPE_ENV, 'on-demand')
    calls: list[str] = []

    def broken() -> None:
        raise RuntimeError('no region')

    warmed = warm_init.warm_at_init(broken, lambda: calls.append('after'))

    assert warmed == 1
    assert calls == ['after']
    assert 'Init warm-up step failed' in caplog.text


def _module_level_warm_calls(path: Path) -> list[str]:
    tree = ast.parse(path.read_text())
    calls = []
    for node in tree.body:
        if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name) and node.value.func.id == 'warm_at_init'):
            calls.extend(ast.unparse(arg) for arg in node.value.args)
    return calls


@pytest.mark.parametrize('relative', WARMED_HANDLERS)
def test_each_listed_handler_warms_its_clients_at_module_level(relative):
    calls = _module_level_warm_calls(LAMBDA_ROOT / relative)
    assert calls, f'{relative} no longer calls warm_at_init at module level'
