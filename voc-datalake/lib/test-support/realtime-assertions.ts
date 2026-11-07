/**
 * Test support: the check every realtime publisher shares (lib/utils/realtime.ts `grantRealtimePublish`): its role
 * carries exactly ONE of VocCoreStack's per-namespace publish policies (core-realtime.ts, `Realtime<Ns>PublishPolicy`,
 * referenced from another stack), holds no appsync or ssm statement of its own, and nothing else is needed.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { expect } from 'vitest';
import { z } from 'zod';
import { byCodeUnit } from '../utils/compare';
import type { RealtimeNamespace } from '../utils/realtime';
import { roleStatements } from './iam-statements';

const RoleSchema = z.object({ Properties: z.object({ ManagedPolicyArns: z.array(z.unknown()).optional() }) });
const POLICY_REFERENCE = /Realtime(Jobs|Chat|Runs)PublishPolicy/;

/** The namespaces whose publish policy the role `roleLogicalId` (exact id, or an id prefix) carries, sorted. */
export function realtimeNamespacesOfRole(template: Template, roleLogicalId: string,
  options: { byIdPrefix?: boolean } = {}): string[] {
  const roles = Object.entries(template.findResources('AWS::IAM::Role'))
    .filter(([id]) => (options.byIdPrefix ? id.startsWith(roleLogicalId) : id === roleLogicalId));
  expect(roles.map(([id]) => id), `expected exactly one role ${roleLogicalId}`).toHaveLength(1);
  const arns = RoleSchema.parse(roles[0]?.[1]).Properties.ManagedPolicyArns ?? [];
  return arns.map((arn) => POLICY_REFERENCE.exec(JSON.stringify(arn))?.[1]?.toLowerCase())
    .filter((namespace) => namespace !== undefined)
    .sort(byCodeUnit);
}

/** The role publishes on exactly `namespace` (its managed policy), with no appsync or ssm statement of its own. */
export function expectPublishesOnlyOn(template: Template, roleLogicalId: string, namespace: RealtimeNamespace,
  options: { byIdPrefix?: boolean } = {}): void {
  expect(realtimeNamespacesOfRole(template, roleLogicalId, options), roleLogicalId).toStrictEqual([namespace]);
  const own = roleStatements(template, roleLogicalId, options)
    .flatMap((s) => s.actions)
    .filter((a) => a.startsWith('appsync:') || a.startsWith('ssm:'));
  expect(own, `${roleLogicalId}: no appsync / ssm statement of its own`).toStrictEqual([]);
}
