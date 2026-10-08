/**
 * AWS Marketplace subscription access for VocApiStack principals that invoke a
 * Marketplace-listed Bedrock model (issue #274). Shared by the api-*.ts
 * builders that own those principals — exactly the ones that reach the image model:
 * the Projects API and the persona generator / importer jobs.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import { IMAGE_MODEL_MARKETPLACE_PRODUCT_ID } from '../utils/model-allowlist';
import { marketplaceSuppressions } from '../utils/nag-suppressions';

/**
 * The first InvokeModel of a Marketplace-listed model in an account
 * auto-subscribes to the listing AS THE CALLER, so without these two actions a
 * fresh account answers AccessDenied even though bedrock:InvokeModel is granted
 * (the Stability avatar model). Neither action supports a resource ARN, hence
 * `*` and the shared suppression.
 *
 * Subscribe is scoped to the image model's listing with
 * `aws-marketplace:ProductId`. Per the Bedrock model-access guide that key works
 * "for the aws-marketplace:Subscribe action only"
 * (https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html), and
 * the Service Authorization Reference lists no condition key for
 * ViewSubscriptions, so that read-only List action stays on `*` unconditioned.
 */
export function grantMarketplaceSubscription(principal: iam.IGrantable & IConstruct): void {
  principal.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['aws-marketplace:ViewSubscriptions'],
    resources: ['*'],
  }));
  principal.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['aws-marketplace:Subscribe'],
    resources: ['*'],
    conditions: {
      'ForAnyValue:StringEquals': { 'aws-marketplace:ProductId': [IMAGE_MODEL_MARKETPLACE_PRODUCT_ID] },
    },
  }));
  NagSuppressions.addResourceSuppressions(principal, marketplaceSuppressions, true);
}
