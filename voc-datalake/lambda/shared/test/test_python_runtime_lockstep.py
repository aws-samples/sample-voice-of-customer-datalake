"""Guard test for the Python version, mirrored in `.python-version` and the CDK.

The repo root's `.python-version` decides which interpreter CI runs on — both
`.github/workflows/*.yml` resolve it via `actions/setup-python`'s
`python-version-file`. The CDK stacks under `lib/` independently declare
`lambda.Runtime.PYTHON_3_*`, which decides which interpreter the deployed
Lambdas actually execute on.

Nothing tied the two together. Bumping `.python-version` to 3.15 while the
stacks still deploy 3.14 leaves every check green — CI passes on an interpreter
no Lambda runs, and every Lambda runs an interpreter nothing tested. The bump in
the other direction is worse: raising the CDK runtime with CI left behind means
the first evidence of an incompatibility is a production invocation.

This is the reason to assert it here rather than trust review: the two files are
in different languages, in different trees, and a change to either reads as
routine. Now that CI's interpreter is chosen by a file in this repo, the coupling
is load-bearing.

Same pattern as `test_search_minimum_lockstep.py` (TS ↔ Python search bound) and
`test_indexes.py` (CDK ↔ Python GSI names): parse the other language's source and
assert equality, so a change on either side fails CI instead of at deploy time.
"""
import re
from pathlib import Path

import pytest


def _voc_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


# `.python-version` is at the REPOSITORY root, one level above voc-datalake/ —
# which is why both workflows reference it unprefixed while every other path
# they use is `voc-datalake/`-prefixed.
_PYTHON_VERSION_FILE = _voc_root().parent / '.python-version'
_CDK_DIR = _voc_root() / 'lib'


def _declared_ci_version() -> str | None:
    """The `major.minor` in `.python-version`, or None if unreadable.

    A patch-qualified value (`3.14.7`) is truncated to `major.minor`, since that
    is the granularity a Lambda runtime has — `PYTHON_3_14` names no patch.
    """
    if not _PYTHON_VERSION_FILE.exists():
        return None
    match = re.match(r'\s*(\d+)\.(\d+)', _PYTHON_VERSION_FILE.read_text())
    return f'{match.group(1)}.{match.group(2)}' if match else None


def _cdk_runtimes() -> set[str]:
    """Every distinct `major.minor` named by a `Runtime.PYTHON_3_*` in `lib/`.

    A set rather than one value on purpose: finding more than one means the
    stacks disagree among themselves, which is worth failing on separately from
    disagreeing with `.python-version`.
    """
    if not _CDK_DIR.exists():
        return set()
    found: set[str] = set()
    for source in _CDK_DIR.rglob('*.ts'):
        for major, minor in re.findall(r'Runtime\.PYTHON_(\d+)_(\d+)\b', source.read_text()):
            found.add(f'{major}.{minor}')
    return found


class TestPythonRuntimeMirror:
    """The comparison SKIPS when the CDK tree is gone; the controls do not.

    A checkout without `lib/` should not report a mismatch it never measured —
    that is an empty-set comparison masquerading as a finding, so the equality
    test carries a `skipif`.

    The two control tests carry NO skip marker on purpose: they assert the
    sources are findable and the constants parse, which is exactly the check
    that has to run. Skipping them would leave the equality test able to pass
    while comparing against nothing.
    """

    def test_the_ci_interpreter_is_declared_and_parses(self):
        """The positive control for the `.python-version` side."""
        assert _PYTHON_VERSION_FILE.exists(), (
            f'.python-version moved: {_PYTHON_VERSION_FILE}. Both GitHub workflows '
            "resolve CI's interpreter from it via setup-python's python-version-file, "
            'so a move breaks them before any test runs.'
        )
        assert _declared_ci_version() is not None, (
            f'parsed no major.minor from {_PYTHON_VERSION_FILE} — parser drift?'
        )

    @pytest.mark.skipif(not _CDK_DIR.exists(), reason='CDK tree absent from this checkout')
    def test_the_cdk_runtime_is_findable(self):
        """The positive control for the CDK side.

        Without it, a refactor that routes every function through a shared
        constant this regex does not match would make `_cdk_runtimes()` empty
        and the equality test below would compare against nothing — a green
        result meaning "did not check".
        """
        assert _cdk_runtimes(), (
            'parsed no Runtime.PYTHON_*_* from lib/ — the stacks either stopped '
            'declaring a Python runtime or now build it somewhere this parser cannot '
            'see, in which case point this test at the new source'
        )

    @pytest.mark.skipif(not _CDK_DIR.exists(), reason='CDK tree absent from this checkout')
    def test_the_stacks_agree_among_themselves(self):
        """One runtime across all stacks.

        Two would mean some Lambdas run an interpreter CI cannot also be
        matching, so the question "which Python is this repo on" would have no
        single answer for the test below to check.
        """
        runtimes = _cdk_runtimes()
        assert len(runtimes) == 1, (
            f'lib/ declares more than one Python runtime: {sorted(runtimes)}. Pick one, '
            'or teach this test which is authoritative and why the others differ.'
        )

    @pytest.mark.skipif(not _CDK_DIR.exists(), reason='CDK tree absent from this checkout')
    def test_ci_tests_the_interpreter_the_stacks_deploy(self):
        """Equality, so bumping one side fails here rather than in production."""
        runtimes = _cdk_runtimes()
        assert runtimes == {_declared_ci_version()}, (
            f'.python-version declares {_declared_ci_version()} but the stacks deploy '
            f'{sorted(runtimes)} — CI would test an interpreter no Lambda runs. Bump both '
            'in the same change, and check the runtime is actually available in Lambda '
            'before raising it.'
        )
