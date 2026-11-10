import { ArnFormat, DefaultStackSynthesizer, Stack } from 'aws-cdk-lib';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsCustomResource } from 'aws-cdk-lib/custom-resources';
import type { IConstruct } from 'constructs';

import { COGNITO_PLUS_OPT_IN_HINT } from './cognito-plus';
import { acknowledgeNag, type NagAck, resourceFinding } from './nag-ack';
import { WAF_OPT_IN_HINT } from './waf';

/**
 * cdk-nag acknowledgements for the VoC Data Lake project (applied with lib/utils/nag-ack.ts).
 * Add acknowledgements here as we review and approve them. cdk-nag 3 acknowledges each finding by its exact
 * id, so a list that names a resource takes that resource and renders the finding from it.
 */

// CDK Custom Resource Lambdas (managed by CDK, not our code)
export const cdkCustomResourceSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-L1',
    reason: 'CDK-managed custom resource Lambda functions use CDK-controlled runtimes',
  },
];

// CloudFront distributions using default certificate
export const cloudfrontDefaultCertSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-CFR1',
    reason: 'Geo restrictions not required for sample application - can be enabled based on specific compliance requirements',
  },
  {
    id: 'AwsSolutions-CFR4',
    reason: 'CloudFront distributions using default certificate (*.cloudfront.net) are limited to TLSv1 by AWS - custom domain with ACM certificate required for TLSv1.2+. See: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cloudfront-distribution-viewercertificate.html#cfn-cloudfront-distribution-viewercertificate-minimumprotocolversion',
  },
];

// Cognito User Pool security settings
export const cognitoSecuritySuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-COG2',
    reason: 'MFA not enforced, to keep sign-in simple for the sample - every user is offered an opt-in passkey (phishing-resistant, WebAuthn) after sign-in; enforce MFA for production use',
  },
];

// The board pool (core-board-auth.ts): no passkey there, so its COG2 reason is its own.
export const boardPoolMfaSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-COG2',
    reason: 'Board users sign in with an emailed one-time code (EMAIL_OTP with -c emailFrom, else a password-reset code) and keep no password; Cognito refuses required MFA in a pool that allows EMAIL_OTP, and a second factor would be one more thing a one-off board visitor must set up',
  },
];

// The paid opt-ins (lib/utils/waf.ts, lib/utils/cognito-plus.ts): acknowledged ONLY while the opt-in is off; with
// it on the rule passes and these are not applied (an unused acknowledgement fails lib/nag-suppressions.test.ts).
// cdk-nag 2.38 replaced COG3 (advanced security mode) with COG8 (the plus feature plan that now carries it).
export const cognitoPlusOffSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-COG8',
    reason: `Cognito Plus feature plan (threat protection: compromised-credential and adaptive sign-in checks) is off by default - it raises every monthly active user's price ($0.020 per MAU with no free tier, against Essentials' $0.015 above 10,000 free); ${COGNITO_PLUS_OPT_IN_HINT}`,
  },
];

export const cloudFrontWafOffSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-CFR2',
    reason: `AWS WAF is off by default - a web ACL is a fixed monthly cost (TENETS.md tenet 7); ${WAF_OPT_IN_HINT}`,
  },
];

export const apiWafOffSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-APIG3',
    reason: `AWS WAF is off by default - a web ACL is a fixed monthly cost (TENETS.md tenet 7); the stage keeps its per-method throttles; ${WAF_OPT_IN_HINT}`,
  },
];

// Secrets Manager rotation for API credentials
export const apiSecretsSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-SMG4',
    reason: 'Secret contains third-party API credentials that cannot be automatically rotated by AWS - requires manual rotation through provider portals',
  },
];

// CloudFront URL-signing key (issue #229)
export const cdnSigningKeySuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-SMG4',
    reason:
      'Automatic rotation would be actively harmful here. This secret holds the RSA private key '
      + 'that signs /avatars/* and /prototypes/* URLs; rotating it invalidates every signed URL '
      + 'already delivered to a browser, and the matching CloudFront PublicKey and KeyGroup would '
      + 'have to be replaced in the same instant to stay consistent. Rotation is therefore a '
      + 'deliberate, coordinated operation: delete the secret value and redeploy, which makes the '
      + 'bootstrap custom resource mint a fresh keypair. Exposure is bounded instead by the '
      + 'short signed-URL TTL (CDN_SIGNED_URL_TTL_SECONDS, 1h by default).',
  },
];

// The CDK grant wildcards (kms:GenerateDataKey*, kms:ReEncrypt*, s3:GetObject*, s3:GetBucket*, s3:List*,
// s3:Abort*, s3:DeleteObject*) and `<TableArn>/index/*` are not acknowledged: lib/utils/exact-grants.ts rewrites
// them to the exact actions and index ARNs on every identity policy, so one that reappears is reported.

/**
 * Object access on a whole bucket (`bucket-arn/*`), or on the raw bucket's `raw/` prefix (the category
 * reprocess worker's raw mode, read-only): `objectArns` are the object ARNs granted, e.g.
 * `rawDataBucket.arnForObjects('*')`.
 */
export function s3ObjectSuppressions(objectArns: readonly string[]): NagAck[] {
  return [{
    id: 'AwsSolutions-IAM5',
    reason: 'S3 object access requires wildcard on bucket ARN (bucket-arn/*) - AWS best practice for object-level permissions',
    findings: objectArns.map(resourceFinding),
  }];
}

/**
 * The reviewed key prefixes of the raw data bucket, one data family each. Owners as of 5.34.00, for the
 * reviewer: avatars/ (projects API, persona generator and importer), company-context/ (settings API),
 * company-context/design/logo_preview_ and icons_ (design capture, logo previews and copied icons only),
 * memory-imports/ (memory API and extractor), projects/{@literal *}/product_docs/ (projects API; extracted/ for the
 * document generator), prototypes/ (projects API, document generator, agent nodes and persona panel),
 * raw/github_issues/ (the GitHub webhook), raw/feedback_form/ (the feedback-form API), raw/feature_requests/ (the
 * engagement API's board copies) and raw/email_intake/ (the opt-in email inbox), those three write-once puts only
 * (lambda/shared/raw_copy.py); scratch/document_jobs/ and scratch/research_jobs/ (the document and research
 * workflows' scratch space).
 */
export type RawDataPrefix =
  | 'avatars/*' | 'company-context/*' | 'company-context/design/logo_preview_*' | 'company-context/design/icons_*'
  | 'memory-imports/*' | 'projects/*/product_docs/*' | 'projects/*/product_docs/extracted/*' | 'prototypes/*'
  | 'raw/github_issues/*' | 'raw/feedback_form/*' | 'raw/feature_requests/*' | 'raw/email_intake/*'
  | 'scratch/document_jobs/*' | 'scratch/research_jobs/*';

/** Object access scoped to the named prefixes of `rawDataBucket`; a grant on any other prefix is still reported. */
export function rawDataPrefixSuppressions(rawDataBucket: s3.IBucket, prefixes: readonly RawDataPrefix[]): NagAck[] {
  return [{
    id: 'AwsSolutions-IAM5',
    reason: 'Object access scoped to ONE named key prefix of the raw data bucket (the data family the role owns); the trailing wildcard is the object key under that prefix, never the bucket or another prefix',
    findings: prefixes.map((prefix) => resourceFinding(rawDataBucket.arnForObjects(prefix))),
  }];
}

/**
 * CDK deployment assets: the object wildcard on the stack's bootstrap file-asset bucket
 * (`cdk-<qualifier>-assets-<account>-<region>`, DefaultStackSynthesizer's default name).
 */
export function cdkAssetsSuppressions(scope: IConstruct): NagAck[] {
  const stack = Stack.of(scope);
  const qualifier = stack.synthesizer.bootstrapQualifier ?? DefaultStackSynthesizer.DEFAULT_QUALIFIER;
  const bucketArn = stack.formatArn({
    service: 's3', region: '', account: '', resource: `cdk-${qualifier}-assets-${stack.account}-${stack.region}`,
    arnFormat: ArnFormat.NO_RESOURCE_NAME,
  });
  return [{
    id: 'AwsSolutions-IAM5',
    reason: 'CDK bootstrap bucket wildcard required for deployment assets',
    findings: [resourceFinding(`${bucketArn}/*`)],
  }];
}

// Bedrock foundation model agreement APIs - account-level operations
export const bedrockAgreementSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Bedrock foundation model agreement APIs (ListFoundationModelAgreementOffers, CreateFoundationModelAgreement, GetFoundationModelAvailability, PutUseCaseForModelAccess) are account-level operations that do not support resource-level permissions',
    findings: ['Resource::*'],
  },
];

// AWS Marketplace - subscription APIs for Bedrock model access
export const marketplaceSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'AWS Marketplace subscription APIs (ViewSubscriptions, Subscribe) do not support resource-level permissions - required for Bedrock model EULA acceptance. API-stack grants (lib/stacks/api-marketplace.ts) narrow Subscribe to the image model listing with an aws-marketplace:ProductId condition (ViewSubscriptions has no condition key); the Bedrock model-access provider subscribes to the allowlisted model listings it enables',
    findings: ['Resource::*'],
  },
];

// Service Quotas - read the account's Bedrock token quotas (Settings model test)
export const serviceQuotasReadSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'servicequotas:ListServiceQuotas supports no resource-level permission and is read-only: the settings Lambda lists the Bedrock tokens-per-minute quotas for POST /settings/model/test and GET /settings/model/capacity (shared/model_capacity.py); it holds no quota-increase or other write action',
    findings: ['Resource::*'],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'servicequotas:GetServiceQuota is read-only and scoped to this account and region\'s Bedrock quotas (bedrock/*): the settings Lambda refreshes its stored tokens-per-minute readings one quota code at a time (shared/model_quota_store.py); the codes are learned from the listing, so they cannot be enumerated in the template',
    // The grant builds the ARN from the pseudo parameters (api-data-lambdas.ts), so the finding is the same
    // in every account and region.
    findings: ['Resource::arn:<AWS::Partition>:servicequotas:<AWS::Region>:<AWS::AccountId>:bedrock/*'],
  },
];

// `Resource::*` of reviewed unscopable actions (Comprehend, Translate, Step Functions log delivery, ...) is NOT
// suppressed here any more: suppressReviewedResourceStar (nag-resource-star.ts) suppresses it per policy, only
// where every `"*"` action is on the reviewed list in resource-star-actions.ts.

// Public feedback form endpoints (intentionally unauthenticated)
export const publicFeedbackEndpointSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-APIG4',
    reason: 'Feedback form endpoints are intentionally public to allow anonymous customer feedback submission',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'Feedback form endpoints are intentionally public to allow anonymous customer feedback submission - Cognito authentication would prevent external users from submitting feedback',
  },
];

// Public ballot endpoints (intentionally unauthenticated).
//
// Separate from the feedback-form list above, deliberately: the reason differs,
// and one shared suppression would let a reviewer of a future public route read a
// justification about customer feedback and think it had been assessed. The
// control here is the voting session — a ballot is accepted only against a valid
// unguessable session token, only while that session is open and unexpired, and
// only up to its ballot cap, enforced by a conditional atomic increment.
export const publicBallotEndpointSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-APIG4',
    reason: 'Anonymous prioritization ballots are submitted by attendees from personal phones with no account; the unguessable voting-session token, its open/closed state, its expiry and its ballot cap are the authorization',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'Cognito authentication would defeat the feature - a room scores a proposal without accounts; the session record authorizes each write and closing the session revokes it',
  },
];

// Plugin webhook receivers (intentionally unauthenticated at the gateway). Their own
// list for the same reason as the ballot one: the control is different. The caller
// is a third-party service (GitHub) that cannot present a Cognito token; every
// delivery is authenticated in the handler by the provider's HMAC signature over the
// exact body, against a secret held in Secrets Manager, before anything is parsed or
// enqueued — and refused outright when no secret is configured.
export const publicWebhookEndpointSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-APIG4',
    reason: 'Provider webhooks (e.g. GitHub) cannot send a Cognito token; the handler verifies the provider HMAC signature (X-Hub-Signature-256, constant-time) before any processing and fails closed without a configured secret',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'A third-party webhook sender has no Cognito identity; the shared-secret request signature is the authorization, checked in the Lambda',
  },
];

// The public unsubscribe endpoint (intentionally unauthenticated). Its own list, like the ballot
// one: the control differs. The caller is a mail recipient (or their mail client's RFC 8058
// one-click POST) with no account; the only thing the request can do is mark the ONE person an
// unguessable emailed token names as unsubscribed, and it answers the same for any token.
export const publicUnsubscribeEndpointSuppressions: NagAck[] = [
  {
    id: 'AwsSolutions-APIG4',
    reason: 'Email recipients unsubscribe without an account (RFC 8058 one-click); the unguessable per-recipient token (only its SHA-256 is stored) is the authorization, it can only unsubscribe the person it names, and the answer never reveals whether it matched',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'A participant who received an email has no Cognito identity, and a mail client posting the one-click unsubscribe cannot present one; the emailed token is the authorization',
  },
];

/**
 * Acknowledge the CDK-managed runtime finding on the singleton
 * `AwsCustomResource` provider Lambda (`AWS<uuid>` and its ServiceRole) when the
 * stack has one. A stack without the singleton gets no acknowledgement and no error.
 */
export function suppressAwsCustomResourceProvider(stack: Stack): void {
  const provider = stack.node.tryFindChild(`AWS${AwsCustomResource.PROVIDER_FUNCTION_UUID.split('-').join('')}`);
  if (provider !== undefined) {
    acknowledgeNag(provider, cdkCustomResourceSuppressions);
  }
}
