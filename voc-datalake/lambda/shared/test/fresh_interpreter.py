"""Test support: run a snippet in a fresh interpreter laid out like an API Lambda bundle.

For import-time guards (what a handler loads at cold start, which hooks it
registers): the pytest process has long since imported most of the tree, so
in-process `sys.modules` checks would pass whatever the import graph looks like.
The child sees `lambda/api` and `lambda/` on its path — the handler + `shared/`
at the root, as `createApiLambdaCode` stages them — and fake AWS settings only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

LAMBDA_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
API_DIR = os.path.join(LAMBDA_DIR, 'api')

# Inherited variables that would change what the child does at import.
_DROPPED_PREFIXES = ('_X_AMZN', 'POWERTOOLS_TRACE', 'AWS_XRAY')


def bundle_env(**overrides: str) -> dict[str, str]:
    """The parent's environment minus tracing state, plus a bundle path and fake AWS settings."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(_DROPPED_PREFIXES)}
    env.update({
        'PYTHONPATH': os.pathsep.join([API_DIR, LAMBDA_DIR]),
        'AWS_REGION': 'us-east-1',
        'AWS_DEFAULT_REGION': 'us-east-1',
        'AWS_ACCESS_KEY_ID': 'testing',
        'AWS_SECRET_ACCESS_KEY': 'testing',
        'AWS_EC2_METADATA_DISABLED': 'true',
    })
    env.update(overrides)
    return env


def run_json(code: str, **env: str) -> dict:
    """Run `code` (dedented) in a fresh interpreter; it must print one JSON object last.

    check=False on purpose: a failing child surfaces its stderr, not an opaque
    CalledProcessError.
    """
    result = subprocess.run(
        [sys.executable, '-c', textwrap.dedent(code)],
        capture_output=True, text=True, check=False, cwd=LAMBDA_DIR, env=bundle_env(**env),
    )
    if result.returncode != 0:
        raise AssertionError(f'child failed ({result.returncode}):\n{result.stderr[-3000:]}')
    return json.loads(result.stdout.strip().splitlines()[-1])
