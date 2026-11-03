/**
 * lib/utils/app-aspects.ts: the one helper bin/voc-datalake.ts and the per-stack test fixtures share applies every
 * whole-app rewrite, and reads its switches (`protectData`, `inferenceScope`) from the scope's context like bin/ does.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { applyAppAspects } from './app-aspects';

const ResourcesSchema = z.record(z.string(), z.object({
  DeletionPolicy: z.string().optional(),
  Properties: z.record(z.string(), z.unknown()).optional(),
}));

/** One function with a table grant, in a fresh app with `context`, rewritten by the helper. */
function synth(context: Record<string, unknown>, region = 'us-east-1'): Template {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, 'Fixture', { env: { account: '111111111111', region } });
  const table = new dynamodb.Table(stack, 'Table', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } });
  table.addGlobalSecondaryIndex({ indexName: 'gsi1', partitionKey: { name: 'g', type: dynamodb.AttributeType.STRING } });
  const fn = new lambda.Function(stack, 'Fn', {
    runtime: lambda.Runtime.PYTHON_3_14, handler: 'h.handler', code: lambda.Code.fromInline('def handler(e, c): pass'),
  });
  table.grantReadData(fn);
  applyAppAspects(app);
  return Template.fromStack(stack);
}

const resources = (template: Template, type: string) => ResourcesSchema.parse(template.findResources(type));

describe('applyAppAspects', () => {
  it('gives the function its own log group, retained by default (protectData on)', () => {
    const groups = Object.values(resources(synth({}), 'AWS::Logs::LogGroup'));
    expect(groups.map((group) => [group.DeletionPolicy, group.Properties?.RetentionInDays])).toStrictEqual([['Retain', 30]]);
  });

  it('deletes the log group with the stack under -c protectData=false', () => {
    const groups = Object.values(resources(synth({ protectData: false }), 'AWS::Logs::LogGroup'));
    expect(groups.map((group) => group.DeletionPolicy)).toStrictEqual(['Delete']);
  });

  it('rewrites the table grant to exact index ARNs', () => {
    const policies = JSON.stringify(resources(synth({}), 'AWS::IAM::Policy'));
    expect(policies).toContain('/index/gsi1');
    expect(policies).not.toContain('/index/*');
  });

  it('refuses a second application over the same constructs (the app, a stack inside it, or the app again)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Twice', { env: { account: '111111111111', region: 'us-east-1' } });
    applyAppAspects(stack);
    expect(() => applyAppAspects(stack)).toThrow(/already rewritten/);
    expect(() => applyAppAspects(app)).toThrow(/Twice overlaps|overlaps Twice/);
    const other = new cdk.Stack(new cdk.App(), 'Separate', { env: { account: '111111111111', region: 'us-east-1' } });
    expect(() => applyAppAspects(other)).not.toThrow();
  });

  it('sets the EU inference env under -c inferenceScope=eu, and nothing for the default scope', () => {
    const variables = (template: Template) => Object.values(resources(template, 'AWS::Lambda::Function'))
      .map((fn) => JSON.stringify(fn.Properties?.Environment ?? {}));
    expect(variables(synth({ inferenceScope: 'eu' }, 'eu-west-1')).join()).toContain('"BEDROCK_INFERENCE_SCOPE":"eu"');
    expect(variables(synth({})).join()).not.toContain('BEDROCK_INFERENCE_SCOPE');
  });
});
