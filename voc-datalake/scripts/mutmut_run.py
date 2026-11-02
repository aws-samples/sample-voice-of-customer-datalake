"""The Python half of scripts/mutate-python.sh (mutmut 3.x). Not a gate.

  python scripts/mutmut_run.py baseline <names-out> <module.py> <tests...>   # from voc-datalake/
  python scripts/mutmut_run.py [--only-lines <path>:<from>-<to>[,...]] <mutmut command> [args...]   # from the stage

``baseline`` runs the tests unmutated in this process, then writes every name the module was imported
under (one per line) to <names-out>. mutmut 3 links a test to a mutant by the module's import name
(``shared.llm_json``), which it derives from the file's path below its working directory, so the
shell script needs that name to build the stage. It exits with pytest's exit code.

Any other command is mutmut's own CLI (``run``, ``results``, ``show``, ``browse``). ``--only-lines``
makes ``run`` mutate only those lines of that file. mutmut 3 has no line filter of its own; it does
skip every line outside a file's set when ``mutate_only_covered_lines`` hands it one (the set comes
from coverage.py there), so this sets that set to the chosen lines instead of measuring coverage.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# pytest.ini's addopts turn on coverage for the whole suite; a mutation run needs none of it.
PYTEST_OPTS = ['-o', 'addopts=', '-q', '-p', 'no:cacheprovider']


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


def baseline(names_out: str, module: str, tests: list[str]) -> int:
    import pytest

    exit_code = int(pytest.main([*PYTEST_OPTS, *tests]))
    names = import_names(module, dict(sys.modules))
    Path(names_out).write_text(''.join(f'{name}\n' for name in names), encoding='utf-8')
    return exit_code


def limit_mutations_to(path: str, lines: set[int]) -> None:
    """Make the next ``mutmut run`` in this process mutate only *lines* of *path* (relative to the stage)."""
    import mutmut.__main__ as mutmut_main
    from mutmut.state import state

    def chosen_lines_only() -> None:
        # The key format of get_covered_lines_for_file: the absolute path of the file's copy in mutants/.
        state()._covered_lines = {str((Path('mutants') / path).absolute()): lines}

    mutmut_main.store_lines_covered_by_tests = chosen_lines_only


def main(argv: list[str]) -> int:
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
