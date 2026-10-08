"""The extractor's stdlib `invocation_cost` line must match `shared/invocation_cost.py`.

The extractor cannot import `shared/` at runtime (module docstring), so it re-states
the two pure helpers. One Logs Insights query reads every function's line
(scripts/capacity/capacity-query.sh), so a drift in a field name or in the formula
would silently drop this function from the CPU rule. A TEST can import shared/ —
the pattern test_status_lockstep.py and test_default_model_lockstep.py use.
"""
import io
import json
import logging
from unittest.mock import MagicMock

import pytest

from product_doc_extractor import handler as extractor
from shared import invocation_cost


def test_the_constants_match():
    assert extractor._COST_LINE == invocation_cost.COST_LINE
    assert extractor._MB_PER_VCPU == invocation_cost.MB_PER_VCPU


@pytest.mark.parametrize('raw', ['1024', 512, '', None, '0', 'x', '-3'])
def test_memory_parsing_matches(raw):
    context = MagicMock()
    context.memory_limit_in_mb = raw
    assert extractor._memory_mb(context) == invocation_cost.memory_mb(context)


@pytest.mark.parametrize(('memory', 'cpu_ms', 'wall_ms'), [
    (512, 12.34, 56.78), (1769, 100.0, 100.0), (128, 0.0, 0.0), (None, 3.0, 9.0), (256, 7.0, 0.0),
])
def test_fields_match(memory, cpu_ms, wall_ms):
    assert extractor._invocation_cost_fields(memory, cpu_ms, wall_ms) == \
        invocation_cost.invocation_cost_fields(memory, cpu_ms, wall_ms)


def test_the_handler_writes_one_json_cost_line_without_the_event():
    # Captured with the module's own formatter, as test_structured_logging.py does.
    stream = io.StringIO()
    capture = logging.StreamHandler(stream)
    capture.setFormatter(extractor.JsonFormatter())
    extractor.logger.addHandler(capture)
    context = MagicMock()
    context.memory_limit_in_mb = '512'
    try:
        # No records: nothing reaches AWS, and the line is still written.
        assert extractor.lambda_handler({'Records': [], 'note': 'secret text'}, context) == {'processed': 0}
    finally:
        extractor.logger.removeHandler(capture)

    lines = [json.loads(line) for line in stream.getvalue().splitlines() if 'invocation_cost' in line]
    assert len(lines) == 1
    [line] = lines
    assert line['message'] == 'invocation_cost'
    assert line['function_memory_size'] == 512
    assert {'cpu_ms', 'wall_ms', 'cpu_pct_of_allocation'} <= set(line)
    assert 'secret text' not in json.dumps(line)


def test_the_line_is_written_when_processing_raises(monkeypatch):
    seen: list[tuple[str, dict]] = []
    monkeypatch.setattr(extractor, '_process_records', MagicMock(side_effect=RuntimeError('boom')))
    monkeypatch.setattr(extractor.logger, 'info', lambda msg, **kw: seen.append((msg, kw)))

    with pytest.raises(RuntimeError, match='boom'):
        extractor.lambda_handler({'Records': []}, MagicMock(memory_limit_in_mb='512'))
    assert [msg for msg, _ in seen] == ['invocation_cost']
