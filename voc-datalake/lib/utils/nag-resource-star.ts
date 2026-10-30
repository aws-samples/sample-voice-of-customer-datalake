/**
 * cdk-nag `AwsSolutions-IAM5` `Resource::*`, suppressed per POLICY rather than per stack.
 *
 * Why. The Comprehend/Translate suppression used to be a stack-level entry with `appliesTo: ['Resource::*']`
 * on the Ingestion, Processing and API stacks. cdk-nag reports one `Resource::*` finding per policy whatever
 * the action, so that entry silenced EVERY `"*"` grant in those stacks: Step Functions log delivery, the
 * BucketDeployment invalidation, the event-source `ListStreams`, and whatever came next. This helper puts
 * the suppression only on a policy whose every `"*"` action is in the reviewed list
 * (resource-star-actions.ts), and its reason names those actions, so the nag report says what was accepted
 * and an unlisted `"*"` grant is reported.
 *
 * Skipped: a policy that already carries its own IAM5 `Resource::*` suppression (the marketplace, Service
 * Quotas, logs diagnostics, browser and model-agreement grants keep their hand-written reasons; cdk-nag
 * would use the first entry anyway, leaving this one unused).
 *
 * Limits: it reads each policy document when it is called, so call it after the stack is fully built. A
 * `"*"` statement added to an already-suppressed policy LATER (an Aspect, a grant made after this call) is
 * covered by that policy's suppression and cdk-nag stays quiet about it; lib/app-template-gates.test.ts,
 * which reads the final synthesized templates, is the gate that still catches it. Only `iam.Policy`
 * documents are read; CDK puts every role grant in one.
 */
import { CfnResource, type Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { z } from 'zod';

import { byCodeUnit } from './compare';
import { RESOURCE_STAR_ACTIONS, isReviewedResourceStarAction } from './resource-star-actions';

const RESOURCE_STAR_FINDING = 'Resource::*';
const REASON_PREFIX = 'Resource::* holds only reviewed actions that cannot be scoped (lib/utils/resource-star-actions.ts): ';

const StatementSchema = z.object({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]).optional(),
  NotAction: z.unknown().optional(),
  Resource: z.unknown(),
  NotResource: z.unknown().optional(),
  Condition: z.unknown().optional(),
});
const DocumentSchema = z.object({ Statement: z.array(StatementSchema).optional() });
const NagMetadataSchema = z.object({
  rules_to_suppress: z.array(z.object({ id: z.string(), applies_to: z.array(z.unknown()).optional() })).optional(),
}).optional();

const isStar = (resource: unknown) => resource === '*' || (Array.isArray(resource) && resource.includes('*'));

type Statement = z.infer<typeof StatementSchema>;

/** One statement's `"*"` actions ([] when it grants none), or null when it must surface as a finding. */
function statementStarActions(statement: Statement): string[] | null {
  if ((statement.Effect ?? 'Allow') !== 'Allow') return [];
  // An Allow with NotAction / NotResource is never "reviewed": leave the finding to cdk-nag.
  if (statement.NotAction !== undefined || statement.NotResource !== undefined) return null;
  if (!isStar(statement.Resource)) return [];
  const listed = typeof statement.Action === 'string' ? [statement.Action] : statement.Action ?? [];
  return listed.every((action) => isReviewedResourceStarAction(action, statement.Condition)) ? listed : null;
}

/** The `"*"` actions of `policy`, or null when one of them is not reviewed (the finding must surface). */
function reviewedStarActions(policy: iam.Policy): string[] | null {
  const statements = DocumentSchema.parse(policy.document.toJSON() ?? {}).Statement ?? [];
  const actions = new Set<string>();
  for (const statement of statements) {
    const star = statementStarActions(statement);
    if (star === null) return null;
    star.forEach((action) => actions.add(action));
  }
  return [...actions].sort(byCodeUnit);
}

/** Whether the policy's CloudFormation resource already has an IAM5 suppression covering `Resource::*`. */
function alreadySuppressed(policy: iam.Policy): boolean {
  const cfn = policy.node.defaultChild;
  if (!(cfn instanceof CfnResource)) return false;
  const entries = NagMetadataSchema.parse(cfn.getMetadata('cdk_nag'))?.rules_to_suppress ?? [];
  return entries.some((entry) => entry.id === 'AwsSolutions-IAM5'
    && (entry.applies_to === undefined || entry.applies_to.includes(RESOURCE_STAR_FINDING)));
}

/** Suppress `Resource::*` on every policy of `stack` whose `"*"` grants are all reviewed. */
export function suppressReviewedResourceStar(stack: Stack): void {
  for (const construct of stack.node.findAll()) {
    if (!(construct instanceof iam.Policy) || alreadySuppressed(construct)) continue;
    const actions = reviewedStarActions(construct);
    if (actions === null || actions.length === 0) continue;
    const reasons = [...new Set(actions.map((action) => RESOURCE_STAR_ACTIONS[action]?.reason ?? ''))];
    NagSuppressions.addResourceSuppressions(construct, [{
      id: 'AwsSolutions-IAM5',
      reason: `${REASON_PREFIX}${actions.join(', ')}. ${reasons.join(' | ')}`,
      appliesTo: [RESOURCE_STAR_FINDING],
    }], true);
  }
}
