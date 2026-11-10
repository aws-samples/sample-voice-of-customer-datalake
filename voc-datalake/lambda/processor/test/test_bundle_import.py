"""The processor imports, with validation wired, from its DEPLOYED layout (#249).

The unit suite runs from the source tree, where `plugins/` sits next to
`lambda/` — which is how `from _shared.schemas import ...` kept passing tests
while failing in every deployed function. This rebuilds the bundle exactly as
processing-stack-consolidated.ts does (`cp -r processor/* .` + `cp -r shared .`;
the CDK suite pins that command) in a temp dir and imports `handler` in a fresh
interpreter whose path holds that dir and site-packages only — no repo tree.
"""
import os
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path

LAMBDA_DIR = Path(__file__).resolve().parents[2]

_PROBE = (
    "import handler, shared.ingest_schemas as s;"
    "assert handler.safe_validate_message is s.safe_validate_message;"
    "assert 'plugins' not in ' '.join(__import__('sys').path);"
    "print('ok')"
)


def _build_bundle(root: Path) -> None:
    """processing-stack-consolidated.ts: processor/* and shared/ into one root."""
    ignore = shutil.ignore_patterns('test', '__pycache__', '*.pyc')
    for entry in (LAMBDA_DIR / 'processor').iterdir():
        if entry.name in {'test', '__pycache__'}:
            continue
        if entry.is_dir():
            shutil.copytree(entry, root / entry.name, ignore=ignore)
        else:
            shutil.copy2(entry, root / entry.name)
    shutil.copytree(LAMBDA_DIR / 'shared', root / 'shared', ignore=ignore)


def _run_probe(root: Path) -> subprocess.CompletedProcess:
    env = {
        'PATH': os.environ.get('PATH', ''),
        # Only the bundle and the interpreter's own site-packages (the layer's stand-in).
        'PYTHONPATH': os.pathsep.join([str(root), sysconfig.get_paths()['purelib']]),
        'AWS_DEFAULT_REGION': 'us-east-1',
        'AWS_ACCESS_KEY_ID': 'testing',
        'AWS_SECRET_ACCESS_KEY': 'testing',
        'FEEDBACK_TABLE': 'feedback',
        'AGGREGATES_TABLE': 'aggregates',
        'POWERTOOLS_TRACE_DISABLED': 'true',
        'POWERTOOLS_METRICS_NAMESPACE': 'test',
    }
    return subprocess.run(
        [sys.executable, '-S', '-c', _PROBE],
        cwd=root, env=env, capture_output=True, text=True, timeout=60, check=False,
    )


def test_the_deployed_bundle_imports_with_validation_wired(tmp_path):
    _build_bundle(tmp_path)

    result = _run_probe(tmp_path)

    assert result.returncode == 0, result.stderr[-2000:]
    # Powertools logs to stdout at import; the probe's verdict is the last line.
    assert result.stdout.strip().splitlines()[-1] == 'ok'


def test_a_bundle_missing_the_schema_fails_at_import_rather_than_running_unvalidated(tmp_path):
    """The other half of #249: no silent fallback. Without the schema the
    handler must not import at all (a failed cold start is loud)."""
    _build_bundle(tmp_path)
    (tmp_path / 'shared' / 'ingest_schemas.py').unlink()

    result = _run_probe(tmp_path)

    assert result.returncode != 0
    assert 'ingest_schemas' in result.stderr
