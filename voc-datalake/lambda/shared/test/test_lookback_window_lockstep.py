"""Guard test for the date-scan lookback bound, mirrored in Python and TypeScript.

`shared/feedback.py` owns `MAX_LOOKBACK_DAYS`: the REST feedback routes spend it
as ``days=min(days, MAX_LOOKBACK_DAYS)``. The streaming chat Lambda is a second
runtime of the same rule — `lambda/stream/src/tools/feedback-scan.ts` runs its
own date scan and cannot import Python — so it declares its own copy.

Nothing tied the two together, and they diverged for months: the chat tool capped
its scan at 30 days while the route used 90. The failure is silent rather than
loud — a user asking about a quarter of feedback got a month of it, with the model
reporting the truncated numbers as if they were the whole window.

Same pattern as `test_search_minimum_lockstep.py` (frontend gate ↔ route bound)
and `test_indexes.py` (CDK ↔ Python GSI names): parse the other language's source
and assert equality, so a change on either side fails CI instead of quietly
answering the wrong question.

The third test guards the OTHER way this file can go green over drifted code: a
constant that agrees with Python is worthless if the day scan re-acquires a
hard-coded clamp of its own. It asserts properties (the constant is spent; no
numeric-literal window clamp survives anywhere) rather than one exact spelling,
so reformatting or moving the clamp does not fail it for a non-defect. The clamp
check is a TRIPWIRE for the idioms this codebase writes, not a proof — a bound
computed at runtime would pass it — so the reference count is the load-bearing
half. Both properties read every chat-tool source rather than one path, because
the constant is declared beside the reads while `resolveSearchParams` spends it
in `search-feedback.ts`.

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


_TOOL_SOURCE = _repo_root() / 'lambda' / 'stream' / 'src' / 'tools' / 'feedback-scan.ts'

# Every clamp idiom this codebase writes, so a re-introduced literal bound fails
# here however it is spelled. A tripwire rather than a proof — see the module
# docstring — but the single pattern this replaced caught only the first shape,
# and `Math.min(90, days)` and a ternary are the same defect written differently.
_LITERAL_CLAMP_PATTERNS = (
    r'Math\.min\(\s*\w*[Dd]ays\s*,\s*\d+',
    r'Math\.min\(\s*\d+\s*,\s*\w*[Dd]ays',
    r'\w*[Dd]ays\s*[<>]=?\s*\d+\s*\?',
)


def search_feedback_sources() -> dict[str, str]:
    """The chat tool's own sources, by file name.

    Read as a SET rather than one path: the constant lives with the reads in
    `feedback-scan.ts` while `resolveSearchParams` spends it in
    `search-feedback.ts`, so pinning one file let a mutation that moved the clamp
    into the sibling and made it a literal pass unnoticed. Verified by applying
    exactly that mutation, not by reading the glob.
    """
    return {
        path.name: path.read_text()
        for path in sorted(_TOOL_SOURCE.parent.glob('*feedback*.ts'))
        if not path.name.endswith('.test.ts')
    }


def _stream_lookback_days() -> int | None:
    """`MAX_LOOKBACK_DAYS` as declared in the chat tool, or None if not found."""
    match = re.search(
        r'export\s+const\s+MAX_LOOKBACK_DAYS\s*=\s*(\d+)',
        _TOOL_SOURCE.read_text(),
    )
    return int(match.group(1)) if match else None


def strip_comments(source: str) -> str:
    """TypeScript with `//` lines and `/* */` blocks removed.

    Load-bearing for the checks below, which ask what the CODE does. That file
    documents `MAX_LOOKBACK_DAYS` at length and names it repeatedly in prose, so
    counting raw occurrences let a version with the clamp deleted still score
    well above the threshold — the constant's own documentation vouching for a
    constant nothing spends. Found by applying that mutation to the real source
    rather than by reading the regex; `TestTheGuardItself` now pins it.
    """
    without_blocks = re.sub(r'/\*.*?\*/', '', source, flags=re.DOTALL)
    return re.sub(r'//[^\n]*', '', without_blocks)


def constant_uses(source: str) -> int:
    """How many times `MAX_LOOKBACK_DAYS` appears in CODE, declaration included.

    One means declared and never spent, which makes the equality test vacuous:
    the number agrees with Python and nothing reads it.
    """
    return len(re.findall(r'\bMAX_LOOKBACK_DAYS\b', strip_comments(source)))


def literal_day_clamps(source: str) -> list[str]:
    """Clamps of a day count against a hard-coded number, e.g. `Math.min(days, 30)`.

    Any `*days`/`*Days` operand matches, so renaming the local to `requestedDays`
    when the clamp moved did not open a blind spot. Three idioms rather than one,
    because `Math.min(30, days)` and `days > 30 ? 30 : days` are the same defect:
    a single-pattern draft missed both.
    """
    code = strip_comments(source)
    return [
        match
        for pattern in _LITERAL_CLAMP_PATTERNS
        for match in re.findall(pattern, code)
    ]


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

        Both properties are measured over the source with COMMENTS STRIPPED. See
        `strip_comments`: counting prose let a file that had stopped spending the
        constant pass on the strength of its own docblocks.

        And over EVERY chat-tool source, not just the declaring one: the clamp is
        spent in `search-feedback.ts` while the constant is declared in
        `feedback-scan.ts`, so a one-path check misses a literal clamp
        re-appearing in the other half.
        """
        sources = search_feedback_sources()
        assert sources, f'no chat tool sources beside {_TOOL_SOURCE}'
        uses = sum(constant_uses(text) for text in sources.values())
        assert uses >= 2, (
            f'MAX_LOOKBACK_DAYS appears {uses}x across {", ".join(sources)} code — declared '
            'but never spent, so the equality test above pins a number nothing reads'
        )
        clamps = {
            name: found
            for name, text in sources.items()
            if (found := literal_day_clamps(text))
        }
        assert not clamps, (
            f'the chat tool clamps its window with a hard-coded literal '
            f'({clamps}) — that is how the 30-vs-90 divergence happened, and it '
            'makes the equality test vacuous'
        )


class TestTheGuardItself:
    """Both directions of the property checks, on synthetic sources.

    The point of replacing the substring assertion was that it failed on correct
    code. Asserting only that the real file passes cannot demonstrate the
    replacement fixed that, because a check which accepts everything also passes.
    So each predicate is exercised against sources it must accept AND sources it
    must reject — including the mutation that slipped past the first draft.
    """

    def test_it_accepts_the_clamp_wherever_it_lives_and_however_it_is_spelled(self):
        """The three shapes the old substring assertion rejected for no defect."""
        relocated = (
            'export const MAX_LOOKBACK_DAYS = 90;\n'
            'days: Math.min(requestedDays, MAX_LOOKBACK_DAYS),'
        )
        reformatted = (
            'export const MAX_LOOKBACK_DAYS = 90;\n'
            'const scanned = Math.min(\n  days,\n  MAX_LOOKBACK_DAYS,\n);'
        )
        extracted = (
            'export const MAX_LOOKBACK_DAYS = 90;\n'
            'const clampWindow = (d: number) => Math.min(d, MAX_LOOKBACK_DAYS);'
        )
        for source in (relocated, reformatted, extracted):
            assert constant_uses(source) >= 2
            assert not literal_day_clamps(source)

    def test_it_still_rejects_a_bare_literal_and_a_constant_nobody_spends(self):
        """The drift the guard exists for, in each of its shapes."""
        literal_clamp = 'export const MAX_LOOKBACK_DAYS = 90;\nconst scanned = Math.min(days, 30);'
        assert literal_day_clamps(literal_clamp), 'a re-introduced literal clamp went unnoticed'

        renamed = 'export const MAX_LOOKBACK_DAYS = 90;\nMath.min(requestedDays, 30)'
        assert literal_day_clamps(renamed), 'a literal clamp on a renamed operand went unnoticed'

        # The same clamp with the arguments the other way round, and as a ternary.
        # A single-pattern draft passed both, so the drift this guard exists for
        # survived it — verified against the compiled patterns, not assumed.
        reversed_args = 'export const MAX_LOOKBACK_DAYS = 90;\nMath.min(90, requestedDays)'
        assert literal_day_clamps(reversed_args), 'a reversed-argument literal clamp went unnoticed'

        ternary = (
            'export const MAX_LOOKBACK_DAYS = 90;\n'
            'const scanned = requestedDays > 90 ? 90 : requestedDays;'
        )
        assert literal_day_clamps(ternary), 'a ternary literal clamp went unnoticed'

        declared_only = 'export const MAX_LOOKBACK_DAYS = 90;\nconst scanned = days;'
        assert constant_uses(declared_only) < 2, 'a constant nobody spends went unnoticed'

    def test_prose_naming_the_constant_does_not_count_as_spending_it(self):
        """The mutation that slipped past the first draft of this guard.

        `search-feedback.ts` names MAX_LOOKBACK_DAYS several times in docblocks,
        so counting raw occurrences let the real file pass with the clamp removed.
        Caught by applying that mutation to the actual source, not by inspection.
        """
        commented_out = (
            '/**\n * Mirror of MAX_LOOKBACK_DAYS in feedback.py. See MAX_LOOKBACK_DAYS.\n */\n'
            'export const MAX_LOOKBACK_DAYS = 90;\n'
            '// The clamp used to spend MAX_LOOKBACK_DAYS right here.\n'
            'const scanned = requestedDays;'
        )
        assert constant_uses(commented_out) < 2, (
            'comments mentioning the constant counted as uses, so a file that stopped '
            'spending it would still pass'
        )

        # The inverse, so the strip cannot pass by deleting everything: a genuine
        # use in code still counts when the surrounding prose is removed.
        genuinely_used = (
            '// Mirror of MAX_LOOKBACK_DAYS.\n'
            'export const MAX_LOOKBACK_DAYS = 90;\n'
            'const scanned = Math.min(requestedDays, MAX_LOOKBACK_DAYS);'
        )
        assert constant_uses(genuinely_used) >= 2

        # And a literal clamp mentioned only in a comment is not a real clamp.
        discussed_not_done = (
            '// This used to read Math.min(days, 30) before the constant existed.\n'
            'export const MAX_LOOKBACK_DAYS = 90;\n'
            'const scanned = Math.min(days, MAX_LOOKBACK_DAYS);'
        )
        assert not literal_day_clamps(discussed_not_done), (
            'a literal clamp quoted in a comment was reported as live code'
        )

    def test_it_reads_every_chat_tool_source_not_only_the_declaring_one(self):
        """The gap that opened when the reads moved to their own module.

        The constant is declared in `feedback-scan.ts`; `resolveSearchParams`
        spends it in `search-feedback.ts`. A guard bound to one path passed a
        mutation that put a literal clamp in the other file — found by applying it,
        which is why the property below is over the whole set.
        """
        sources = search_feedback_sources()
        assert 'feedback-scan.ts' in sources, 'the declaring source is not in the set'
        assert 'search-feedback.ts' in sources, (
            'the file that SPENDS the constant is not in the set, so a literal clamp '
            'there would go unnoticed'
        )
        assert not any(name.endswith('.test.ts') for name in sources), (
            'test files are in the set, so a clamp in a fixture would read as production drift'
        )
