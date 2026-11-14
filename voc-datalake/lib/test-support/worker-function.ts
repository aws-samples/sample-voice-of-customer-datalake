/**
 * The Processing-stack worker suites (category reprocess, retention) find their
 * one function by name and pin its self hand-over grant the same way.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { expect } from 'vitest';
import { z } from 'zod';

import { itemAt } from './guards';
import type { NormalizedStatement } from './iam-statements';

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
