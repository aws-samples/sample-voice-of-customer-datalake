"""py_sfn_errors finds a retry on an alias name and stays quiet on real classes, builtins and service names."""
from __future__ import annotations

import json

from audit_common import CDK_DIR
from py_sfn_errors import findings, main

from conftest import TreeMaker, assembly_of, lambda_function

COPY = 'cp /asset-input/research/step.py /asset-output/ && cp -r /asset-input/shared /asset-output/'
ERRORS = '''
class ThrottledError(Exception):
    """What the step raises."""
'''
STEP = '''
from shared.errors import ThrottledError

ThrottledException = ThrottledError   # an alias: __name__ stays ThrottledError

def lambda_handler(event, context):
    raise ThrottledError('slow down')
'''


def _task(names: list[str], *, catch: list[str] | None = None) -> dict:
    return {'Type': 'Task', 'Resource': 'arn:aws:states:::lambda:invoke',
            'Parameters': {'FunctionName': '@@FN@@', 'Payload.$': '$'},
            'Retry': [{'ErrorEquals': names}], 'Catch': [{'ErrorEquals': catch or ['States.ALL'], 'Next': 'Done'}],
            'End': True}


def _join_definition(states: dict) -> dict:
    """The Fn::Join shape CDK synthesizes when the definition names a function by GetAtt."""
    text = json.dumps({'StartAt': next(iter(states)), 'States': states})
    head, *tails = text.split('@@FN@@')
    pieces: list[object] = [head]
    for tail in tails:
        pieces += [{'Fn::GetAtt': ['Fn', 'Arn']}, tail]
    return {'Fn::Join': ['', pieces]}


def _templates(definition: object, substitutions: dict | None = None) -> dict:
    props: dict[str, object] = {'DefinitionString': definition}
    if substitutions:
        props['DefinitionSubstitutions'] = substitutions
    return {'Proc': {'Resources': {
        'Fn': {'Type': 'AWS::Lambda::Function', 'Properties': {}},
        'Machine': {'Type': 'AWS::StepFunctions::StateMachine', 'Properties': props},
    }}}


def _tree(make_tree: TreeMaker):
    return make_tree({'lambda/research/step.py': STEP, 'lambda/shared/__init__.py': '',
                      'lambda/shared/errors.py': ERRORS})


def test_a_retry_on_the_alias_is_reported_with_the_real_name(make_tree: TreeMaker) -> None:
    root = _tree(make_tree)
    fn = lambda_function('Proc/Fn', 'step.lambda_handler', COPY)
    states = {'Analyze': _task(['Lambda.ServiceException', 'States.Timeout', 'ThrottledException']), 'Done': {
        'Type': 'Succeed'}}
    found, judge = findings(root, assembly_of(fn, templates=_templates(_join_definition(states))))
    assert [f.key for f in found] == ['Proc/Machine::ThrottledException']
    assert 'an alias of ThrottledError; Lambda reports ThrottledError' in found[0].detail
    assert judge.judged == 1


def test_real_classes_builtins_and_service_names_pass(make_tree: TreeMaker) -> None:
    root = _tree(make_tree)
    fn = lambda_function('Proc/Fn', 'step.lambda_handler', COPY)
    # A plain-string definition with ${Name} substitutions (the agent runtime's shape), nested in a Map.
    inner = {'StartAt': 'Step', 'States': {'Step': {
        **_task(['ThrottledError', 'Sandbox.Timedout'], catch=['ValueError']),
        'Parameters': {'FunctionName': '${StepArn}'}}}}
    definition = json.dumps({'StartAt': 'Each', 'States': {'Each': {'Type': 'Map', 'ItemProcessor': inner,
                                                                    'End': True}}})
    found, judge = findings(root, assembly_of(fn, templates=_templates(
        definition, {'StepArn': {'Fn::GetAtt': ['Fn', 'Arn']}})))
    assert found == []
    assert judge.judged == 2   # ThrottledError (retry) and ValueError (catch)


def test_the_real_tree_is_clean() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
