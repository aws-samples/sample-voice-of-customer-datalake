"""
Drift guard for the centralized manual-run secret-cache clear (#141/#215).

BaseIngestor.__init__ clears the shared secret cache when it receives an
execution_id — BEFORE the secret is read. That only works if plugin handlers
pass execution_id INTO the constructor. The historical drift vector is
assigning it post-construction (``ingestor.execution_id = ...``), which skips
the guard silently: the ingestor has already read the (possibly stale) secret
by then. synthetic_reviews shipped with exactly that pattern and carried the
Save-then-Run-now stale-secret bug as a result.

This test scans every plugin handler and fails on post-construction
execution_id assignment, so a future plugin can't reintroduce the bug.
"""

import re
from pathlib import Path

PLUGINS_DIR = Path(__file__).parent

# Matches `<anything>.execution_id = ...` EXCEPT `self.execution_id = ...`
# (the base class owns the attribute; plugins must pass it via __init__).
# `(?!=)` keeps comparisons (`== `) out. Heuristic by design: it won't catch
# setattr(...) or attribute chains (`a.b.execution_id =`) — acceptable, since
# the guarded pattern is the one that has actually shipped.
POST_CONSTRUCTION_ASSIGNMENT = re.compile(
    r'^\s*(?!self\b)[A-Za-z_][A-Za-z0-9_]*\.execution_id\s*=(?!=)', re.MULTILINE
)


def _plugin_handler_files():
    # _template is included deliberately: it's what new plugins are copied
    # from, so it must demonstrate the compliant pattern too.
    return sorted(PLUGINS_DIR.glob('*/ingestor/handler.py'))


def test_plugin_handlers_exist():
    """Sanity: the glob matches the real plugin layout (guard isn't vacuous)."""
    files = _plugin_handler_files()
    assert len(files) >= 5, f'expected >=5 plugin handlers, found {[str(f) for f in files]}'


def test_no_plugin_assigns_execution_id_after_construction():
    """execution_id must flow through the constructor, never be set post-hoc —
    a post-construction assignment silently skips the secret-cache guard."""
    offenders = []
    for handler in _plugin_handler_files():
        source = handler.read_text(encoding='utf-8')
        for match in POST_CONSTRUCTION_ASSIGNMENT.finditer(source):
            line_no = source[:match.start()].count('\n') + 1
            offenders.append(f'{handler.relative_to(PLUGINS_DIR)}:{line_no}')
    assert not offenders, (
        'Post-construction execution_id assignment bypasses the centralized '
        'secret-cache guard (issues #141/#215). Pass execution_id to the '
        f'ingestor constructor instead. Offenders: {offenders}'
    )
