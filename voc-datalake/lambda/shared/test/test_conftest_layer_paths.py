"""lambda/conftest.py drops only the repo's own layer build output from sys.path (5.31.00 regression).

The old filter was a substring test (`'layers/' not in p`), so in a checkout whose path contained
"layers/" (a worktree named `k1-layers`) it also dropped the venv's site-packages and every test
failed to import boto3.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_CONFTEST = Path(__file__).resolve().parents[2] / 'conftest.py'


def _filter():
    spec = importlib.util.spec_from_file_location('lambda_root_conftest_under_test', _CONFTEST)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'cannot load {_CONFTEST}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.without_layer_builds


def test_a_checkout_path_containing_layers_keeps_the_venv(tmp_path):
    checkout = tmp_path / 'voc-wt' / 'k1-layers' / 'voc-datalake'
    layers = checkout / 'lambda' / 'layers'
    venv = str(checkout / '.venv' / 'lib' / 'python3.12' / 'site-packages')
    build = str(layers / 'processing-deps' / 'python')
    for d in (venv, build):
        Path(d).mkdir(parents=True)
    kept = _filter()([venv, build, str(checkout / 'lambda')], str(layers.resolve()))
    assert kept == [venv, str(checkout / 'lambda')]


def test_the_layers_directory_itself_and_the_empty_cwd_entry(tmp_path):
    layers = tmp_path / 'lambda' / 'layers'
    layers.mkdir(parents=True)
    kept = _filter()(['', str(layers), str(tmp_path / 'other-layers')], str(layers.resolve()))
    assert kept == ['', str(tmp_path / 'other-layers')]
