"""py_env_contract finds planted env mismatches and stays quiet on the legitimate shapes."""
from __future__ import annotations

import pytest
from audit_common import CDK_DIR
from py_env_contract import findings, main
from py_reachability import analyse

from conftest import TreeMaker, assembly_of, lambda_function

COPY = 'cp /asset-input/api/app_handler.py /asset-output/ && cp -r /asset-input/shared /asset-output/'
HANDLER = '''
import os
from shared import tables

TABLE = os.environ.get('TABLE_NAME', '')                    # '' import-time pattern on an always-set var
ORIGIN = os.environ.get('ALLOWED_ORIGIN', '*')              # non-empty fallback the CDK always overrides
QUEUE_ENV = 'QUEUE_URL'

def lambda_handler(event, context):
    region = os.environ['AWS_REGION']                        # runtime-provided
    knob = os.environ.get('TUNING_KNOB', '5')                # read, never set by any synth
    bucket = os.environ['BUCKET_NAME']                       # fatal read, never set
    queue = os.environ.get(QUEUE_ENV, '')                    # read through a constant
    optional = os.environ.get('OPTIONAL_FEATURE', 'off')     # set only by the gated synth: a live fallback
    return region, knob, bucket, queue, optional, tables.name(), TABLE, ORIGIN

def _dead_reader():
    return os.environ['ONLY_IN_DEAD_CODE']
'''
TABLES = "import os\n\ndef name():\n    return os.getenv('SHARED_TABLE', '')\n"
ENV = {'TABLE_NAME': 't', 'ALLOWED_ORIGIN': 'https://x', 'QUEUE_URL': 'q', 'SHARED_TABLE': 's',
       'UNUSED_KEY': 'u', 'ONLY_IN_DEAD_CODE': 'd', 'POWERTOOLS_SERVICE_NAME': 'svc', 'LOG_LEVEL': 'INFO'}


@pytest.fixture
def result(make_tree: TreeMaker) -> dict[str, str]:
    root = make_tree({'lambda/api/app_handler.py': HANDLER, 'lambda/shared/__init__.py': '',
                      'lambda/shared/tables.py': TABLES})
    fn = lambda_function('Api/Fn', 'app_handler.lambda_handler', COPY, env={**ENV, 'OPTIONAL_FEATURE': 'on'})
    fn.default_env = set(ENV) | {'OPTIONAL_FEATURE'}
    fn.gated_env = set(ENV)          # the gated synth turns the optional feature OFF
    return {f.key: f.kind for f in findings(analyse(root, assembly_of(fn)))}


def test_planted_mismatches_are_found(result: dict[str, str]) -> None:
    assert result == {
        'Api/Fn::UNUSED_KEY': 'set-never-read',
        'Api/Fn::ONLY_IN_DEAD_CODE': 'set-never-read',          # read only by a def no entry reaches
        'Api/Fn::TUNING_KNOB': 'read-never-set',
        'Api/Fn::BUCKET_NAME': 'read-never-set-fatal',
        'lambda/api/app_handler.py::<module>::ALLOWED_ORIGIN': 'dead-fallback',
        'lambda/api/app_handler.py::<module>::TABLE_NAME': 'dead-fallback-empty',
        'lambda/api/app_handler.py::lambda_handler::QUEUE_URL': 'dead-fallback-empty',
        'lambda/shared/tables.py::name::SHARED_TABLE': 'dead-fallback-empty',
    }


def test_runtime_library_and_optional_vars_stay_quiet(result: dict[str, str]) -> None:
    for quiet in ('AWS_REGION', 'POWERTOOLS_SERVICE_NAME', 'LOG_LEVEL', 'OPTIONAL_FEATURE'):
        assert not [k for k in result if quiet in k], quiet


def test_vacuity_guard_on_the_real_tree() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
