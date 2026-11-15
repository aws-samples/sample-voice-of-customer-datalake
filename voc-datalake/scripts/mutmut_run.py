"""The Python half of scripts/mutate-python.sh (mutmut 3.x). Not a gate.

  python scripts/mutmut_run.py baseline <names-out> <module.py> <tests...>   # from voc-datalake/
  git diff --unified=0 <range> -- <module.py> | python scripts/mutmut_run.py patch-spans
  python scripts/mutmut_run.py [--only-lines <path>:<from>-<to>[,...]] <mutmut command> [args...]   # from the stage

``baseline`` runs the tests unmutated in this process, then writes every name the module was imported
under (one per line) to <names-out>, including names a fixture dropped from ``sys.modules`` again (they
are collected before every test's teardown). mutmut 3 links a test to a mutant by the module's import name
(``shared.llm_json``), which it derives from the file's path below its working directory, so the
shell script needs that name to build the stage. It exits with pytest's exit code.

``patch-spans`` reads a ``git diff --unified=0`` on stdin and prints the new-side line spans of its hunks
(``3-5,9-9``; nothing for a diff that only deletes). Only the ``@@`` headers are read, never the file
names, so a diff whose paths are repo-root-relative (``voc-datalake/lambda/...``) scopes the same lines:
mutmut 2's path matching is what made ``--patch`` produce no mutants.

Any other command is mutmut's own CLI (``run``, ``results``, ``show``, ``browse``). ``--only-lines``
makes ``run`` mutate only those lines of that file. mutmut 3 has no line filter of its own; with
``mutate_only_covered_lines`` it skips every line outside the set coverage.py reports for a file, so
this hands it the chosen lines as that set instead of measuring coverage.
"""
from __future__ import annotations

import os
import re
import sys
from collections.abc import Iterable
from pathlib import Path

import pytest

# pytest.ini's addopts turn on coverage for the whole suite; a mutation run needs none of it.
PYTEST_OPTS = ['-o', 'addopts=', '-q', '-p', 'no:cacheprovider']


HUNK_HEADER = re.compile(r'^@@ -[0-9,]+ \+(\d+)(?:,(\d+))? @@')


def spans_from_diff(diff: str) -> str:
    """Every hunk's new-side span of a unified diff as ``<from>-<to>[,...]``; a pure deletion (``+n,0``) adds none."""
    spans: list[str] = []
    for line in diff.splitlines():
        match = HUNK_HEADER.match(line)
        if match is None:
            continue
        start = int(match.group(1))
        count = 1 if match.group(2) is None else int(match.group(2))
        if count > 0:
            spans.append(f'{start}-{start + count - 1}')
    return ','.join(spans)


def parse_line_spans(spec: str) -> set[int]:
    """``'3-5,9-9'`` as ``{3, 4, 5, 9}``; a malformed or reversed span is a ValueError."""
    lines: set[int] = set()
    for span in spec.split(','):
        first, _, last = span.partition('-')
        start, end = int(first), int(last)
        if start < 1 or end < start:
            raise ValueError(f'not a line span: {span!r}')
        lines.update(range(start, end + 1))
    return lines


def import_names(module: str, modules: dict[str, object]) -> list[str]:
    """The names in *modules* (a ``sys.modules``) whose file is *module*, longest first."""
    target = os.path.realpath(module)
    names: list[str] = []
    for name, loaded in modules.items():
        file = getattr(loaded, '__file__', None)
        if isinstance(file, str) and os.path.realpath(file) == target:
            names.append(name)
    return sorted(names, key=lambda name: (-len(name), name))


class ImportNameRecorder:
    """A pytest plugin that collects *module*'s import names before every test's teardown.

    A fixture may load a module and drop it from ``sys.modules`` again when it tears down (the project
    export's tests load ``project_bundle.exporter`` that way), so ``sys.modules`` after the run may no
    longer hold it. Names seen at any point, in the order first seen, plus those left at the end.
    """

    def __init__(self, module: str) -> None:
        self.module = module
        self.seen: dict[str, None] = {}

    def record(self, modules: dict[str, object]) -> None:
        for name in import_names(self.module, modules):
            self.seen.setdefault(name, None)

    def names(self, modules: dict[str, object]) -> list[str]:
        self.record(modules)
        return sorted(self.seen, key=lambda name: (-len(name), name))

    @pytest.hookimpl(tryfirst=True)   # before pytest's own teardown, which runs the fixtures' finalizers
    def pytest_runtest_teardown(self) -> None:
        self.record(dict(sys.modules))


def baseline(names_out: str, module: str, tests: list[str]) -> int:
    recorder = ImportNameRecorder(module)
    exit_code = int(pytest.main([*PYTEST_OPTS, *tests], plugins=[recorder]))
    names = recorder.names(dict(sys.modules))
    Path(names_out).write_text(''.join(f'{name}\n' for name in names), encoding='utf-8')
    return exit_code


def limit_mutations_to(path: str, lines: set[int]) -> None:
    """Make the next ``mutmut run`` in this process mutate only *lines* of *path* (relative to the stage).

    Needs ``mutate_only_covered_lines = true`` in the stage's config: mutmut then asks ``gather_coverage``
    for the lines to mutate, and this answers with the chosen ones instead of running coverage.py.
    """
    import mutmut.__main__ as mutmut_main
    from mutmut.code_coverage import CoverageInfo

    def chosen_lines(_runner: object, source_files: Iterable[Path]) -> CoverageInfo:
        # Keyed like get_covered_lines_for_file reads it: the absolute path of the file's copy in mutants/.
        return CoverageInfo(covered_lines={str((Path('mutants') / file).absolute()): lines
                                           for file in source_files if str(file) == path})

    # Through the module's namespace: `run` looks gather_coverage up there when it builds the mutants.
    mutmut_main.__dict__['gather_coverage'] = chosen_lines


def main(argv: list[str]) -> int:
    if argv == ['patch-spans']:
        print(spans_from_diff(sys.stdin.read()))
        return 0
    if argv[:1] == ['baseline'] and len(argv) >= 4:
        return baseline(argv[1], argv[2], argv[3:])
    if argv[:1] == ['--only-lines'] and len(argv) >= 3:
        path, _, spec = argv[1].rpartition(':')
        limit_mutations_to(path, parse_line_spans(spec))
        argv = argv[2:]
    import mutmut.__main__ as mutmut_main

    mutmut_main.cli.main(args=argv, prog_name='mutmut')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
