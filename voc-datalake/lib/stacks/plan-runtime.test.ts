/**
 * Plan mode infrastructure in VocProcessingStack (docs/assistant-plan-mode.md → "Runtime"):
 * voc-plan-step and the conductor's plan grants. What is pinned, and why:
 *   - voc-plan-step reaches data and writes ONLY through the domain API Lambdas, by unqualified
 *     name — exactly PLAN_STEP_DELEGATES — and holds no table write at all (aggregates GetItem +
 *     Query, feedback read for think steps); it runs S's real handler, bundled like the assistant;
 *   - the state machine (not the conductor) invokes voc-plan-step: the conductor never runs a write;
 *   - the conductor re-checks the approver in Cognito with exactly the two read actions it calls.
 */
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { itemAt } from '../test-support/guards';
import { roleStatements, type NormalizedStatement } from '../test-support/iam-statements';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { byCodeUnit } from '../utils/compare';
import { USERS_API_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PLAN_STEP_DELEGATES } from './plan-step-lambda';

/** The fields of one synthesized function these assertions read. */
const PlanFunctionFields = z.object({
  FunctionName: z.unknown(),
  Runtime: z.string(),
  Architectures: z.array(z.string()),
  Timeout: z.number(),
  MemorySize: z.number(),
  Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
});
type LambdaProps = z.infer<typeof PlanFunctionFields>;

function lambdaNamed(template: Template, baseName: string): LambdaProps {
  const found = Object.values(template.findResources('AWS::Lambda::Function'))
    .map((resource) => PlanFunctionFields.safeParse(z.object({ Properties: z.unknown() }).parse(resource).Properties).data)
    .filter((props): props is LambdaProps => props !== undefined
      && JSON.stringify(props.FunctionName).includes(`${baseName}-`));
  expect(found, baseName).toHaveLength(1);
  return itemAt(found, 0);
}

function policyOf(template: Template, rolePrefix: string): NormalizedStatement[] {
  return roleStatements(template, rolePrefix, { byIdPrefix: true });
}

function actions(statements: NormalizedStatement[], prefix: string): string[] {
  return [...new Set(statements.flatMap((s) => s.actions).filter((a) => a.startsWith(prefix)))].sort(byCodeUnit);
}

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

describe('voc-plan-step (VocProcessingStack)', () => {
  it('is an ARM64 Node.js 24 function sized like the assistant, with a 300 s timeout', () => {
    const fn = lambdaNamed(template, 'voc-plan-step');
    expect([fn.Runtime, fn.Architectures]).toStrictEqual(['nodejs24.x', ['arm64']]);
    expect([fn.Timeout, fn.MemorySize]).toStrictEqual([300, 1024]);
  });

  it('names every delegate API and the aggregates table in its environment', () => {
    const variables = Object.keys(lambdaNamed(template, 'voc-plan-step').Environment.Variables);
    expect(variables).toStrictEqual(expect.arrayContaining([...Object.keys(PLAN_STEP_DELEGATES), 'AGGREGATES_TABLE', 'FEEDBACK_TABLE']));
  });

  it('has nine delegates: the assistant\'s eight without the Users API, + integrations + feedback edit', () => {
    expect(Object.keys(PLAN_STEP_DELEGATES)).toHaveLength(9);
    expect(Object.keys(PLAN_STEP_DELEGATES)).toStrictEqual(expect.arrayContaining(['INTEGRATIONS_FUNCTION', 'FEEDBACK_EDIT_FUNCTION']));
    expect(Object.keys(PLAN_STEP_DELEGATES)).not.toContain('USERS_FUNCTION');
  });

  it('can neither name nor invoke the Users API', () => {
    const variables = Object.keys(lambdaNamed(template, 'voc-plan-step').Environment.Variables);
    const invoke = policyOf(template, 'AgentRuntimePlanStepRole').filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(variables).not.toContain('USERS_FUNCTION');
    expect(invoke.map((s) => s.resource).join(' ')).not.toContain(`:function:${USERS_API_FUNCTION_BASE_NAME}-`);
  });

  it('invokes exactly the delegate APIs, by unqualified name', () => {
    const invoke = policyOf(template, 'AgentRuntimePlanStepRole').filter((s) => s.actions.includes('lambda:InvokeFunction'));
    const named = Object.values(PLAN_STEP_DELEGATES).filter((base) => invoke.some((s) => s.resource.includes(`:function:${base}-`)));
    expect(named).toStrictEqual(Object.values(PLAN_STEP_DELEGATES));
    expect(invoke.map((s) => s.resource).join(' ')).not.toContain(':*');
  });

  it('holds only table reads: aggregates GetItem + Query and the feedback table read', () => {
    const dynamo = policyOf(template, 'AgentRuntimePlanStepRole').filter((s) => s.actions.some((a) => a.startsWith('dynamodb:')));
    const writes = dynamo.flatMap((s) => s.actions).filter((a) => /Put|Update|Delete|Write/.test(a));
    expect(writes).toStrictEqual([]);
    expect(actions(dynamo, 'dynamodb:')).toStrictEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Query']));
  });

  it('invokes Bedrock on the allowlisted models only', () => {
    const bedrock = policyOf(template, 'AgentRuntimePlanStepRole').filter((s) => s.actions.some((a) => a.startsWith('bedrock:')));
    expect(actions(bedrock, 'bedrock:')).toStrictEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(bedrock.map((s) => s.resource).join(' ')).not.toMatch(/foundation-model\/\*|inference-profile\/\*/);
  });

  it('is invoked by the state machine, never by the conductor', () => {
    const machine = policyOf(template, 'AgentRuntimeAgentRunStateMachineRole')
      .filter((s) => s.actions.includes('lambda:InvokeFunction')).map((s) => s.resource).join(' ');
    const conductor = policyOf(template, 'AgentRuntimeAgentConductorRole')
      .filter((s) => s.actions.includes('lambda:InvokeFunction')).map((s) => s.resource).join(' ');
    expect(machine).toContain('AgentRuntimePlanStep');
    expect(conductor).not.toContain('PlanStep');
  });
});

describe('the conductor for plans (VocProcessingStack)', () => {
  it('re-checks the approver with exactly AdminGetUser + AdminListGroupsForUser on the user pool', () => {
    const cognito = policyOf(template, 'AgentRuntimeAgentConductorRole').filter((s) => s.actions.some((a) => a.startsWith('cognito-idp:')));
    expect(actions(cognito, 'cognito-idp:')).toStrictEqual(['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser']);
    expect(cognito.map((s) => s.resource).join(' ')).toContain('UserPool');
  });

  it('gets the user pool id and the jobs table in its environment', () => {
    const variables = lambdaNamed(template, 'voc-agent-conductor').Environment.Variables;
    expect(Object.keys(variables)).toStrictEqual(expect.arrayContaining(['USER_POOL_ID', 'JOBS_TABLE']));
  });
});
