"""`shared.invocation_cost` — the one CPU signal the sizing policy has (docs/lambda-sizing.md).

Two halves:
- the line itself (fields, written even when the handler raises, no payload in it),
  and the shared entry points that carry it (`batch_lambda_handler`);
- COVERAGE: every Python `lambda_handler` under lambda/ and plugins/ is measured.
  Before this guard only `@api_handler` handlers logged the line, so 24 worker and
  job Lambdas had no CPU figure and the CPU rule could not be applied to them.
"""

import ast
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType

from shared.batch import batch_lambda_handler
from shared.invocation_cost import (
    COST_LINE,
    MEASURED_ATTR,
    invocation_cost_fields,
    measure_invocation_cost,
    memory_mb,
)

VOC_DATALAKE = Path(__file__).resolve().parents[3]


def _context(memory: Any = '1024') -> MagicMock:
    context = MagicMock()
    context.memory_limit_in_mb = memory
    context.function_name = 'voc-test'
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-test'
    context.aws_request_id = 'req-1'
    return context


def _cost_lines(mock_logger: MagicMock) -> list[dict]:
    return [c.kwargs['extra'] for c in mock_logger.info.call_args_list if c.args == (COST_LINE,)]


class TestFields:
    def test_share_of_the_allocation_is_cpu_over_wall_times_vcpu(self):
        fields = invocation_cost_fields(1769, cpu_ms=50.0, wall_ms=100.0)
        assert fields == {'cpu_ms': 50.0, 'wall_ms': 100.0, 'function_memory_size': 1769,
                          'cpu_pct_of_allocation': 50.0}

    def test_unknown_memory_omits_the_share_and_the_size(self):
        assert invocation_cost_fields(None, 5.0, 10.0) == {'cpu_ms': 5.0, 'wall_ms': 10.0}

    def test_zero_wall_time_omits_the_share_rather_than_dividing_by_zero(self):
        assert 'cpu_pct_of_allocation' not in invocation_cost_fields(512, 0.0, 0.0)

    @pytest.mark.parametrize(('raw', 'expected'), [
        ('1024', 1024), (512, 512), ('', None), (None, None), ('0', None), ('abc', None), ('-1', None),
    ])
    def test_memory_comes_from_the_context_string(self, raw, expected):
        assert memory_mb(_context(raw)) == expected


class TestDecorator:
    @patch('shared.invocation_cost.logger')
    def test_one_line_per_invocation_with_numbers_only(self, mock_logger):
        @measure_invocation_cost
        def handler(_event, _context):
            sum(i * i for i in range(100_000))
            return {'ok': True}

        assert handler({'secret': 'payload text'}, _context('256')) == {'ok': True}

        [fields] = _cost_lines(mock_logger)
        assert set(fields) == {'cpu_ms', 'wall_ms', 'function_memory_size', 'cpu_pct_of_allocation'}
        assert all(isinstance(v, int | float) for v in fields.values())
        assert fields['cpu_ms'] > 0
        assert 'payload text' not in repr(mock_logger.info.call_args_list)

    @patch('shared.invocation_cost.logger')
    def test_still_logs_when_the_handler_raises(self, mock_logger):
        @measure_invocation_cost
        def handler(_event, _context):
            raise RuntimeError('boom')

        with pytest.raises(RuntimeError, match='boom'):
            handler({}, _context())
        assert len(_cost_lines(mock_logger)) == 1

    def test_marks_and_keeps_the_handler_identity(self):
        def lambda_handler(_event, _context):
            """Doc."""

        wrapped = measure_invocation_cost(lambda_handler)
        assert getattr(wrapped, MEASURED_ATTR) is True
        assert wrapped.__name__ == 'lambda_handler'
        assert wrapped.__doc__ == 'Doc.'


class TestInstrumentedHandler:
    """The full entry-point stack the worker and job handlers share."""

    def test_wraps_logger_tracer_metrics_then_the_cost_line_innermost(self):
        from shared import invocation_cost

        def lambda_handler(_event, _context):
            return 'ok'

        with (
            patch.object(invocation_cost, 'logger') as logger,
            patch.object(invocation_cost, 'tracer') as tracer,
            patch.object(invocation_cost, 'metrics') as metrics,
        ):
            order: list[str] = []
            logger.inject_lambda_context.side_effect = lambda f: order.append('logger') or f
            tracer.capture_lambda_handler.side_effect = lambda f: order.append('tracer') or f
            metrics.log_metrics.return_value = lambda f: order.append('metrics') or f
            wrapped = invocation_cost.instrumented_handler(lambda_handler)

        metrics.log_metrics.assert_called_once_with(capture_cold_start_metric=True)
        assert order == ['metrics', 'tracer', 'logger']  # applied inside-out: logger is outermost
        assert getattr(wrapped, MEASURED_ATTR) is True
        assert wrapped({}, _context()) == 'ok'

    @patch('shared.invocation_cost.logger')
    def test_a_real_stack_logs_one_cost_line(self, mock_logger):
        from shared import invocation_cost

        mock_logger.inject_lambda_context = lambda f: f
        handler = invocation_cost.instrumented_handler(lambda _event, _context: {'done': True})

        assert handler({}, _context('512')) == {'done': True}
        [fields] = _cost_lines(mock_logger)
        assert fields['function_memory_size'] == 512


class TestBatchEntryPoint:
    @patch('shared.invocation_cost.logger')
    def test_a_batch_logs_one_line_for_the_whole_batch(self, mock_logger):
        def record_handler(record: Any) -> None:
            del record

        handler = batch_lambda_handler(record_handler, BatchProcessor(event_type=EventType.SQS))
        event = {'Records': [
            {'messageId': f'm{i}', 'body': 'b', 'receiptHandle': 'r', 'attributes': {},
             'messageAttributes': {}, 'md5OfBody': '', 'eventSource': 'aws:sqs',
             'eventSourceARN': 'arn:aws:sqs:us-east-1:123456789012:q', 'awsRegion': 'us-east-1'}
            for i in range(3)
        ]}

        assert handler(event, _context()) == {'batchItemFailures': []}
        assert len(_cost_lines(mock_logger)) == 1


# ── coverage: every Python Lambda entry point is measured ─────────────────────

#: Decorators that write the line (api_handler and instrumented_handler apply measure_invocation_cost).
MEASURING_DECORATORS = {'api_handler', 'instrumented_handler', 'measure_invocation_cost'}
#: Factories whose handler writes the line (batch: above; step: agents/test/test_runtime_units.py).
MEASURING_FACTORIES = {'batch_lambda_handler', 'step_lambda_handler'}
#: Cannot import shared/ (stdlib only) and calls its pinned mirror in a `finally`
#: (product_doc_extractor/test/test_invocation_cost_lockstep.py).
STDLIB_MIRRORS = {'lambda/product_doc_extractor/handler.py': '_log_invocation_cost'}
#: Not traffic: a CloudFormation custom resource that runs only during a deploy.
EXEMPT = {'lambda/api/verification_fixture_provider.py'}


def _is_handler_assign(node: ast.AST) -> bool:
    return isinstance(node, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id == 'lambda_handler' for t in node.targets)


def _entry_point(path: Path) -> ast.AST | None:
    """The module-level `lambda_handler` def or assignment, if the module has one."""
    for node in ast.parse(path.read_text(encoding='utf-8')).body:
        if (isinstance(node, ast.FunctionDef) and node.name == 'lambda_handler') or _is_handler_assign(node):
            return node
    return None


def _handler_files() -> dict[str, ast.AST]:
    """repo-relative path -> its `lambda_handler` node, for every non-test module defining one."""
    found = {}
    for root in ('lambda', 'plugins'):
        for path in (VOC_DATALAKE / root).rglob('*.py'):
            rel = path.relative_to(VOC_DATALAKE).as_posix()
            if '/test' in rel or '/layers/' in rel or path.name.startswith(('test_', 'conftest')):
                continue
            node = _entry_point(path)
            if node is not None:
                found[rel] = node
    return dict(sorted(found.items()))


def _name(node: ast.AST) -> str:
    target = node.func if isinstance(node, ast.Call) else node
    if isinstance(target, ast.Attribute):
        return target.attr
    return target.id if isinstance(target, ast.Name) else ''


def _how_measured(rel: str, node: ast.AST) -> str | None:
    """'decorator' / 'factory' / 'mirror' when the entry point is measured, else None."""
    if isinstance(node, ast.FunctionDef):
        # Innermost: the line must be written inside the Powertools context.
        if node.decorator_list and _name(node.decorator_list[-1]) in MEASURING_DECORATORS:
            return 'decorator'
        mirror = STDLIB_MIRRORS.get(rel)
        if mirror and any(isinstance(n, ast.Call) and _name(n) == mirror for n in ast.walk(node)):
            return 'mirror'
        return None
    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and _name(node.value) in MEASURING_FACTORIES:
        return 'factory'
    return None


ENTRY_POINTS = _handler_files()


def test_the_scan_finds_the_entry_points():
    """Positive control: an empty scan would make the coverage test pass vacuously."""
    assert {'lambda/processor/handler.py', 'lambda/api/metrics_handler.py',
            'plugins/webscraper/ingestor/handler.py', 'lambda/product_doc_extractor/handler.py'} <= set(ENTRY_POINTS)
    assert len(ENTRY_POINTS) >= 40


@pytest.mark.parametrize('rel', list(ENTRY_POINTS))
def test_every_python_lambda_logs_invocation_cost(rel: str):
    if rel in EXEMPT:
        pytest.skip('deploy-time custom resource')
    assert _how_measured(rel, ENTRY_POINTS[rel]), (
        f'{rel}: put @measure_invocation_cost directly above `def lambda_handler` '
        '(shared/invocation_cost.py) so the CPU rule can be applied to this function')


def test_exemptions_still_exist():
    for rel in (*EXEMPT, *STDLIB_MIRRORS):
        assert (VOC_DATALAKE / rel).is_file(), rel
