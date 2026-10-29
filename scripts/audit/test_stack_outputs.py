"""stack_outputs reports an output a script reads that no stack declares, and every legitimate read shape passes."""
from __future__ import annotations

import pytest
from audit_common import REPO, AuditError
from stack_outputs import declared_outputs, findings, main, reads_in

from conftest import TreeMaker

STACK = '''
new cdk.CfnOutput(this, 'ApiEndpoint', { value: url });
new cdk.CfnOutput(scope, 'FeedbackTableName', { value: t });
new cdk.CfnOutput(scope, `InboundEmailDkimRecord${index + 1}`, { value: r });
new cdk.CfnOutput(this, 'WebsiteURLOut', { value: w });
'''
SHELL = '''
output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \\
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
API=$(output ApiEndpoint)
GONE=$(output ChatStreamUrl)
ALSO=$(echo "$OUT" | jq -r '.[] | select(.OutputKey=="ApiEndpoint") | .OutputValue')
URL=$(echo "$OUT" | jq -r '.[] | select(.OutputKey | contains("WebsiteURL")) | .OutputValue')
DKIM=$(echo "$OUT" | jq -r '.[] | select(.OutputKey=="InboundEmailDkimRecord2") | .OutputValue')
'''
PYTHON = '''
def _stack_output(cloudformation, stack, key):
    for output in cloudformation.describe_stacks(StackName=stack)['Stacks'][0]['Outputs']:
        if output.get('OutputKey') == key:
            return output['OutputValue']

name = _stack_output(cf, 'VocCoreStack', 'FeedbackTableName')
gone = _stack_output(cf, 'VocCoreStack', 'OldTableName')
'''
DOC = "aws cloudformation describe-stacks --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue'\n"


def _tree(make_tree: TreeMaker, extra: dict[str, str] | None = None):
    return make_tree({'voc-datalake/lib/stacks/x-stack.ts': STACK, 'voc-datalake/scripts/x.sh': SHELL,
                      'voc-datalake/scripts/x.py': PYTHON, 'docs/x.md': DOC, **(extra or {})})


def test_reads_no_stack_declares_are_found(make_tree: TreeMaker) -> None:
    root = _tree(make_tree, {'voc-datalake/scripts/test_x.py': PYTHON.replace('OldTableName', 'TestOnlyName')})
    exact, prefixes = declared_outputs(root)
    reads, _ = reads_in(root)
    assert [f.key for f in findings(reads, exact, prefixes)] == ['ChatStreamUrl', 'OldTableName']


def test_every_read_shape_is_seen(make_tree: TreeMaker) -> None:
    reads, scanned = reads_in(_tree(make_tree))
    assert scanned == 3
    assert sorted({r.key for r in reads}) == [
        'ApiEndpoint', 'ChatStreamUrl', 'FeedbackTableName', 'InboundEmailDkimRecord2', 'OldTableName', 'WebsiteURL']


def test_an_option_named_like_the_helper_is_not_a_call(make_tree: TreeMaker) -> None:
    root = make_tree({'s.sh': SHELL.split('API=')[0] + 'aws x --output text\n'})
    assert reads_in(root)[0] == []


def test_a_tree_with_no_stacks_trips_the_vacuity_guard(make_tree: TreeMaker) -> None:
    root = _tree(make_tree)
    with pytest.raises(AuditError, match='vacuity'):
        main(['--root', str(root)])


def test_the_real_tree_is_clean() -> None:
    assert main(['--root', str(REPO)]) == 0
