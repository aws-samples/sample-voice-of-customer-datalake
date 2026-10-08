import type { Stack } from 'aws-cdk-lib';
import { AwsCustomResource } from 'aws-cdk-lib/custom-resources';
import { NagPackSuppression, NagSuppressions } from 'cdk-nag';

import { bedrockFoundationModelSuppressionTargets } from './model-allowlist';

/**
 * cdk-nag suppressions for the VoC Data Lake project
 * Add suppressions here as we review and approve them
 */

// CDK Custom Resource Lambdas (managed by CDK, not our code)
export const cdkCustomResourceSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-L1',
    reason: 'CDK-managed custom resource Lambda functions use CDK-controlled runtimes',
  },
];

// DynamoDB PITR for idempotency table
export const idempotencyTableSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-DDB3',
    reason: 'Idempotency table has 15-minute TTL - transient data does not require point-in-time recovery',
  },
];

// AWSLambdaBasicExecutionRole - AWS managed policy for Lambda CloudWatch logging
export const lambdaBasicExecutionRoleSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AWSLambdaBasicExecutionRole is AWS-recommended managed policy for Lambda CloudWatch logging with minimal permissions',
    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
  },
];

// AmazonAPIGatewayPushToCloudWatchLogs - AWS managed policy for API Gateway to publish logs to CloudWatch 
export const apiGatewayPushToCloudwatchLogsRoleSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'AmazonAPIGatewayPushToCloudWatchLogs is AWS-recommended managed policy for API Gateway to push to CloudWatch logging with minimal permissions',
    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs'],
  },
];

// CloudFront distributions using default certificate
export const cloudfrontDefaultCertSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-CFR1',
    reason: 'Geo restrictions not required for sample application - can be enabled based on specific compliance requirements',
  },
  {
    id: 'AwsSolutions-CFR2',
    reason: 'AWS WAF not included to minimize costs for sample deployment - recommended for production use',
  },
  {
    id: 'AwsSolutions-CFR4',
    reason: 'CloudFront distributions using default certificate (*.cloudfront.net) are limited to TLSv1 by AWS - custom domain with ACM certificate required for TLSv1.2+. See: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cloudfront-distribution-viewercertificate.html#cfn-cloudfront-distribution-viewercertificate-minimumprotocolversion',
  },
];

// Cognito User Pool security settings
export const cognitoSecuritySuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-COG2',
    reason: 'MFA not enforced by default to reduce friction for sample application - users can enable MFA in their account settings',
  },
  {
    id: 'AwsSolutions-COG3',
    reason: 'Cognito Advanced Security Mode not enforced to minimize costs for sample deployment ($0.05 per login attempt) - recommended for production use',
  },
];

// Secrets Manager rotation for API credentials
export const apiSecretsSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-SMG4',
    reason: 'Secret contains third-party API credentials that cannot be automatically rotated by AWS - requires manual rotation through provider portals',
  },
];

// CloudFront URL-signing key (issue #229)
export const cdnSigningKeySuppressions: NagPackSuppression[] = [
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

// DynamoDB Global Secondary Index access
export const dynamoDbGsiSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Wildcard required for DynamoDB Global Secondary Index access - GSI ARNs follow pattern <TableArn>/index/* per AWS best practices',
    appliesTo: [
      { regex: '/Resource::<.*FeedbackTable.*\.Arn>/index/\*/' },
      { regex: '/Resource::<.*AggregatesTable.*\.Arn>/index/\*/' },
      { regex: '/Resource::<.*ProjectsTable.*\.Arn>/index/\*/' },
      { regex: '/Resource::<.*JobsTable.*\.Arn>/index/\*/' },
      { regex: '/Resource::<.*MemoryTable.*\.Arn>/index/\*/' },
      { regex: '/Resource::<.*AgentsTable.*\.Arn>/index/\*/' },
    ],
  },
];

// KMS encryption operations - CDK grantEncryptDecrypt() uses wildcards
export const kmsEncryptionSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'KMS wildcard actions (GenerateDataKey*, ReEncrypt*) are generated by CDK grantEncryptDecrypt() construct - covers multiple related encryption operations',
    appliesTo: [
      'Action::kms:GenerateDataKey*',
      'Action::kms:ReEncrypt*',
    ],
  },
];

// S3 bucket operations - CDK grantReadWrite() and grantRead() use wildcards
export const s3BucketSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'S3 wildcard actions are generated by CDK bucket grant methods (grantReadWrite, grantRead) - covers related S3 operations',
    appliesTo: [
      'Action::s3:Abort*',
      'Action::s3:DeleteObject*',
      'Action::s3:GetBucket*',
      'Action::s3:GetObject*',
      'Action::s3:List*',
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'S3 object access requires wildcard on bucket ARN (bucket-arn/*) - AWS best practice for object-level permissions',
    appliesTo: [
      { regex: '/.*RawDataBucket.*\.Arn>/\*/' },
      // Category reprocess worker (raw mode): read-only on the raw/ prefix.
      { regex: '/.*RawDataBucket.*\.Arn>/raw/\*/' },
      { regex: '/.*S3ImportBucket.*\.Arn>/\*/' },
      { regex: '/.*WebsiteBucket.*\.Arn>/\*/' }
    ],
  },
];

// Bedrock foundation model ARNs - region wildcard required
export const bedrockModelSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Bedrock foundation model ARNs require region wildcard as models are cross-region resources',
    // DERIVED from lib/utils/model-allowlist.ts (every grantable model: the
    // picker allowlist plus fallback safety nets) so a model added there can
    // never leave a stale or missing suppression behind. Only the
    // foundation-model ARNs carry a region wildcard; the inference-profile
    // ARNs are region/account-scoped and need no suppression.
    appliesTo: bedrockFoundationModelSuppressionTargets(),
  },
];

// Dynamic plugin system - Lambda and EventBridge wildcards
//
// A FUNCTION of the deployment prefix, not a constant: the findings these
// suppress quote the concrete resource ARN, so under `-c deploymentPrefix=stg`
// the ARN reads `function:stg-voc-ingestor-*` and a hardcoded `voc-ingestor-`
// regex silently stops matching — leaving a fresh AwsSolutions-IAM5 warning on
// every prefixed synth. With no prefix the strings are unchanged.
export function pluginSystemSuppressions(deploymentPrefix?: string): NagPackSuppression[] {
  // Safe to interpolate into a regex: validateDeploymentPrefix() admits a
  // leading lowercase letter followed by lowercase letters, digits and inner
  // hyphens — none of which are regex metacharacters.
  const p = deploymentPrefix ? `${deploymentPrefix}-` : '';
  return [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Plugin system requires wildcards for dynamic Lambda function names and EventBridge rules created at runtime',
    appliesTo: [
      { regex: `/Resource::arn:aws:lambda:.*:.*:function:${p}voc-ingestor-\*/` },
      { regex: `/Resource::arn:aws:lambda:.*:.*:function:${p}voc-ingestor-webscraper-\*/` },
      { regex: `/Resource::arn:aws:lambda:.*:.*:function:${p}voc-manual-import-processor-\*/` },
      { regex: `/Resource::arn:aws:lambda:.*:.*:function:${p}voc-projects-api-\*/` },
      { regex: `/Resource::arn:aws:events:.*:.*:rule.${p}voc-ingest-.*-schedule/` },
    ],
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Lambda version/alias wildcard required for Step Functions state machine invocations and async job Lambda invocations',
    appliesTo: [
      { regex: '/Resource::<.*ResearchStepLambda.*\.Arn>:\*/' },
      { regex: '/Resource::<.*ModelAgreementLambda.*\.Arn>:\*/' },
      { regex: '/Resource::<.*PersonaGeneratorJob.*\.Arn>:\*/' },
      { regex: '/Resource::<.*DocumentGeneratorJob.*\.Arn>:\*/' },
      { regex: '/Resource::<.*DocumentMergerJob.*\.Arn>:\*/' },
      { regex: '/Resource::<.*PersonaImporterJob.*\.Arn>:\*/' },
      // voc-agent-run's task states (lib/stacks/agent-runtime.ts).
      { regex: '/Resource::<.*AgentConductor.*\.Arn>:\*/' },
      { regex: '/Resource::<.*AgentPersonaPanel.*\.Arn>:\*/' },
    ],
  },
  ];
}

// CDK deployment assets
export const cdkAssetsSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'CDK bootstrap bucket wildcard required for deployment assets',
    appliesTo: [
      { regex: '/Resource::arn:aws:s3:::cdk-.*-assets-.*/' },
    ],
  },
];

// Bedrock foundation model agreement APIs - account-level operations
export const bedrockAgreementSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Bedrock foundation model agreement APIs (ListFoundationModelAgreementOffers, CreateFoundationModelAgreement, GetFoundationModelAvailability, PutUseCaseForModelAccess) are account-level operations that do not support resource-level permissions',
    appliesTo: ['Resource::*'],
  },
];

// AWS Marketplace - subscription APIs for Bedrock model access
export const marketplaceSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'AWS Marketplace subscription APIs (ViewSubscriptions, Subscribe) do not support resource-level permissions - required for Bedrock model EULA acceptance. API-stack grants (lib/stacks/api-marketplace.ts) narrow Subscribe to the image model listing with an aws-marketplace:ProductId condition (ViewSubscriptions has no condition key); the Bedrock model-access provider subscribes to the allowlisted model listings it enables',
    appliesTo: ['Resource::*'],
  },
];

// Service Quotas - read the account's Bedrock token quotas (Settings model test)
export const serviceQuotasReadSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'servicequotas:ListServiceQuotas supports no resource-level permission and is read-only: the settings Lambda lists the Bedrock tokens-per-minute quotas for POST /settings/model/test and GET /settings/model/capacity (shared/model_capacity.py); it holds no quota-increase or other write action',
    appliesTo: ['Resource::*'],
  },
];

// AWS Comprehend - real-time text analysis APIs
export const comprehendSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Comprehend real-time detection APIs (DetectSentiment, DetectKeyPhrases, DetectDominantLanguage, DetectPiiEntities) do not support resource-level permissions - these are stateless analysis operations that require Resource:*',
    appliesTo: [
      'Resource::*',
    ],
  },
];

// AWS Translate - real-time translation API
export const translateSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Translate TranslateText API requires Resource:* for real-time translation without custom parallel data - parallel data ARNs only apply when using custom terminology/translation memories',
    appliesTo: [
      'Resource::*',
    ],
  },
];

// API Gateway request validation
export const apiGatewayRequestValidationSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-APIG2',
    reason: 'Request validation handled by Lambda functions with comprehensive input validation using Pydantic models and custom logic',
  },
  {
    id: 'AwsSolutions-APIG3',
    reason: 'AWS WAF not included to minimize costs for sample deployment - recommended for production use',
  },
];

// Public feedback form endpoints (intentionally unauthenticated)
export const publicFeedbackEndpointSuppressions: NagPackSuppression[] = [
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
export const publicBallotEndpointSuppressions: NagPackSuppression[] = [
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
export const publicWebhookEndpointSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-APIG4',
    reason: 'Provider webhooks (e.g. GitHub) cannot send a Cognito token; the handler verifies the provider HMAC signature (X-Hub-Signature-256, constant-time) before any processing and fails closed without a configured secret',
  },
  {
    id: 'AwsSolutions-COG4',
    reason: 'A third-party webhook sender has no Cognito identity; the shared-secret request signature is the authorization, checked in the Lambda',
  },
];

/**
 * Suppress the CDK-managed runtime and policy findings on the singleton
 * `AwsCustomResource` provider Lambda (`AWS<uuid>` and its ServiceRole) when the
 * stack has one. The paths are matched against `node.path`, whose first segment
 * is the stack's CONSTRUCT ID; `stackPathSegment` is what the caller uses for
 * it (the two stacks that call this spell it differently on purpose, see each
 * call site). A stack without the singleton gets no suppression and no error.
 */
export function suppressAwsCustomResourceProvider(stack: Stack, stackPathSegment: string): void {
  const customResourceId = `AWS${AwsCustomResource.PROVIDER_FUNCTION_UUID.split('-').join('')}`;
  const customResourceSuppressPaths = new Set([
    `/${stackPathSegment}/${customResourceId}/ServiceRole/Resource`,
    `/${stackPathSegment}/${customResourceId}/Resource`,
  ]);

  const allExistingPaths = new Set(
    stack.node.findAll().map((node) => `/${node.node.path}`)
  );

  for (const path of customResourceSuppressPaths) {
    if (allExistingPaths.has(path)) {
      NagSuppressions.addResourceSuppressionsByPath(
        stack,
        path,
        [...cdkCustomResourceSuppressions, ...lambdaBasicExecutionRoleSuppressions],
        true
      );
    }
  }
}
