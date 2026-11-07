/**
 * VocProcessingStack's push notices (docs/realtime.md): the stack deploys before the Event API, so its
 * publishers (the agent conductor, the job workers) learn the host from the SSM parameter VocApiStack
 * writes, read exactly that parameter, and hold NO appsync grant here (VocApiStack attaches their
 * publish grants, lib/stacks/api-realtime.test.ts). No other Lambda of this stack can publish.
 */
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { roleStatements } from '../test-support/iam-statements';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { byCodeUnit } from '../utils/compare';
import { REALTIME_HTTP_DNS_PARAMETER_ENV, realtimeParameterName } from '../utils/realtime';

const FunctionSchema = z.object({
  Properties: z.object({ FunctionName: z.unknown(), Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }) }),
});

/** Function base name → the logical id (prefix) of its role. */
const PUBLISHERS: Record<string, string> = {
  'voc-agent-conductor': 'AgentRuntimeAgentConductorRole',
  'voc-research-step': 'ResearchLambdaRole',
  'voc-category-reprocess': 'CategoryReprocessRole',
  'voc-retention': 'RetentionWorkerRetentionRole',
};

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

function environmentsWith(key: string): string[] {
  return Object.values(template.findResources('AWS::Lambda::Function'))
    .map((resource) => FunctionSchema.safeParse(resource).data?.Properties)
    .filter((props) => props !== undefined && key in props.Environment.Variables)
    .map((props) => JSON.stringify(props?.FunctionName));
}

describe('VocProcessingStack\'s realtime publishers', () => {
  it('only the publishers are told where the Event API endpoint parameter is', () => {
    const named = environmentsWith(REALTIME_HTTP_DNS_PARAMETER_ENV);
    const expected = Object.keys(PUBLISHERS).sort(byCodeUnit);
    expect(named).toHaveLength(expected.length);
    expect(expected.filter((name) => !named.some((fn) => fn.includes(name)))).toStrictEqual([]);
  });

  it.each(Object.entries(PUBLISHERS))('%s reads exactly that parameter', (_name, roleId) => {
    const statements = roleStatements(template, roleId, { byIdPrefix: true });
    const ssm = statements.filter((s) => s.actions.some((a) => a.startsWith('ssm:')));
    expect(ssm.map((s) => s.actions)).toStrictEqual([['ssm:GetParameter']]);
    expect(ssm[0]?.resource).toContain(`parameter${realtimeParameterName(undefined)}`);
  });

  it('publishes nothing from this stack', () => {
    expect(JSON.stringify(template.toJSON())).not.toContain('appsync:');
  });
});
