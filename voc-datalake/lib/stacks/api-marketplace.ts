/**
 * AWS Marketplace subscription access for VocApiStack principals that invoke a
 * Marketplace-listed Bedrock model (issue #274). Shared by the api-*.ts
 * builders that own those principals — exactly the ones that reach the image model:
 * the Projects API and the persona generator / importer jobs. Also the settings
 * role's model Tests (the image model's, and the web search surface's GPT models).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { acknowledgeNag } from '../utils/nag-ack';
import type { IConstruct } from 'constructs';
import { IMAGE_MODEL_MARKETPLACE_PRODUCT_ID, imageModelArn } from '../utils/model-allowlist';
import { bedrockAgreementSuppressions, marketplaceSuppressions } from '../utils/nag-suppressions';
import { mantleInferenceStatement } from '../utils/web-search-models';

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
  acknowledgeNag(principal, marketplaceSuppressions);
}

/**
 * What the Settings API (and its assist twin, same role) needs for the image row of
 * Administration → AI models (lambda/shared/image_model_status.py):
 * - `bedrock:InvokeModel` on the image model ARN only: POST /settings/model/test sends ONE
 *   minimal image request;
 * - `bedrock:GetFoundationModelAvailability` (account-level, no resource ARN): the access status;
 * - the Marketplace actions above: the first InvokeModel of a Marketplace model subscribes as the caller.
 * `servicequotas:ListServiceQuotas` (the requests-per-minute quota) is already on the role.
 */
export function grantImageModelProbe(role: iam.Role): void {
  role.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [imageModelArn()] }));
  role.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:GetFoundationModelAvailability'], resources: ['*'] }));
  grantMarketplaceSubscription(role);
  acknowledgeNag(role, bedrockAgreementSuppressions);
}

/**
 * What the Settings API (and its assist twin, same role) needs for the Test button of the web search surface
 * (Administration → AI models, `web_reviews_search`; lambda/shared/web_search_model_probe.py): exactly
 * `bedrock-mantle:CreateInference` on the account's default mantle project, for ONE tiny Responses request with
 * no tool, so nothing of Amazon Bedrock web search (`bedrock-websearch:*`) is granted. Built only while an enabled
 * plugin reads with those models (lib/utils/web-search-models.ts `webSearchModelsInUse`). Their agreements are the
 * deploy's (BedrockModelAgreements), so no Marketplace action is added for them.
 */
export function grantWebSearchModelProbe(role: iam.Role): void {
  role.addToPolicy(mantleInferenceStatement(cdk.Stack.of(role)));
}
