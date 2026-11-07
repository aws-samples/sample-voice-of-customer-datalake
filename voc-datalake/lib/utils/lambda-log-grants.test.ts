/**
 * removeAwsManagedPolicy (lib/utils/lambda-log-grants.ts): drops exactly the named AWS managed policy from a
 * role's `ManagedPolicyArns` and keeps every other one. The whole-app grants are in lib/lambda-log-grants.test.ts.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';

import { LAMBDA_BASIC_EXECUTION_POLICY, removeAwsManagedPolicy } from './lambda-log-grants';

function cfnRoleOf(role: iam.Role): iam.CfnRole {
  const cfn = role.node.defaultChild;
  if (!(cfn instanceof iam.CfnRole)) throw new Error('no CfnRole');
  return cfn;
}

function roleWith(policies: string[]): { stack: cdk.Stack; cfn: iam.CfnRole } {
  const stack = new cdk.Stack();
  const role = new iam.Role(stack, 'Role', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: policies.map((name) => iam.ManagedPolicy.fromAwsManagedPolicyName(name)),
  });
  return { stack, cfn: cfnRoleOf(role) };
}

const managedArn = (name: string): unknown => ({
  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::aws:policy/${name}`]],
});

describe('removeAwsManagedPolicy', () => {
  it('keeps the other managed policies', () => {
    const { stack, cfn } = roleWith([LAMBDA_BASIC_EXECUTION_POLICY, 'ReadOnlyAccess']);
    removeAwsManagedPolicy(cfn, LAMBDA_BASIC_EXECUTION_POLICY);
    expect(stack.resolve(cfn.managedPolicyArns)).toStrictEqual([managedArn('ReadOnlyAccess')]);
  });

  it('removes the property when the policy was the only one', () => {
    const { stack, cfn } = roleWith([LAMBDA_BASIC_EXECUTION_POLICY]);
    removeAwsManagedPolicy(cfn, LAMBDA_BASIC_EXECUTION_POLICY);
    const roles = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Role'));
    expect(roles.map((role) => JSON.stringify(role).includes('ManagedPolicyArns'))).toStrictEqual([false]);
  });

  it('leaves a role without the policy unchanged', () => {
    const { stack, cfn } = roleWith(['ReadOnlyAccess']);
    removeAwsManagedPolicy(cfn, LAMBDA_BASIC_EXECUTION_POLICY);
    expect(stack.resolve(cfn.managedPolicyArns)).toStrictEqual([managedArn('ReadOnlyAccess')]);
  });

  it('keeps a managed policy of ANOTHER stack as its import, not as a Ref to a resource this stack lacks', () => {
    const app = new cdk.App();
    const policyStack = new cdk.Stack(app, 'Policies');
    const shared = new iam.ManagedPolicy(policyStack, 'Shared', {
      statements: [new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: ['*'] })],
    });
    const stack = new cdk.Stack(app, 'Roles');
    const role = new iam.Role(stack, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName(LAMBDA_BASIC_EXECUTION_POLICY), shared],
    });
    removeAwsManagedPolicy(cfnRoleOf(role), LAMBDA_BASIC_EXECUTION_POLICY);
    const rendered = JSON.stringify(Template.fromStack(stack).findResources('AWS::IAM::Role'));
    expect(rendered).toContain('"Fn::ImportValue":"Policies:ExportsOutputRefShared');
    expect(rendered).not.toContain('{"Ref":"Shared');
    expect(rendered).not.toContain(LAMBDA_BASIC_EXECUTION_POLICY);
  });
});
