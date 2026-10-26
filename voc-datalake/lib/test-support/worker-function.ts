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

export type WorkerFunction = z.infer<typeof WorkerFunctionSchema>['Properties'];

/** The single function whose FunctionName contains `nameFragment` (asserts exactly one). */
export function findWorkerFunction(template: Template, nameFragment: string): WorkerFunction {
  const matches = Object.values(template.findResources('AWS::Lambda::Function'))
    .map((fn) => WorkerFunctionSchema.safeParse(fn).data?.Properties)
    .filter((props) => JSON.stringify(props?.FunctionName ?? '').includes(nameFragment));
  expect(matches, `expected exactly one ${nameFragment} function`).toHaveLength(1);
  return WorkerFunctionSchema.shape.Properties.parse(itemAt(matches, 0));
}

/** The worker's single lambda:InvokeFunction statement, on itself by an unqualified colon-form ARN. */
export function expectSelfInvokeOnly(statements: readonly NormalizedStatement[], functionPrefix: string): void {
  const invokes = statements.filter((s) => s.actions.includes('lambda:InvokeFunction'));
  expect(invokes).toHaveLength(1);
  const { resource } = itemAt(invokes, 0);
  expect(resource).toContain(`:function:${functionPrefix}`);
  expect(resource).not.toContain('function/');
}
