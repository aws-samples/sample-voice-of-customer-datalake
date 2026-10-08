"""Mutation hardening for `shared.invocation_cost`.

The run found what the earlier suite could not see:
- the line's literals: the message (`invocation_cost`) and the marker attribute were only
  imported from the module, never spelled, so renaming either passed;
- the vCPU constant (1,769 MB) and every rounding precision (one decimal) were checked with
  values whose result did not change under a near miss;
- the wall-time guard was only probed at 0, so `> 1` passed;
- `log_invocation_cost` arithmetic (end - start, x 1000) was only checked as `> 0`;
- `memory_mb` on a context with no memory attribute at all.
"""

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from shared import invocation_cost
from shared.invocation_cost import invocation_cost_fields, log_invocation_cost, memory_mb


class TestTheLineIsNamedForTheQuery:
    def test_the_message_and_the_marker_are_the_literals_queries_and_checks_rely_on(self):
        assert invocation_cost.COST_LINE == 'invocation_cost'
        assert invocation_cost.MEASURED_ATTR == '__measures_invocation_cost__'


class TestFieldsAreExact:
    def test_one_vcpu_is_1769_mb(self):
        assert invocation_cost.MB_PER_VCPU == 1769
        assert invocation_cost_fields(1769, 1000.0, 1000.0)['cpu_pct_of_allocation'] == 100.0

    def test_every_figure_is_rounded_to_one_decimal(self):
        assert invocation_cost_fields(1769, 12.3456, 45.6789) == {
            'cpu_ms': 12.3, 'wall_ms': 45.7, 'function_memory_size': 1769, 'cpu_pct_of_allocation': 27.0}

    @pytest.mark.parametrize(('wall_ms', 'pct'), [(1.0, 50.0), (0.5, 100.0)])
    def test_any_positive_wall_time_carries_the_share(self, wall_ms: float, pct: float):
        assert invocation_cost_fields(1769, 0.5, wall_ms)['cpu_pct_of_allocation'] == pct

    def test_a_context_without_a_memory_attribute_has_no_size(self):
        assert memory_mb(object()) is None


class TestTheLineMeasuresTheInvocation:
    @pytest.mark.parametrize(('memory', 'expected'), [
        ('1769', {'cpu_ms': 250.0, 'wall_ms': 500.0, 'function_memory_size': 1769, 'cpu_pct_of_allocation': 50.0}),
        (None, {'cpu_ms': 250.0, 'wall_ms': 500.0}),
    ])
    def test_cpu_and_wall_are_the_elapsed_milliseconds(self, memory: Any, expected: dict[str, float]):
        context = MagicMock()
        context.memory_limit_in_mb = memory
        with (
            patch.object(invocation_cost.time, 'process_time', return_value=1.25),
            patch.object(invocation_cost.time, 'perf_counter', return_value=2.5),
            patch.object(invocation_cost, 'logger') as logger,
        ):
            log_invocation_cost(context, 1.0, 2.0)
        logger.info.assert_called_once_with('invocation_cost', extra=expected)
