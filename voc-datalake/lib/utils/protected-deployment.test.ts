/**
 * A protected deployment (`-c protectData`, on by default) keeps its evidence and resists a one-step teardown
 * (WA SEC04-BP01 / SEC10-BP03, findings OPS-6 and OPS-9); an unprotected (`-c protectData=false`, demo)
 * deployment stays fully disposable. Every log keeps 30 days either way (LOG_RETENTION).
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import { applyProtectedLogRetention, LOG_RETENTION } from './log-retention';
import { shouldProtectData } from './data-protection';
import { VocStack } from './voc-stack';

function deployment(protectData: boolean | undefined): { stack: VocStack; template: Template } {
  const app = new cdk.App({ context: protectData === undefined ? {} : { protectData } });
  const stack = new VocStack(app, 'Fixture', {});
  new logs.LogGroup(stack, 'Group', { retention: LOG_RETENTION, removalPolicy: cdk.RemovalPolicy.DESTROY });
  applyProtectedLogRetention(app, shouldProtectData(app.node.tryGetContext('protectData')));
  return { stack, template: Template.fromStack(stack) };
}

describe('a protected deployment', () => {
  it('keeps every log group 30 days, like every log, and retains it on stack deletion', () => {
    const groups = Object.values(deployment(true).template.findResources('AWS::Logs::LogGroup'));
    expect(groups).toStrictEqual([expect.objectContaining({
      Properties: { RetentionInDays: 30 },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    })]);
  });

  it('turns on stack termination protection', () => {
    expect(deployment(true).stack.terminationProtection).toBe(true);
  });

  it('is the default when no protectData context is given', () => {
    const { stack, template } = deployment(undefined);
    expect(stack.terminationProtection).toBe(true);
    expect(Object.values(template.findResources('AWS::Logs::LogGroup'))).toStrictEqual([
      expect.objectContaining({ DeletionPolicy: 'Retain' }),
    ]);
  });
});

describe('an unprotected deployment (-c protectData=false, demos)', () => {
  it('keeps its log groups 30 days and deletes them with the stack', () => {
    const groups = Object.values(deployment(false).template.findResources('AWS::Logs::LogGroup'));
    expect(groups).toStrictEqual([expect.objectContaining({ Properties: { RetentionInDays: 30 }, DeletionPolicy: 'Delete' })]);
  });

  it('leaves termination protection off, so a teardown is one step', () => {
    expect(deployment(false).stack.terminationProtection).toBe(false);
  });
});
