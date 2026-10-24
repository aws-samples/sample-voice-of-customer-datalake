"""py_assembly: the bundling-command replay and the synth it mirrors.

Run: ``cd voc-datalake && .venv/bin/python -m pytest --no-cov ../scripts/audit``.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from audit_common import CDK_DIR, AuditError
from py_assembly import Assembly, Function, _functions, cache_key, emulate_bundle, python_modules, refs

from conftest import TreeMaker

PRUNE = ("find /asset-output -type d \\( -name 'test' -o -name '__pycache__' \\) -prune -exec rm -rf {} + && "
         "find /asset-output -type f \\( -name 'test_*.py' -o -name 'conftest.py' \\) -delete")


def _fn(script: str | None, source: str = 'lambda') -> Function:
    command = None if script is None else ['bash', '-c', script]
    return Function('S/Fn', 'python3.14', 'handler.lambda_handler', {}, None, asset_source=source, asset_command=command)


@pytest.fixture
def tree(make_tree: TreeMaker) -> Path:
    return make_tree({
        'lambda/api/metrics_handler.py': '', 'lambda/api/projects.py': '', 'lambda/api/prompts/a.json': '{}',
        'lambda/shared/__init__.py': '', 'lambda/shared/api.py': '', 'lambda/shared/test/test_api.py': '',
        'lambda/shared/__pycache__/api.cpython-312.pyc': '', 'lambda/processor/handler.py': '',
        'lambda/processor/test_handler.py': '', 'lambda/jobs/__init__.py': '', 'lambda/jobs/retention/handler.py': '',
    })


class TestTheReplay:
    def test_cp_into_a_directory_cp_contents_glob_conditional_and_prune(self, tree: Path) -> None:
        script = ('mkdir -p /asset-output/jobs && cp /asset-input/api/metrics_handler.py /asset-output/ && '
                  'cp -r /asset-input/shared /asset-output/ && '
                  'if [ -f /asset-input/api/projects.py ]; then cp /asset-input/api/projects.py /asset-output/; fi && '
                  'if [ -f /asset-input/api/missing.py ]; then cp /asset-input/api/missing.py /asset-output/; fi && '
                  'cp -r /asset-input/api/prompts /asset-output/prompts && '
                  'cp /asset-input/jobs/__init__.py /asset-output/jobs/ && '
                  'cp -r /asset-input/jobs/retention /asset-output/jobs/ && ' + PRUNE)
        bundle = emulate_bundle(tree, _fn(script))
        assert sorted(bundle.files) == [
            'jobs/__init__.py', 'jobs/retention/handler.py', 'metrics_handler.py', 'projects.py',
            'prompts/a.json', 'shared/__init__.py', 'shared/api.py']
        assert sorted(python_modules(bundle)) == [
            'jobs', 'jobs.retention.handler', 'metrics_handler', 'projects', 'shared', 'shared.api']

    def test_a_star_copy_lands_the_contents_at_the_root(self, tree: Path) -> None:
        bundle = emulate_bundle(tree, _fn('mkdir -p /asset-output && cp -r /asset-input/processor/* /asset-output/'))
        assert sorted(bundle.files) == ['handler.py', 'test_handler.py']   # no prune step: tests ship (pre-5.28)

    def test_a_copy_staged_asset_is_the_directory_minus_tests(self, tree: Path) -> None:
        bundle = emulate_bundle(tree, _fn(None, 'lambda/shared'))
        assert sorted(bundle.files) == ['__init__.py', 'api.py']

    def test_an_unknown_step_in_a_python_bundle_is_a_scan_error(self, tree: Path) -> None:
        with pytest.raises(AuditError, match='does not understand'):
            emulate_bundle(tree, _fn('pip install -r requirements.txt -t /asset-output'))


class TestIntrinsics:
    def test_refs_follow_ref_getatt_join_and_import_value(self) -> None:
        exports = {'Core:Table': 'Core/Table1'}
        value = {'Fn::Join': ['', [{'Fn::GetAtt': ['Q1', 'Arn']}, '/x', {'Ref': 'AWS::Region'},
                                   {'Fn::ImportValue': 'Core:Table'}, {'Ref': 'B1'}]]}
        assert sorted(refs(value, 'Api', exports)) == ['Api/B1', 'Api/Q1', 'Core/Table1']

    def test_exports_map_an_export_name_to_its_resource(self) -> None:
        assembly = Assembly({'Core': {'Resources': {}, 'Outputs': {
            'O': {'Value': {'Fn::GetAtt': ['T1', 'Arn']}, 'Export': {'Name': 'Core:T1Arn'}}}}}, {})
        assert assembly.exports() == {'Core:T1Arn': 'Core/T1'}


def test_the_synth_mirrors_the_cdk_test_helper() -> None:
    """Lockstep: py_assembly._synth reproduces lib/test-support/synth-app.ts. If the helper changes how it
    synthesizes (account, region, context, bundling), the audit synth must follow."""
    helper = (CDK_DIR / 'lib' / 'test-support' / 'synth-app.ts').read_text(encoding='utf-8')
    for needle in ("SYNTH_ACCOUNT = '111111111111'", "SYNTH_REGION = 'us-east-1'", "'aws:cdk:bundling-stacks': []",
                   'skipFrontendBuildCheck: true', 'cdk.context.json', 'TS_NODE_PREFER_TS_EXTS',
                   "join(PROJECT_ROOT, 'bin', 'voc-datalake.ts')"):
        assert needle in helper, needle


def _template(code: dict) -> dict:
    return {'Stack': {'Resources': {'Fn': {'Type': 'AWS::Lambda::Function', 'Properties': {
        'Runtime': 'python3.13', 'Handler': 'index.handler', 'Code': code}}}}}


@pytest.mark.parametrize(('source', 'external'), [
    ('lambda', False),
    ('node_modules/aws-cdk-lib/custom-resource-handlers/dist/aws-s3-deployment/bucket-deployment-handler', True),
])
def test_a_handler_cdk_stages_from_node_modules_is_external_not_repo_code(source: str, external: bool) -> None:
    """CI regression (5.30.00): BucketDeployment's handler is staged from voc-datalake/node_modules, inside the
    CDK dir; judging it as repo code reported its env vars as never set / never read."""
    records = [{'assetHash': 'abc', 'sourcePath': str(CDK_DIR / source), 'command': None}]
    functions = _functions(_template({'S3Bucket': 'b', 'S3Key': 'abc.zip'}), records, CDK_DIR)
    assert functions['Stack/Fn'].external is external


def test_the_cache_key_changes_with_the_cdk_lockfile(tmp_path: Path) -> None:
    (tmp_path / 'package-lock.json').write_text('{"v": 1}')
    before = cache_key(tmp_path)
    (tmp_path / 'package-lock.json').write_text('{"v": 2}')
    assert cache_key(tmp_path) != before
