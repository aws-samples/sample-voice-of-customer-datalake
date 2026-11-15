/**
 * Every attribute-limited grant on voc-workspaces names both key attributes, across every stack.
 *
 * DynamoDB counts a request's `Key` in `dynamodb:Attributes`: a `ForAllValues:StringEquals` list without `sk` refuses
 * every GetItem of the table (its key is `pk` + `sk`), whatever the projection. 7.14.00's `PLUGIN_ROW_KEY = ['pk']`
 * (lib/utils/workspace-resolution-grants.ts) did exactly that, and every "Run now" in a workspace answered
 * "Failed to open the workspace" (fixed in 7.40.00). The unit tests mock DynamoDB, so only the template can say it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ALL_FEATURES_CONTEXT } from './test-support/all-features-context';
import { cleanupAssemblyDirs, HARD_DELETE_BUILD, synthApp, SYNTH_TIMEOUT_MS } from './test-support/synth-app';

afterAll(cleanupAssemblyDirs);

const StatementSchema = z.object({
  Resource: z.unknown().optional(),
  Condition: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).loose();
type Statement = z.infer<typeof StatementSchema>;
const TemplateSchema = z.object({
  Resources: z.record(z.string(), z.object({
    Type: z.string().optional(),
    Properties: z.object({
      PolicyDocument: z.object({ Statement: z.array(StatementSchema).optional() }).loose().optional(),
    }).loose().optional(),
  }).loose()).optional(),
}).loose();

/** Every IAM statement of every policy in `template`, with the logical id of its policy. */
function statements(template: unknown): { policy: string; statement: Statement }[] {
  const resources = TemplateSchema.parse(template).Resources ?? {};
  return Object.entries(resources)
    .filter(([, resource]) => resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy')
    .flatMap(([policy, resource]) =>
      (resource.Properties?.PolicyDocument?.Statement ?? []).map((statement) => ({ policy, statement })));
}

/** The `dynamodb:Attributes` a statement limits the request to, or undefined when it limits none. */
function attributesOf(statement: Statement): unknown[] | undefined {
  const value = statement.Condition?.['ForAllValues:StringEquals']?.['dynamodb:Attributes'];
  return Array.isArray(value) ? value : undefined;
}

describe('attribute-limited grants on voc-workspaces', () => {
  it('each names pk and sk: a list without the key refuses every request', () => {
    const synthed = synthApp({ ...ALL_FEATURES_CONTEXT }, undefined, HARD_DELETE_BUILD);
    const limited = synthed.stackNames.flatMap((stack) => statements(synthed.template(stack))
      .filter(({ statement }) => JSON.stringify(statement.Resource ?? '').includes('Workspaces'))
      .flatMap(({ policy, statement }) => {
        const attributes = attributesOf(statement);
        return attributes === undefined ? [] : [{ where: `${stack}/${policy}`, attributes }];
      }));
    expect(limited.length).toBeGreaterThan(3);
    expect(limited.filter(({ attributes }) => !attributes.includes('pk') || !attributes.includes('sk')))
      .toStrictEqual([]);
  }, SYNTH_TIMEOUT_MS);
});
