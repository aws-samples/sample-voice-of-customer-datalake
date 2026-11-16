/**
 * The agents' heartbeat and the engineering agents (7.47.00, agent-heartbeat-engineering.ts): with
 * `-c engineeringAgents=true` it may invoke voc-engineering-start (by name, nothing else of the runtime), read a run's
 * META in voc-engineering (GetItem on the runs' partitions only) and re-check an agent's owner in Cognito; without the
 * flag it has none of it.
 */
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const HEARTBEAT_ROLE = 'AgentRuntimeAgentHeartbeatRole';
const VariablesSchema = z.object({
  Properties: z.object({ Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }) }),
});

function heartbeatPolicies(template: Template): string {
  return JSON.stringify(template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(HEARTBEAT_ROLE) }]) },
  }));
}

function heartbeatEnv(template: Template): Record<string, unknown> {
  const [found] = Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([id]) => /^AgentRuntimeAgentHeartbeat[0-9A-F]{8}$/.test(id)).map(([, resource]) => resource);
  return VariablesSchema.parse(found).Properties.Environment.Variables;
}

/** The heartbeat's statement named ``sid``, as text. */
function statement(template: Template, sid: string): string {
  const policies = Object.values(template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(HEARTBEAT_ROLE) }]) },
  }));
  const found = policies.flatMap((policy) => z.object({ Properties: z.object({ PolicyDocument: z.object({
    Statement: z.array(z.record(z.string(), z.unknown())) }) }) }).parse(policy).Properties.PolicyDocument.Statement)
    .filter((entry) => entry.Sid === sid);
  return JSON.stringify(found);
}

describe('the heartbeat without the engineering agents', { timeout: SYNTH_TIMEOUT_MS }, () => {
  it('holds no grant and no setting of theirs', () => {
    const template = synthProcessingTemplate();
    expect(heartbeatPolicies(template)).not.toMatch(/StartEngineeringRuns|EngineeringRunStatus|cognito-idp/);
    expect(Object.keys(heartbeatEnv(template))).not.toContain('ENGINEERING_START_FUNCTION');
  });
});

describe('the heartbeat with -c engineeringAgents=true', { timeout: SYNTH_TIMEOUT_MS }, () => {
  let template: Template;
  beforeAll(() => {
    template = synthProcessingTemplate({ context: { engineeringAgents: 'true' } });
  }, SYNTH_TIMEOUT_MS);

  it('invokes voc-engineering-start by name and no other engineering function', () => {
    const start = statement(template, 'StartEngineeringRuns');
    expect(start).toMatch(/"Action":"lambda:InvokeFunction"/);
    expect(start).toMatch(/:function:voc-engineering-start/);
    expect(start).not.toMatch(/:\*"|\*"/);   // (unqualified: no version or alias wildcard)
    expect(heartbeatPolicies(template)).not.toMatch(/voc-engineering-(runtime|broker|board|cache)/);
  });

  it('reads an engineering run\'s META only: GetItem on the runs\' partitions', () => {
    const status = statement(template, 'EngineeringRunStatus');
    expect(status).toMatch(/"Action":"dynamodb:GetItem"/);
    expect(status).toMatch(/"Condition":\{"ForAllValues:StringLike":\{"dynamodb:LeadingKeys":\["WS#\*#RUN#\*"\]\}\}/);
  });

  it('re-checks an agent\'s owner in Cognito, read only', () => {
    const policies = heartbeatPolicies(template);
    expect(policies).toMatch(/"cognito-idp:AdminGetUser","cognito-idp:AdminListGroupsForUser"/);
    expect(policies).not.toMatch(/cognito-idp:Admin(Create|Delete|Update|Disable|Enable|AddUser|RemoveUser)/);
  });

  it('knows the start function, the module, the engineering table, the user pool and the run caps', () => {
    const env = heartbeatEnv(template);
    expect(env).toMatchObject({ ENGINEERING_AGENTS: 'on', ENGINEERING_RUN_CAP_USD: '50',
      ENGINEERING_RUN_TOKEN_CAP: '10000000' });
    expect(JSON.stringify(env.ENGINEERING_START_FUNCTION)).toMatch(/voc-engineering-start/);
    expect(Object.keys(env)).toStrictEqual(expect.arrayContaining(['ENGINEERING_TABLE', 'USER_POOL_ID']));
  });
});
