/**
 * The agent conductor's push notices (docs/realtime.md): VocProcessingStack deploys before the Event API,
 * so the conductor learns the host from the SSM parameter VocApiStack writes, reads exactly that
 * parameter, and holds NO appsync grant here (VocApiStack attaches its `runs` publish grant,
 * lib/stacks/api-realtime.test.ts). No other runtime Lambda can publish.
 */
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { roleStatements } from '../test-support/iam-statements';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { REALTIME_HTTP_DNS_PARAMETER_ENV, realtimeParameterName } from '../utils/realtime';

const FunctionSchema = z.object({
  Properties: z.object({ FunctionName: z.unknown(), Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }) }),
});

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

function environmentsWith(key: string): string[] {
  return Object.values(template.findResources('AWS::Lambda::Function'))
    .map((resource) => FunctionSchema.safeParse(resource).data?.Properties)
    .filter((props) => props !== undefined && key in props.Environment.Variables)
    .map((props) => JSON.stringify(props?.FunctionName));
}

describe('the conductor\'s realtime notices (VocProcessingStack)', () => {
  it('only the conductor is told where the Event API endpoint parameter is', () => {
    const named = environmentsWith(REALTIME_HTTP_DNS_PARAMETER_ENV);
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('voc-agent-conductor');
  });

  it('reads exactly that parameter, and publishes nothing from this stack', () => {
    const statements = roleStatements(template, 'AgentRuntimeAgentConductorRole', { byIdPrefix: true });
    const ssm = statements.filter((s) => s.actions.some((a) => a.startsWith('ssm:')));
    expect(ssm.map((s) => s.actions)).toStrictEqual([['ssm:GetParameter']]);
    expect(ssm[0]?.resource).toContain(`parameter${realtimeParameterName(undefined)}`);
    expect(JSON.stringify(template.toJSON())).not.toContain('appsync:');
  });
});
