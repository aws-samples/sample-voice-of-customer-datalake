/**
 * Deploy order of the shared Claude managed policies (lib/utils/claude-model-grant.ts) over the WHOLE app.
 *
 * A role's Claude grant is a customer-managed policy attached through the policy's own `Roles`, so CloudFormation
 * does not order it before the functions using the role by itself (an inline grant would be, through the role's
 * default policy that CDK makes every function wait for). Without the order, a function updated or created while its
 * Claude policy is still being attached can be invoked by a queue, a schedule or a stream and get AccessDenied from
 * Bedrock. This pins, for the default and the all-features synth, that EVERY function whose role holds a Claude
 * policy waits for each of those policies (directly or through what it depends on).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ALL_FEATURES_CONTEXT } from './test-support/all-features-context';
import { cleanupAssemblyDirs, synthApp, type SynthResult } from './test-support/synth-app';

const SHAPES: Readonly<Record<string, SynthResult>> = {
  default: synthApp(),
  'all features': synthApp({ ...ALL_FEATURES_CONTEXT }),
};
afterAll(cleanupAssemblyDirs);

const ResourcesSchema = z.record(z.string(), z.object({
  Type: z.string(),
  Properties: z.record(z.string(), z.unknown()).optional(),
  DependsOn: z.union([z.string(), z.array(z.string())]).optional(),
}));
const RefSchema = z.object({ Ref: z.string() });
const RoleArnSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) });

type Resources = z.infer<typeof ResourcesSchema>;

const dependsOn = (resources: Resources, id: string): string[] => {
  const value = resources[id]?.DependsOn;
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
};

/** Every resource `id` waits for, directly or transitively (within its stack). */
function waitsFor(resources: Resources, id: string): Set<string> {
  const seen = new Set<string>();
  const queue = dependsOn(resources, id);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...dependsOn(resources, next));
  }
  return seen;
}

/** Role logical id → the Claude managed policies attached to it. */
function claudePoliciesByRole(resources: Resources): Map<string, string[]> {
  const byRole = new Map<string, string[]>();
  for (const [id, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::IAM::ManagedPolicy' || !id.startsWith('ClaudeInvoke')) continue;
    for (const role of z.array(RefSchema).parse(resource.Properties?.['Roles'] ?? [])) {
      byRole.set(role.Ref, [...(byRole.get(role.Ref) ?? []), id]);
    }
  }
  return byRole;
}

interface FunctionOrder { readonly fn: string; readonly policies: string[]; readonly missing: string[] }

function functionOrders(result: SynthResult): FunctionOrder[] {
  return result.stackNames.flatMap((stack) => {
    const resources = ResourcesSchema.parse(result.template(stack).Resources ?? {});
    const byRole = claudePoliciesByRole(resources);
    return Object.entries(resources).flatMap(([id, resource]) => {
      if (resource.Type !== 'AWS::Lambda::Function') return [];
      const role = RoleArnSchema.safeParse(resource.Properties?.['Role']);
      const policies = role.success ? (byRole.get(role.data['Fn::GetAtt'][0]) ?? []) : [];
      if (policies.length === 0) return [];
      const waits = waitsFor(resources, id);
      return [{ fn: `${stack}/${id}`, policies, missing: policies.filter((policy) => !waits.has(policy)) }];
    });
  });
}

describe.each(Object.entries(SHAPES))('Claude managed policies before their functions (%s synth)', (_shape, result) => {
  const orders = functionOrders(result);

  it('reads real Claude-granted functions (vacuity guard)', () => {
    expect(orders.length).toBeGreaterThan(20);
  });

  it('makes every function whose role holds a Claude policy wait for each of them', () => {
    expect(orders.filter((order) => order.missing.length > 0)).toStrictEqual([]);
  });
});
