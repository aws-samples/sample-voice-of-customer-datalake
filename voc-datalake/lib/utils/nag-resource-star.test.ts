/**
 * suppressReviewedResourceStar puts the IAM5 `Resource::*` suppression on exactly the policies whose every
 * `"*"` action is reviewed (resource-star-actions.ts), and nowhere else. Read through the CfnPolicy's own
 * `cdk_nag` metadata, which is what cdk-nag consults.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { suppressReviewedResourceStar } from './nag-resource-star';

const MetadataSchema = z.object({
  rules_to_suppress: z.array(z.object({ id: z.string(), reason: z.string(), applies_to: z.array(z.unknown()).optional() })),
}).optional();

/** One role with the given statements, the helper applied; the IAM5 entries on its default policy. */
function suppressionsFor(statements: iam.PolicyStatement[], presuppress = false) {
  const stack = new cdk.Stack(new cdk.App(), 'Probe');
  const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  statements.forEach((s) => role.addToPolicy(s));
  if (presuppress) {
    NagSuppressions.addResourceSuppressions(role, [
      { id: 'AwsSolutions-IAM5', reason: 'A hand-written reason the helper must not shadow', appliesTo: ['Resource::*'] },
    ], true);
  }
  suppressReviewedResourceStar(stack);
  const policy = role.node.findChild('DefaultPolicy').node.defaultChild;
  if (!(policy instanceof cdk.CfnResource)) throw new Error('no CfnPolicy');
  return (MetadataSchema.parse(policy.getMetadata('cdk_nag'))?.rules_to_suppress ?? []).filter((e) => e.id === 'AwsSolutions-IAM5');
}

const star = (actions: string[], conditions?: Record<string, unknown>) =>
  new iam.PolicyStatement({ actions, resources: ['*'], ...(conditions ? { conditions } : {}) });

describe('suppressReviewedResourceStar', () => {
  it('suppresses a policy whose "*" actions are all reviewed, naming them in the reason', () => {
    const entries = suppressionsFor([star(['comprehend:DetectSentiment']), star(['translate:TranslateText'])]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.applies_to).toStrictEqual(['Resource::*']);
    expect(entries[0]?.reason).toContain('comprehend:DetectSentiment, translate:TranslateText');
  });

  it('leaves a policy alone when any "*" action is unreviewed, even beside reviewed ones', () => {
    expect(suppressionsFor([star(['comprehend:DetectSentiment']), star(['s3:ListAllMyBuckets'])])).toStrictEqual([]);
  });

  it('requires the condition keys a reviewed entry names, not just any Condition', () => {
    expect(suppressionsFor([star(['kms:Decrypt'])])).toStrictEqual([]);
    const unrelated = star(['kms:Decrypt'], { StringEquals: { 'aws:PrincipalAccount': '111111111111' } });
    expect(suppressionsFor([unrelated])).toStrictEqual([]);
    const conditioned = star(['kms:Decrypt'], { StringEquals: { 'kms:ViaService': 'sqs.us-east-1.amazonaws.com' } });
    expect(suppressionsFor([conditioned])).toHaveLength(1);
  });

  it('never treats an Allow with NotAction as reviewed', () => {
    const inverted = new iam.PolicyStatement({ notActions: ['iam:*'], resources: ['*'] });
    expect(suppressionsFor([star(['comprehend:DetectSentiment']), inverted])).toStrictEqual([]);
  });

  it('adds nothing to a policy without a "*" grant', () => {
    const scoped = new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: ['arn:aws:sqs:us-east-1:111111111111:q'] });
    expect(suppressionsFor([scoped])).toStrictEqual([]);
  });

  it('keeps a hand-written Resource::* suppression first and adds none of its own', () => {
    const entries = suppressionsFor([star(['comprehend:DetectSentiment'])], true);
    expect(entries.map((e) => e.reason)).toStrictEqual(['A hand-written reason the helper must not shadow']);
  });
});
