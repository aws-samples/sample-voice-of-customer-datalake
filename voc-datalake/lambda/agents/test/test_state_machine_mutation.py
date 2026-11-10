"""Mutation hardening for ``agents.state_machine``.

The lockstep test (committed ``state_machine.asl.json`` == ``render()``) already
kills every mutant in the definition itself. The mutation run found the one part
nothing exercised: the ``python -m agents.state_machine`` developer entry point
that regenerates the JSON. A flipped ``__name__`` guard or a mangled encoding
survived. These tests run the module source with ``Path.write_text`` patched, so
the committed file is never touched.
"""
from __future__ import annotations

import runpy
from pathlib import Path
from unittest import mock

import pytest

from agents import state_machine


class TestOnlyRunningTheModuleRegeneratesTheJson:
    @pytest.mark.parametrize(('run_name', 'expected_calls'), [
        ('__main__', [mock.call(state_machine.ASL_PATH, state_machine.render(), encoding='utf-8')]),
        ('agents.state_machine', []),
    ])
    def test_write_happens_only_as_main(self, run_name: str, expected_calls: list):
        with mock.patch.object(Path, 'write_text', autospec=True) as write_text:
            runpy.run_path(state_machine.__file__, run_name=run_name)

        assert write_text.call_args_list == expected_calls
