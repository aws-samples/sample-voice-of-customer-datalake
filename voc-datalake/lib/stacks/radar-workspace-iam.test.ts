/**
 * Radar per workspace (docs/multi-workspace.md, decision 13; lambda/api/radar_handler.py,
 * lambda/jobs/radar_scan/handler.py): what each Radar role may do in a workspace.
 *
 * The Radar API resolves the request's workspace (the stack's resolution policy, the live platform-admin check) and
 * writes only settings rows, the deployment's or one workspace id's. The scan reads the platform's listing of
 * workspaces (that partition alone) and invokes only itself, once per workspace on the schedule's tick.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { apiTemplate, policyStatementsOf } from '../test-support/api-stack-template';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { findWorkerFunction } from '../test-support/worker-function';

const ONE_WORKSPACE = `ws_${'?'.repeat(26)}`;
const LikeSchema = z.object({ 'ForAllValues:StringLike': z.object({ 'dynamodb:LeadingKeys': z.array(z.string()) }) });
const EqualsSchema = z.object({
  'ForAllValues:StringEquals': z.object({ 'dynamodb:LeadingKeys': z.array(z.string()) }),
});

let processing: Template;
beforeAll(() => {
  apiTemplate();
  processing = synthProcessingTemplate({ withIndexes: true });
}, SYNTH_TIMEOUT_MS);

describe('the Radar API in a workspace', () => {
  const statements = () => policyStatementsOf(apiTemplate(), 'RadarLambdaRole');

  it("puts only settings rows: the deployment's and one workspace id's", () => {
    const puts = statements().filter((s) => s.actions.includes('dynamodb:PutItem') && s.resource.includes('Radar'));
    expect(puts.map((s) => LikeSchema.safeParse(s.condition).data?.['ForAllValues:StringLike']['dynamodb:LeadingKeys']
      ?? null)).toStrictEqual([['SETTINGS#radar', `WS#${ONE_WORKSPACE}#SETTINGS#radar`]]);
  });

  it("resolves the request's workspace and live-checks a platform admin's entry", () => {
    const actions = statements().flatMap((s) => s.actions);
    expect(actions).toStrictEqual(expect.arrayContaining(['cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser']));
    const env = z.object({ Properties: z.object({ Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }) }) })
      .parse(Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
        .find((resource) => JSON.stringify(resource).includes('radar_handler.lambda_handler')))
      .Properties.Environment.Variables;
    expect(Object.keys(env)).toStrictEqual(expect.arrayContaining(['WORKSPACES_TABLE', 'USER_POOL_ID']));
  });
});

describe('the Radar scan in a workspace', () => {
  const scan = () => findWorkerFunction(processing, 'voc-radar-scan-');
  const statements = () => policyStatementsOf(processing, `${scan().Role['Fn::GetAtt'][0].slice(0, -8)}DefaultPolicy`);

  it("queries only the platform's listing partition of voc-workspaces, and reads a workspace's status", () => {
    const onWorkspaces = statements().filter((s) => s.resource.includes('Workspaces'));
    const queries = onWorkspaces.filter((s) => s.actions.includes('dynamodb:Query'));
    expect(queries.map((s) => [s.actions, EqualsSchema.parse(s.condition)['ForAllValues:StringEquals']['dynamodb:LeadingKeys']]))
      .toStrictEqual([[['dynamodb:Query'], ['WORKSPACES']]]);
    // The status read before a workspace's scan writes (lib/utils/workspace-resolution-grants.ts): GetItem only.
    expect(onWorkspaces.filter((s) => !s.actions.includes('dynamodb:Query')).flatMap((s) => s.actions))
      .toStrictEqual(['dynamodb:GetItem']);
    expect(Object.keys(scan().Environment.Variables)).toContain('WORKSPACES_TABLE');
  });

  it('drops a run that waited over an hour (the next tick catches up)', () => {
    const configs = Object.values(processing.findResources('AWS::Lambda::EventInvokeConfig'))
      .filter((resource) => JSON.stringify(resource).includes('RadarScan'));
    expect(configs.map((resource) => z.object({ Properties: z.object({
      MaximumEventAgeInSeconds: z.number(), MaximumRetryAttempts: z.number() }) }).parse(resource).Properties))
      .toStrictEqual([{ MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 0 }]);
  });

  it('invokes only itself (the per-workspace runs of the tick)', () => {
    const invokes = statements().filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(invokes).toHaveLength(1);
    expect(invokes[0]?.resource).toContain('voc-radar-scan');
    expect(invokes[0]?.resource).not.toContain('*');
  });
});
