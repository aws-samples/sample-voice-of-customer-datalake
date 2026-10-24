"""py_iam_contract finds a planted unused grant and stays quiet on code-named and wiring grants."""
from __future__ import annotations

from audit_common import CDK_DIR
from py_iam_contract import findings, main
from py_reachability import analyse

from conftest import TreeMaker, assembly_of, lambda_function

COPY = 'cp /asset-input/api/app_handler.py /asset-output/'
HANDLER = '''
import os

def lambda_handler(event, context):
    table = os.environ['ORDERS_TABLE']
    remote = os.environ['CORE_TABLE']
    secret = 'voc-fixed-secret-name'          # a physical name in code
    return table, remote, secret, context.function_name
'''


def _policy(*statements: dict) -> dict:
    return {'Type': 'AWS::IAM::Policy', 'Properties': {
        'Roles': [{'Ref': 'Role1'}], 'PolicyDocument': {'Statement': list(statements)}}}


def _allow(action: str, resource: object) -> dict:
    return {'Effect': 'Allow', 'Action': [action], 'Resource': resource}


TEMPLATES = {
    'Core': {'Resources': {'Shared': {'Type': 'AWS::DynamoDB::Table', 'Properties': {}}},
             'Outputs': {'O': {'Value': {'Fn::GetAtt': ['Shared', 'Arn']}, 'Export': {'Name': 'Core:SharedArn'}}}},
    'Api': {'Resources': {
        'Role1': {'Type': 'AWS::IAM::Role', 'Properties': {}},
        'Orders': {'Type': 'AWS::DynamoDB::Table', 'Properties': {}},
        'Unused': {'Type': 'AWS::DynamoDB::Table', 'Properties': {}},
        'Unread': {'Type': 'AWS::DynamoDB::Table', 'Properties': {}},
        'Inbox': {'Type': 'AWS::SQS::Queue', 'Properties': {}},
        'Failures': {'Type': 'AWS::SQS::Queue', 'Properties': {}},
        'Secret': {'Type': 'AWS::SecretsManager::Secret', 'Properties': {'Name': 'voc-fixed-secret-name'}},
        'Key': {'Type': 'AWS::KMS::Key', 'Properties': {}},
        'Fn': {'Type': 'AWS::Lambda::Function', 'Properties': {}},
        'Mapping': {'Type': 'AWS::Lambda::EventSourceMapping', 'Properties': {
            'FunctionName': {'Ref': 'Fn'}, 'EventSourceArn': {'Fn::GetAtt': ['Inbox', 'Arn']},
            'DestinationConfig': {'OnFailure': {'Destination': {'Fn::GetAtt': ['Failures', 'Arn']}}}}},
        'Policy': _policy(
            _allow('dynamodb:GetItem', {'Fn::Join': ['', [{'Fn::GetAtt': ['Orders', 'Arn']}, '/index/*']]}),
            _allow('dynamodb:Query', {'Fn::ImportValue': 'Core:SharedArn'}),
            _allow('dynamodb:PutItem', {'Fn::GetAtt': ['Unused', 'Arn']}),
            _allow('dynamodb:PutItem', {'Fn::GetAtt': ['Unread', 'Arn']}),
            _allow('sqs:ReceiveMessage', {'Fn::GetAtt': ['Inbox', 'Arn']}),
            _allow('sqs:SendMessage', {'Fn::GetAtt': ['Failures', 'Arn']}),
            _allow('secretsmanager:GetSecretValue', {'Ref': 'Secret'}),
            _allow('kms:Decrypt', {'Fn::GetAtt': ['Key', 'Arn']}),
            _allow('lambda:InvokeFunction', {'Fn::GetAtt': ['Fn', 'Arn']}),
            {'Effect': 'Deny', 'Action': ['dynamodb:*'], 'Resource': {'Fn::GetAtt': ['Unused', 'Arn']}},
        ),
    }},
}


def test_planted_unused_grants_are_found_and_wiring_is_not(make_tree: TreeMaker) -> None:
    root = make_tree({'lambda/api/app_handler.py': HANDLER})
    fn = lambda_function('Api/Fn', 'app_handler.lambda_handler', COPY, role='Api/Role1', env={
        'ORDERS_TABLE': {'Ref': 'Orders'}, 'CORE_TABLE': {'Fn::ImportValue': 'Core:SharedArn'},
        'UNREAD_TABLE': {'Ref': 'Unread'}})
    assembly = assembly_of(fn, templates=TEMPLATES)
    found, judged = findings(assembly, analyse(root, assembly).functions)
    # Unused: no env, no name. Unread: an env var points at it, but the code never reads that var.
    assert sorted(f.key for f in found) == ['Api/Role1::Api/Unread', 'Api/Role1::Api/Unused']
    # judged: Orders, Shared, Unused, Unread, Secret, Fn (self invoke via context.function_name);
    # never judged: the event source + its on-failure queue (wiring) and the KMS key (not a named type).
    assert judged == 6


def test_vacuity_guard_on_the_real_tree() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
