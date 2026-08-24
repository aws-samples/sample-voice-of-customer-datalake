"""Guard test for the date-scan lookback bound, mirrored in Python and TypeScript.

`shared/feedback.py` owns `MAX_LOOKBACK_DAYS`: the REST feedback routes spend it
as ``days=min(days, MAX_LOOKBACK_DAYS)``. The streaming chat Lambda is a second
runtime of the same rule — `lambda/stream/src/tools/search-feedback.ts` runs its
own date loop and cannot import Python — so it declares its own copy.

Nothing tied the two together, and they diverged for months: the chat tool capped
its scan at 30 days while the route used 90. The failure is silent rather than
loud — a user asking about a quarter of feedback got a month of it, with the model
reporting the truncated numbers as if they were the whole window.

Same pattern as `test_search_minimum_lockstep.py` (frontend gate ↔ route bound)
and `test_indexes.py` (CDK ↔ Python GSI names): parse the other language's source
and assert equality, so a change on either side fails CI instead of quietly
answering the wrong question.

The third test guards the OTHER way this file can go green over drifted code: a
constant that agrees with Python is worthless if the day loop re-acquires a
hard-coded clamp of its own. It asserts properties (the constant is spent; no
numeric-literal window clamp survives anywhere) rather than one exact spelling,
so reformatting or moving the clamp does not fail it for a non-defect.

Deliberately NOT asserted here: the candidate ceilings. TypeScript's
`MAX_CANDIDATES = 10000` and `metrics_handler.CANDIDATES_SOFT_CAP` are separate
budget decisions for different consumers (a model reading prose vs. a paginating
client), not one rule with two copies. Pinning them together would freeze a
divergence nobody has decided to close.
"""
import re
from pathlib import Path

import pytest

from shared.feedback import MAX_LOOKBACK_DAYS


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


_TOOL_SOURCE = _repo_root() / 'lambda' / 'stream' / 'src' / 'tools' / 'search-feedback.ts'


def _stream_lookback_days() -> int | None:
    """`MAX_LOOKBACK_DAYS` as declared in the chat tool, or None if not found."""
    match = re.search(
        r'export\s+const\s+MAX_LOOKBACK_DAYS\s*=\s*(\d+)',
        _TOOL_SOURCE.read_text(),
    )
    return int(match.group(1)) if match else None


class TestLookbackWindowMirror:
    """The comparison SKIPS when the stream tree is gone; the control does not.

    A checkout without `lambda/stream/` should not report a mirror mismatch it
    never measured — that is a `FileNotFoundError` masquerading as a finding — so
    the equality test carries a `skipif`.

    `test_the_stream_constant_is_findable` carries NO skip marker on purpose: it
    asserts the file exists and the constant parses, which is exactly the check
    that has to run. Skipping it would leave the equality test able to pass while
    comparing against nothing.
    """

    def test_the_stream_constant_is_findable(self):
        """The positive control.

        Without it, a rename to `MAX_LOOKBACK` or an inlined literal would make
        the parser return None and the equality test below would compare against
        nothing — a green result meaning "did not check", which is the failure
        mode this file exists to prevent, applied to itself.
        """
        assert _TOOL_SOURCE.exists(), f'chat tool source moved: {_TOOL_SOURCE}'
        assert _stream_lookback_days() is not None, (
            'parsed no MAX_LOOKBACK_DAYS from search-feedback.ts — parser drift?'
        )

    @pytest.mark.skipif(not _TOOL_SOURCE.exists(), reason='stream tree absent from this checkout')
    def test_both_runtimes_agree_on_the_lookback_window(self):
        """Equality, so widening one side fails here rather than leaving the chat
        tool answering from a fraction of the window the REST route reads."""
        assert _stream_lookback_days() == MAX_LOOKBACK_DAYS, (
            f'chat tool scans {_stream_lookback_days()} days while the REST routes '
            f'allow {MAX_LOOKBACK_DAYS}'
        )

    @pytest.mark.skipif(not _TOOL_SOURCE.exists(), reason='stream tree absent from this checkout')
    def test_the_chat_tool_spends_the_constant_rather_than_a_literal(self):
        """A second control, for the other way this guard can go green while the
        code has drifted: the constant agreeing with Python is worthless if the
        day loop still clamps to a hard-coded number of its own.

        Asserted as two PROPERTIES rather than one exact spelling. An earlier
        draft required the literal substring ``Math.min(days, MAX_LOOKBACK_DAYS)``,
        which breaks on reformatting, on renaming the local, and — worst — on
        moving the clamp to where the window is resolved, which is where it
        belongs, so that the scan bound and the cutoff filter cannot disagree. A
        guard that fails on the correct fix teaches the next reader to edit the
        guard rather than trust it, which is the failure mode `test_indexes.py`
        -style guards exist to avoid.
        """
        source = _TOOL_SOURCE.read_text()
        uses = len(re.findall(r'\bMAX_LOOKBACK_DAYS\b', source))
        assert uses >= 2, (
            f'MAX_LOOKBACK_DAYS appears {uses}x in search-feedback.ts — declared but '
            'never spent, so the equality test above pins a number nothing reads'
        )
        literal_clamp = re.search(r'Math\.min\(\s*\w*[Dd]ays\s*,\s*\d+', source)
        assert literal_clamp is None, (
            f'search-feedback.ts clamps its window with a hard-coded literal '
            f'({literal_clamp.group(0) if literal_clamp else ""}) — that is how the '
            '30-vs-90 divergence happened, and it makes the equality test vacuous'
        )
