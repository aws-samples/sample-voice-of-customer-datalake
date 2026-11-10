"""Date seeds in tests are read when the test runs, never once at import (shared/test/clock.py).

A module-level ``TODAY = datetime.now(UTC)...`` goes stale when a run crosses 00:00 UTC:
the test seeds yesterday's partition while the code under test reads today's (4.00.03).
"""
import ast
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from shared.test import clock
from shared.test.clock import today_utc

ROOTS = [Path(__file__).resolve().parents[2], Path(__file__).resolve().parents[3] / 'plugins']
DATE_SEED_NAME_HINTS = ('TODAY', 'RECENT', 'YESTERDAY', 'DATE')


def _reads_the_clock(node: ast.AST) -> bool:
    return any(
        isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr in ('now', 'today', 'utcnow')
        for call in ast.walk(node)
    )


def _module_level_date_seeds(path: Path) -> list[str]:
    tree = ast.parse(path.read_text())
    found = []
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and _reads_the_clock(stmt.value):
            names = [t.id for t in stmt.targets if isinstance(t, ast.Name)]
            found += [f'{path.name}:{stmt.lineno} {n}' for n in names if any(h in n.upper() for h in DATE_SEED_NAME_HINTS)]
    return found


def test_today_utc_reads_the_clock_at_each_call():
    first, second = datetime(2026, 1, 1, 23, 59, 59, tzinfo=UTC), datetime(2026, 1, 2, 0, 0, 1, tzinfo=UTC)
    with patch.object(clock, 'datetime') as fake:
        fake.now.side_effect = [first, second]
        assert (today_utc(), today_utc()) == ('2026-01-01', '2026-01-02')
        fake.now.assert_called_with(UTC)


def test_no_test_module_pins_a_date_seed_at_import():
    offenders = [
        seed
        for root in ROOTS
        for path in root.rglob('test_*.py')
        if '/test' in str(path)
        for seed in _module_level_date_seeds(path)
    ]
    assert offenders == []


def test_the_scan_finds_an_import_time_date_seed(tmp_path):
    # Anti-vacuous: the shape that caused the midnight failures is detected.
    sample = tmp_path / 'test_sample.py'
    sample.write_text("from datetime import UTC, datetime\nTODAY = datetime.now(UTC).strftime('%Y-%m-%d')\n")
    assert _module_level_date_seeds(sample) == ['test_sample.py:2 TODAY']
