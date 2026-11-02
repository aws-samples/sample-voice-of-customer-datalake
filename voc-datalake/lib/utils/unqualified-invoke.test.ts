/**
 * lib/utils/unqualified-invoke.ts (through applyExactGrants): CDK's `<function arn>:*` companion grant is dropped
 * only when no version or alias of the function exists, and only beside the function's own ARN.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { applyExactGrants } from './exact-grants';

const env = { account: '111111111111', region: 'us-east-1' };

const PoliciesSchema = z.record(z.string(), z.object({
  Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(z.object({ Resource: z.unknown() })) }) }),
}));

function invokeFixture() {
  const app = new cdk.App();
  const producer = new cdk.Stack(app, 'Producer', { env });
  const consumer = new cdk.Stack(app, 'Consumer', { env });
  const fn = (id: string) => new lambda.Function(producer, id, {
    runtime: lambda.Runtime.PYTHON_3_14, handler: 'h.handler', code: lambda.Code.fromInline('def handler(e, c): pass'),
  });
  const role = new iam.Role(consumer, 'Caller', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  return { app, consumer, fn, role };
}

/** The Resource entries of the role's default policy, as JSON strings. */
function grantedResources(stack: cdk.Stack): string[] {
  const policies = PoliciesSchema.parse(Template.fromStack(stack).findResources('AWS::IAM::Policy'));
  return Object.values(policies).flatMap((policy) => policy.Properties.PolicyDocument.Statement)
    .flatMap((statement) => (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]))
    .map((resource) => JSON.stringify(resource));
}

const qualifierWildcards = (resources: readonly string[]) => resources.filter((resource) => resource.includes(':*'));

describe('the version/alias wildcard of grantInvoke', () => {
  it('is dropped for a function with no version or alias, cross-stack, keeping the function ARN', () => {
    const { app, consumer, fn, role } = invokeFixture();
    fn('Job').grantInvoke(role);
    applyExactGrants(app);
    const resources = grantedResources(consumer);
    expect(qualifierWildcards(resources)).toStrictEqual([]);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toContain('ExportsOutputFnGetAttJob');
  });

  it('is kept for a function with an alias (SnapStart\'s `live`), so a qualified invoke still works', () => {
    const { app, consumer, fn, role } = invokeFixture();
    const job = fn('Aliased');
    new lambda.Alias(job, 'LiveAlias', { aliasName: 'live', version: job.currentVersion });
    job.grantInvoke(role);
    applyExactGrants(app);
    expect(qualifierWildcards(grantedResources(consumer))).toHaveLength(1);
  });

  it('is kept when it is the only resource (no companion function ARN) or the statement grants more than Lambda', () => {
    const { app, consumer, fn, role } = invokeFixture();
    const job = fn('Lone');
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [`${job.functionArn}:*`] }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction', 'logs:PutLogEvents'], resources: [job.functionArn, `${job.functionArn}:*`],
    }));
    applyExactGrants(app);
    expect(qualifierWildcards(grantedResources(consumer))).toHaveLength(2);
  });
});
