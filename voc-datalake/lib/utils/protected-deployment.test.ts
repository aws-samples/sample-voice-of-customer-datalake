/**
 * A protected (`-c protectData=true`) deployment keeps its evidence and resists a one-step teardown
 * (WA SEC04-BP01 / SEC10-BP03, findings OPS-6 and OPS-9); a demo deployment stays fully disposable.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';
import { applyProtectedLogRetention, PROTECTED_LOG_RETENTION_DAYS } from './log-retention';
import { shouldProtectData } from './data-protection';
import { VocStack } from './voc-stack';

function deployment(protectData: boolean): { stack: VocStack; template: Template } {
  const app = new cdk.App({ context: { protectData } });
  const stack = new VocStack(app, 'Fixture', {});
  new logs.LogGroup(stack, 'Group', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY });
  applyProtectedLogRetention(app, shouldProtectData(app.node.tryGetContext('protectData')));
  return { stack, template: Template.fromStack(stack) };
}

describe('a protected deployment', () => {
  it('keeps every log group a year and retains it on stack deletion', () => {
    const groups = Object.values(deployment(true).template.findResources('AWS::Logs::LogGroup'));
    expect(groups).toStrictEqual([expect.objectContaining({
      Properties: { RetentionInDays: PROTECTED_LOG_RETENTION_DAYS },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    })]);
  });

  it('turns on stack termination protection', () => {
    expect(deployment(true).stack.terminationProtection).toBe(true);
  });
});

describe('a demo deployment (the default)', () => {
  it('keeps its log groups two weeks and deletes them with the stack', () => {
    const groups = Object.values(deployment(false).template.findResources('AWS::Logs::LogGroup'));
    expect(groups).toStrictEqual([expect.objectContaining({ Properties: { RetentionInDays: logs.RetentionDays.TWO_WEEKS }, DeletionPolicy: 'Delete' })]);
  });

  it('leaves termination protection off, so a teardown is one step', () => {
    expect(deployment(false).stack.terminationProtection).toBe(false);
  });
});
