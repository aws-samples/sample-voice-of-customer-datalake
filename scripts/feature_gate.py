"""The roadmap gate's command line: every released roadmap item proven by accepted tests (docs/feature-tests/README.md).

    python3 scripts/feature_gate.py check | seed | baseline --init|--shrink | stats [--section <file>]
    python3 scripts/feature_gate.py register|brief|accept|reject <item> <test> …
    python3 scripts/feature_gate.py run --sha <sha>

The program is the scripts/feature_gate/ package (cli.py); its tests are scripts/feature_gate/test/. The package is
run by name (runpy), not imported here: this file and the package share the name ``feature_gate``, and a static import
would read to a code scanner as the package importing itself.
"""
from __future__ import annotations

import runpy

if __name__ == '__main__':
    runpy.run_module('feature_gate.cli', run_name='__main__', alter_sys=True)
