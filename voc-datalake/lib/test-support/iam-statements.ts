/**
 * Test support: IAM statements of a synthesized template, normalized for
 * least-privilege assertions (exact action SETS per resource).
 *
 * Template values arrive as `unknown`; they are parsed with Zod rather than
 * asserted, so a shape drift fails loudly instead of matching nothing.
 */
import { expect } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import { byCodeUnit } from '../utils/compare';
import { itemAt } from './guards';

/** One raw IAM statement as synthesized (`Effect` defaults to Allow when absent). */
const IamStatementSchema = z.object({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
});

export type IamStatement = z.infer<typeof IamStatementSchema>;

/** An `AWS::IAM::Policy` resource: its attached roles and its statements. */
export const IamPolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.unknown()).optional(),
    PolicyDocument: z.object({ Statement: z.array(IamStatementSchema) }),
  }),
});

const RoleRefSchema = z.object({ Ref: z.string() });

/** A statement's actions as a list (`Action` may be a single string). */
export function statementActions(statement: IamStatement): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

/** Whether `policy` is attached to the role with logical id `roleLogicalId` (`Roles: [{Ref}]`). */
export function isAttachedToRole(policy: z.infer<typeof IamPolicySchema>['Properties'], roleLogicalId: string): boolean {
  return (policy.Roles ?? []).some((role) => RoleRefSchema.safeParse(role).data?.Ref === roleLogicalId);
}

export interface NormalizedStatement {
  effect: string;
  actions: string[];
  /** The statement's `Resource`, serialized — match on logical-id substrings. */
  resource: string;
}

function normalize(statement: IamStatement): NormalizedStatement {
  return {
    effect: statement.Effect ?? 'Allow',
    actions: statementActions(statement),
    resource: JSON.stringify(statement.Resource),
  };
}

/**
 * Every customer-managed policy (`AWS::IAM::ManagedPolicy`) of the template,
 * parsed. A role can carry a grant in one of these instead of its default
 * inline policy (the Projects role's Bedrock grant does, for the inline quota),
 * so a least-privilege reader that scans only `AWS::IAM::Policy` goes blind.
 */
export function managedPolicies(template: Template): z.infer<typeof IamPolicySchema>['Properties'][] {
  return Object.values(template.findResources('AWS::IAM::ManagedPolicy'))
    .map((resource) => IamPolicySchema.parse(resource).Properties);
}

/**
 * Every statement of the one `AWS::IAM::Policy` attached to the role with
 * logical id `roleLogicalId` (by `Roles: [{Ref}]`), or — when `byIdPrefix` is
 * set — of the one policy whose own logical id starts with it. Without
 * `byIdPrefix`, the statements of customer-managed policies attached to the
 * role are included too: they are the role's permissions just the same.
 */
export function roleStatements(
  template: Template,
  roleLogicalId: string,
  options: { byIdPrefix?: boolean } = {},
): NormalizedStatement[] {
  const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
    .map(([id, resource]) => ({ id, policy: IamPolicySchema.parse(resource).Properties }))
    .filter(({ id, policy }) => (options.byIdPrefix
      ? id.startsWith(roleLogicalId)
      : isAttachedToRole(policy, roleLogicalId)));
  expect(policies.map(({ id }) => id), `expected exactly one IAM policy for ${roleLogicalId}`).toHaveLength(1);
  const managed = options.byIdPrefix
    ? []
    : managedPolicies(template).filter((policy) => isAttachedToRole(policy, roleLogicalId));
  return [itemAt(policies, 0).policy, ...managed].flatMap((policy) => policy.PolicyDocument.Statement.map(normalize));
}

/** Sorted, de-duplicated Allow actions starting with `prefix` on resources naming `resourceFragment`. */
export function allowedActions(statements: NormalizedStatement[], prefix: string, resourceFragment: string): string[] {
  const actions = statements
    .filter((s) => s.effect === 'Allow' && s.resource.includes(resourceFragment))
    .flatMap((s) => s.actions)
    .filter((a) => a.startsWith(prefix));
  return [...new Set(actions)].sort(byCodeUnit);
}
