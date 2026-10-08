"""shared.snapstart: priming before the snapshot, reseeding after restore.

`snapshot_restore_py` only exists inside the Python managed runtimes, so a fake
module stands in for it, recording what is registered.
"""

from __future__ import annotations

import random
import sys
import types

import pytest

from shared import snapstart
from shared.test.fresh_interpreter import run_json


class FakeHooks(types.ModuleType):
    def __init__(self) -> None:
        super().__init__(snapstart.SNAPSHOT_RESTORE_MODULE)
        self.before: list[tuple] = []
        self.after: list[tuple] = []

    def register_before_snapshot(self, func, *args, **kwargs):
        self.before.append((func, args, kwargs))

    def register_after_restore(self, func, *args, **kwargs):
        self.after.append((func, args, kwargs))

    def run_before(self) -> None:
        for func, args, kwargs in reversed(self.before):  # the library's order
            func(*args, **kwargs)

    def run_after(self) -> None:
        for func, args, kwargs in self.after:
            func(*args, **kwargs)


@pytest.fixture
def hooks(monkeypatch) -> FakeHooks:
    fake = FakeHooks()
    monkeypatch.setitem(sys.modules, snapstart.SNAPSHOT_RESTORE_MODULE, fake)
    return fake


class TestRegistration:
    def test_is_a_noop_outside_a_managed_runtime(self, monkeypatch):
        monkeypatch.setitem(sys.modules, snapstart.SNAPSHOT_RESTORE_MODULE, None)  # import -> ImportError
        assert snapstart.register_snapshot_hooks(lambda: None) is False

    def test_registers_priming_and_the_reseed(self, hooks):
        calls = []
        assert snapstart.register_snapshot_hooks(lambda: calls.append('a'), lambda: calls.append('b')) is True
        assert len(hooks.before) == 1
        assert len(hooks.after) == 1
        assert calls == [], 'warmers run in the hook, not at registration'
        hooks.run_before()
        assert calls == ['a', 'b']


class TestPriming:
    def test_a_failing_warmer_is_logged_and_the_rest_still_run(self, hooks, caplog):
        calls = []

        def broken():
            raise RuntimeError('no table')

        snapstart.register_snapshot_hooks(broken, lambda: calls.append('after'))
        hooks.run_before()  # must not raise: a raise would fail the version publish
        assert calls == ['after']
        assert [r.getMessage() for r in caplog.records if r.levelname == 'ERROR'] == [
            'SnapStart priming step failed; it will run on first use instead',
        ]


class TestRouteAndModelWarmers:
    def test_api_route_warmer_builds_every_route_request_model(self):
        class Route:
            def __init__(self):
                self.built = 0

            @property
            def dependant(self):
                self.built += 1
                return object()

        app = types.SimpleNamespace(_static_routes=[Route()], _dynamic_routes=[Route(), Route()])
        snapstart.api_route_warmer(app)()
        assert [r.built for r in [*app._static_routes, *app._dynamic_routes]] == [1, 1, 1]

    def test_api_route_warmer_tolerates_a_resolver_without_the_private_lists(self):
        warm = snapstart.api_route_warmer(types.SimpleNamespace())
        assert warm() is None  # no raise: nothing to prime

    def test_botocore_model_warmer_fills_the_loader_cache_without_a_client(self):
        found = run_json("""
            import json, boto3, botocore.session
            created = []
            original = botocore.session.Session.create_client
            botocore.session.Session.create_client = lambda *a, **k: created.append(a) or original(*a, **k)
            from shared import snapstart
            loader = boto3._get_default_session()._loader
            calls = []
            load = loader.load_service_model
            loader.load_service_model = lambda svc, kind, *a: calls.append((svc, kind)) or load(svc, kind, *a)
            snapstart.botocore_model_warmer('dynamodb', 'lambda')()
            print(json.dumps({'calls': calls, 'clients': len(created)}))
        """)
        assert found == {
            'calls': [[svc, kind] for svc in ('dynamodb', 'lambda') for kind in snapstart.BOTOCORE_MODEL_FILES],
            'clients': 0,
        }


@pytest.fixture
def isolated_random():
    """These cases drive the global `random` state; hand it back untouched."""
    state = random.getstate()
    yield
    random.setstate(state)


@pytest.mark.usefixtures('isolated_random')
class TestReseedAfterRestore:
    def test_two_restores_of_one_snapshot_draw_different_numbers(self, hooks):
        """Every restore starts from the same `random` state; the hook must diverge them."""
        snapstart.register_snapshot_hooks()
        random.seed(1234)  # "the snapshot"
        snapshot_state = random.getstate()

        draws = []
        for _ in range(2):
            random.setstate(snapshot_state)  # a restore
            hooks.run_after()
            draws.append([random.random() for _ in range(4)])
        assert draws[0] != draws[1]


# The four SnapStart API handlers (lib/utils/snapstart.ts SNAPSTART_FUNCTION_IDS) and
# the warmers each must register — what GET of its slow route touches lazily.
HANDLER_WARMERS = {
    'integrations_handler': ['_plugin_secret_defaults', 'prime_botocore_models', 'prime_api_routes'],
    'feedback_form_handler': ['prime_api_routes'],
    'memory_handler': ['get_memory_table', 'get_aggregates_table', 'prime_api_routes'],
    'mcp_tokens_handler': ['get_projects_table', 'get_jobs_table', 'prime_api_routes'],
}


# Handlers whose priming must not even resolve credentials (3.00.00 capacity rule for the
# warmers added then). memory / mcp-tokens predate it: their warmers build their tables,
# which creates the DynamoDB client in the hook (open item, docs/lambda-sizing.md).
CREDENTIAL_FREE_PRIMING = {'integrations_handler', 'feedback_form_handler'}


@pytest.mark.parametrize(('module_name', 'warmers'), sorted(HANDLER_WARMERS.items()))
def test_each_snapstart_handler_registers_its_hooks_at_import(module_name, warmers):
    """In a fresh interpreter with a fake runtime module: importing the handler
    registers exactly one priming hook (with these warmers) and the reseed, and
    running the priming hook makes no AWS call (no credentials, no endpoint)."""
    found = run_json(f"""
        import json, sys, types
        before, after = [], []
        fake = types.ModuleType('snapshot_restore_py')
        fake.register_before_snapshot = lambda f, *a, **k: before.append((f, a, k))
        fake.register_after_restore = lambda f, *a, **k: after.append((f, a, k))
        sys.modules['snapshot_restore_py'] = fake

        import botocore.credentials
        import botocore.endpoint
        def no_network(*args, **kwargs):
            raise AssertionError('priming made an AWS call')
        def no_credentials(*args, **kwargs):
            raise AssertionError('priming resolved credentials (a snapshot must not hold them)')
        botocore.endpoint.Endpoint.make_request = no_network

        import {module_name}
        # Armed AFTER import: building the import-time clients resolves credentials,
        # the existing design. The PRIMING hook must not (nothing it adds may hold them).
        if {module_name!r} in {sorted(CREDENTIAL_FREE_PRIMING)!r}:
            botocore.credentials.CredentialResolver.load_credentials = no_credentials
        from shared import snapstart as hooks_module
        routes = [*{module_name}.app._static_routes, *{module_name}.app._dynamic_routes]
        unbuilt_before = sum(r._dependant is None for r in routes)
        failures = []
        hooks_module.logger.exception = lambda msg, *a, **k: failures.append(k.get('extra', {{}}).get('warmer'))
        for f, a, k in before:
            f(*a, **k)
        print(json.dumps({{
            'before': len(before),
            'after': [f.__name__ for f, _, _ in after],
            'warmers': [w.__name__ for f, a, _ in before for w in a[0]],
            'failed': failures,
            'routes': len(routes),
            'unbuilt_before': unbuilt_before,
            'unbuilt_after': sum(r._dependant is None for r in routes),
        }}))
    """, MEMORY_TABLE='voc-memory', AGGREGATES_TABLE='voc-aggregates', PROJECTS_TABLE='voc-projects',
        JOBS_TABLE='voc-jobs', FEEDBACK_TABLE='voc-feedback')
    routes = found.pop('routes')
    assert found.pop('unbuilt_before') == routes > 0, 'request models are built lazily until primed'
    assert found == {
        'before': 1, 'after': ['reseed_after_restore'], 'warmers': warmers,
        # Every warmer ran without an AWS call or a credential lookup (either would be logged here)...
        'failed': [],
        # ...and every route's request model is in the snapshot (3.00.00 capacity).
        'unbuilt_after': 0,
    }
