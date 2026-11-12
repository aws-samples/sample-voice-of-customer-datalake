/**
 * Test support for the engineering agents' suites (engineering-broker.test.ts, engineering-bus.test.ts): the
 * Processing stack synthesized per context once per suite, a function's role, and the statements of its policies.
 */
import { beforeAll, expect } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthProcessingTemplate } from './processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from './synth-app';

const StatementSchema = z.looseObject({
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
});
const PolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.unknown()),
    PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
  }),
});

type Statement = z.infer<typeof StatementSchema>;

/** `voc-eng-{role}-<account>-<region>`, as the agent role names' pattern renders in a template. */
export const AGENT_ROLE_NAME_PATTERN_JOIN = {
  'Fn::Join': ['', ['voc-eng-{role}-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]],
};

/** Synthesizes the Processing stack once per context (in the suite's beforeAll); returns the getter. */
export function processingSynths<K extends string>(contexts: Readonly<Record<K, Record<string, unknown>>>): (key: K) => Template {
  const synthesized = new Map<string, Template>();
  beforeAll(() => {
    for (const [key, context] of Object.entries<Record<string, unknown>>(contexts)) {
      synthesized.set(key, synthProcessingTemplate({ context }));
    }
  }, SYNTH_TIMEOUT_MS);
  return (key) => {
    const template = synthesized.get(key);
    if (!template) throw new Error(`${key} was not synthesized`);
    return template;
  };
}

/** The logical id of the role of the function `fnId`. */
export function functionRoleId(template: Template, fnId: string): string {
  const role = JSON.stringify(template.findResources('AWS::Lambda::Function')[fnId]?.Properties?.Role);
  const roleId = /"Fn::GetAtt":\["([^"]+)","Arn"\]/.exec(role)?.[1];
  expect(roleId).toBeDefined();
  return roleId ?? '';
}

/** Every statement of the policies attached to the role of the function `fnId`. */
export function functionStatements(template: Template, fnId: string): Statement[] {
  const roleId = functionRoleId(template, fnId);
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .map((policy) => PolicySchema.parse(policy).Properties)
    .filter((policy) => JSON.stringify(policy.Roles).includes(`"${roleId}"`))
    .flatMap((policy) => policy.PolicyDocument.Statement);
}

/** The auth types of the function URLs that target the function `fnId`. */
export function functionUrlAuthTypes(template: Template, fnId: string): unknown[] {
  return Object.values(template.findResources('AWS::Lambda::Url'))
    .filter((url) => JSON.stringify(url.Properties?.TargetFunctionArn).includes(`"${fnId}"`))
    .map((url) => url.Properties?.AuthType);
}
