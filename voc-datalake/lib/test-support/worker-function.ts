/**
 * The Processing-stack worker suites (category reprocess, retention) find their
 * one function by name and pin its self hand-over grant the same way.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { expect } from 'vitest';
import { z } from 'zod';

import { byCodeUnit } from '../utils/compare';
import { itemAt } from './guards';
import { IamPolicySchema, isAttachedToRole, isAuditRowGuardStatement, statementActions } from './iam-statements';
import type { IamStatement, NormalizedStatement } from './iam-statements';

const WorkerFunctionSchema = z.object({
  Properties: z.object({
    FunctionName: z.unknown(),
    Handler: z.string(),
    Timeout: z.number(),
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
  }),
});

type WorkerFunction = z.infer<typeof WorkerFunctionSchema>['Properties'];

/** The single function whose FunctionName contains `nameFragment` (asserts exactly one). */
export function findWorkerFunction(template: Template, nameFragment: string): WorkerFunction {
  const matches = Object.values(template.findResources('AWS::Lambda::Function'))
    .map((fn) => WorkerFunctionSchema.safeParse(fn).data?.Properties)
    .filter((props) => JSON.stringify(props?.FunctionName ?? '').includes(nameFragment));
  expect(matches, `expected exactly one ${nameFragment} function`).toHaveLength(1);
  return WorkerFunctionSchema.shape.Properties.parse(itemAt(matches, 0));
}

const SettingsSchema = z.object({
  Properties: z.object({ MemorySize: z.number(), Timeout: z.number(), ReservedConcurrentExecutions: z.number() })
    .loose(),
});
const InvokeConfigSchema = z.object({
  Properties: z.object({
    FunctionName: z.object({ Ref: z.string() }), MaximumRetryAttempts: z.number(), MaximumEventAgeInSeconds: z.number(),
  }).loose(),
});

/** A self-invoking job's settings: `[memory MB, timeout s, reserved concurrency]` of the one function whose logical
 *  id starts with `logicalIdPrefix`, and each async invoke config of it as `[retries, maximum event age s]`. */
export function workerSettings(template: Template, logicalIdPrefix: string): {
  sizing: [number, number, number]; invokeConfigs: [number, number][];
} {
  const found = Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
  expect(found).toHaveLength(1);
  const [id, fn] = itemAt(found, 0);
  const { Properties: properties } = SettingsSchema.parse(fn);
  const invokeConfigs = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'))
    .map((resource) => InvokeConfigSchema.safeParse(resource).data?.Properties)
    .filter((config) => config?.FunctionName.Ref === id)
    .map((config): [number, number] => [config?.MaximumRetryAttempts ?? -1, config?.MaximumEventAgeInSeconds ?? -1]);
  return { sizing: [properties.MemorySize, properties.Timeout, properties.ReservedConcurrentExecutions], invokeConfigs };
}

/** The worker's single lambda:InvokeFunction statement, on itself by an unqualified colon-form ARN. */
export function expectSelfInvokeOnly(statements: readonly NormalizedStatement[], functionPrefix: string): void {
  const invokes = statements.filter((s) => s.actions.includes('lambda:InvokeFunction'));
  expect(invokes).toHaveLength(1);
  const { resource } = itemAt(invokes, 0);
  expect(resource).toContain(`:function:${functionPrefix}`);
  expect(resource).not.toContain('function/');
}

/**
 * Every statement of the policies attached to the role `roleId` (by `Roles: [{Ref}]`), as written: without the
 * audit-row guard's Denies (every writer's of voc-aggregates and voc-workspaces, pinned by audit-row-guard.test.ts),
 * or only those with `guard`.
 */
export function attachedStatements(template: Template, roleId: string, { guard = false } = {}): IamStatement[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .map((resource) => IamPolicySchema.parse(resource).Properties)
    .filter((policy) => isAttachedToRole(policy, roleId))
    .flatMap((policy) => policy.PolicyDocument.Statement)
    .filter((statement) => guard === isAuditRowGuardStatement(statement));
}

/** A role's statement as a worker spec pins it: its effect, its Sid, its actions sorted, its resource as JSON. */
export interface PinnedStatement { effect: string; sid: string | undefined; actions: string[]; resource: string; condition: unknown }

/** {@link attachedStatements}, each pinned ({@link PinnedStatement}). */
export function pinnedStatements(template: Template, roleId: string, { guard = false } = {}): PinnedStatement[] {
  return attachedStatements(template, roleId, { guard }).map((statement) => ({
    effect: statement.Effect ?? 'Allow', sid: statement.Sid, actions: [...statementActions(statement)].sort(byCodeUnit),
    resource: JSON.stringify(statement.Resource), condition: statement.Condition,
  }));
}

/** A Lambda function's properties, read loosely. */
export const FunctionPropertiesSchema = z.object({ Properties: z.record(z.string(), z.unknown()) });
/** A function's async invoke config: the function it names and its retries (any event age). */
export const RetryConfigSchema = z.object({
  Properties: z.object({ FunctionName: z.object({ Ref: z.string() }), MaximumRetryAttempts: z.number() }).loose(),
});
/** An EventBridge rule's schedule and its one target's input. */
export const ScheduleSchema = z.object({
  Properties: z.object({ ScheduleExpression: z.string(), Targets: z.tuple([z.object({ Input: z.string() })]) }),
}).transform(({ Properties }) => ({ expression: Properties.ScheduleExpression, input: Properties.Targets[0].Input }));

