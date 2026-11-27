"""Guard test for the Python version, mirrored in `.python-version` and the CDK.

The repo root's `.python-version` decides which interpreter CI runs on — every
`.github/workflows/*.yml` that sets up Python (the quality gates, whose py lane
runs the full pytest suite, the MCP backend tests, the event-logging guard and
the dependency audit; 7.104.00) resolves it via `actions/setup-python`'s
`python-version-file`, and `test_every_workflow_takes_the_interpreter_from_the_file`
below holds them to it. ruff and pyright keep 3.12 as their static target
(ruff.toml, pyrightconfig.json), the local tooling floor, which no workflow
installs. The CDK stacks under `lib/` independently declare
`lambda.Runtime.PYTHON_3_*`, which decides which interpreter the deployed
Lambdas actually execute on.

Nothing tied the two together. Bumping `.python-version` to 3.16 while the
stacks still deploy 3.15 leaves every check green — CI passes on an interpreter
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

A full checkout is required, deliberately
-----------------------------------------
There is no `skipif` for a missing `lib/` tree. An earlier version carried one on
each comparison, reasoning that a checkout without the CDK should not report a
mismatch it never measured — but `test_the_ci_interpreter_is_declared_and_parses`
carries no marker and would fail on such a checkout anyway, so the markers only
changed which test reported the problem. The full reasoning, shared by every
lockstep test, is "A full checkout is required" in `shared/test/repo_paths.py`.
"""
import re
from pathlib import Path


def _voc_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


# `.python-version` is at the REPOSITORY root, one level above voc-datalake/ —
# which is why the workflows reference it unprefixed while every other path
# they use is `voc-datalake/`-prefixed.
_PYTHON_VERSION_FILE = _voc_root().parent / '.python-version'
_CDK_DIR = _voc_root() / 'lib'
_WORKFLOWS_DIR = _voc_root().parent / '.github' / 'workflows'


def _declared_ci_version() -> str | None:
    """The `major.minor` in `.python-version`, or None if unreadable.

    A patch-qualified value (`3.15.2`) is truncated to `major.minor`, since that
    is the granularity a Lambda runtime has — `PYTHON_3_15` names no patch.
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
    """Both sides must be readable, agree internally, and agree with each other.

    Ordered from "can this be measured at all" to "does it hold", so a broken
    parser reports itself rather than being reported as a mismatch. None of these
    is skippable — see the file docstring on why a full checkout is required.
    """

    def test_the_ci_interpreter_is_declared_and_parses(self):
        """The positive control for the `.python-version` side."""
        assert _PYTHON_VERSION_FILE.exists(), (
            f'.python-version moved: {_PYTHON_VERSION_FILE}. Every GitHub workflow that sets '
            "up Python resolves CI's interpreter from it via setup-python's python-version-file, "
            'so a move breaks them before any test runs.'
        )
        assert _declared_ci_version() is not None, (
            f'parsed no major.minor from {_PYTHON_VERSION_FILE} — parser drift?'
        )

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

    def test_ci_tests_the_interpreter_the_stacks_deploy(self):
        """Equality, so bumping one side fails here rather than in production."""
        runtimes = _cdk_runtimes()
        assert runtimes == {_declared_ci_version()}, (
            f'.python-version declares {_declared_ci_version()} but the stacks deploy '
            f'{sorted(runtimes)} — CI would test an interpreter no Lambda runs. Bump both '
            'in the same change, and check the runtime is actually available in Lambda '
            'before raising it.'
        )

    def test_every_workflow_takes_the_interpreter_from_the_file(self):
        """Every setup-python step reads `.python-version`, none names a version.

        A workflow pinned to another version (the quality gates were on 3.12 until
        7.104.00) would run its tests on an interpreter no Lambda runs, which the
        equality above cannot see.
        """
        steps = pinned = 0
        for workflow in sorted(_WORKFLOWS_DIR.glob('*.yml')):
            text = workflow.read_text()
            steps += len(re.findall(r'uses:\s*actions/setup-python@', text))
            pinned += len(re.findall(r'^\s*python-version-file:\s*\.python-version\s*$', text, re.MULTILINE))
            assert not re.findall(r'^\s*python-version:', text, re.MULTILINE), (
                f'{workflow.name} names a Python version: use python-version-file: .python-version'
            )
        assert steps >= 4, f'found {steps} setup-python steps under {_WORKFLOWS_DIR} — parser drift?'
        assert pinned == steps
