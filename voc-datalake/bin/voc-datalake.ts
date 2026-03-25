#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Tags, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { VocCoreStack } from '../lib/stacks/core-stack';
import { VocIngestionStack } from '../lib/stacks/ingestion-stack';
import { VocProcessingStack } from '../lib/stacks/processing-stack-consolidated';
import { VocApiStack } from '../lib/stacks/api-stack';
import { BedrockAccessStack, AnthropicUseCaseSchema } from '../lib/stacks/bedrock-access-stack';
import { lambdaBasicExecutionRoleSuppressions, dynamoDbGsiSuppressions, kmsEncryptionSuppressions, s3BucketSuppressions, bedrockModelSuppressions, pluginSystemSuppressions, cdkAssetsSuppressions, comprehendSuppressions, translateSuppressions, apiGatewayPushToCloudwatchLogsRoleSuppressions } from '../lib/utils/nag-suppressions';

const app = new cdk.App();

// Cost allocation tag helper
function tagStack(stack: cdk.Stack, feature: string) {
  Tags.of(stack).add('Project', 'VoC-DataLake');
  Tags.of(stack).add('Feature', feature);
  Tags.of(stack).add('Environment', process.env.CDK_ENV || 'dev');
  Tags.of(stack).add('ManagedBy', 'CDK');
}

// Derive enabled sources from pluginStatus
const pluginStatus: Record<string, boolean> = app.node.tryGetContext('pluginStatus') || {};
const enabledSources = Object.entries(pluginStatus)
  .filter(([, enabled]) => enabled === true)
  .map(([pluginId]) => pluginId);

// Configuration
const config = {
  brandName: app.node.tryGetContext('brandName') || 'MyBrand',
  brandHandles: app.node.tryGetContext('brandHandles') || ['@mybrand'],
  primaryLanguage: app.node.tryGetContext('primaryLanguage') || 'en',
  enabledSources,
};

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// ============================================
// Stack 0: BedrockAccessStack (Optional)
// Submits Anthropic use case for first-time access
// ============================================
const anthropicUseCaseRaw = app.node.tryGetContext('anthropicUseCase');
let bedrockAccessStack: BedrockAccessStack | undefined;

if (anthropicUseCaseRaw) {
  // Validate the config using Zod schema
  const parseResult = AnthropicUseCaseSchema.safeParse(anthropicUseCaseRaw);
  const skipUseCaseSubmission = app.node.tryGetContext('skipUseCaseSubmission') === true;
  
  if (parseResult.success) {
    bedrockAccessStack = new BedrockAccessStack(app, 'BedrockAccessStack', {
      env,
      description: 'VoC Data Lake - Bedrock Access (Anthropic Use Case & Model Agreements)',
      anthropicUseCase: parseResult.data,
      modelRegion: env.region, // Create model agreements in the same region as other stacks
      skipUseCaseSubmission,
    });
    tagStack(bedrockAccessStack, 'BedrockAccess');
  } else {
    console.warn('⚠️  Invalid anthropicUseCase config in cdk.context.json:');
    console.warn(parseResult.error.format());
    console.warn('Skipping BedrockAccessStack. See cdk.context.example.json for the required format.');
  }
}

// ============================================
// Stack 1: VocCoreStack
// Merges: Storage + Auth + FrontendInfra
// ============================================
const coreStack = new VocCoreStack(app, 'VocCoreStack', {
  env,
  description: 'VoC Data Lake - Core Infrastructure (Storage, Auth, Frontend Hosting)',
  brandName: config.brandName,
  customDomain: app.node.tryGetContext('customDomain') || undefined,
  certificateArn: app.node.tryGetContext('certificateArn') || undefined,
});
tagStack(coreStack, 'Core');

// ============================================
// Stack 2: VocIngestionStack
// (unchanged - plugin-based ingestors)
// ============================================
const ingestionStack = new VocIngestionStack(app, 'VocIngestionStack', {
  env,
  description: 'VoC Data Lake - Ingestion Layer (Lambda, EventBridge, SQS)',
  feedbackTable: coreStack.feedbackTable,
  watermarksTable: coreStack.watermarksTable,
  aggregatesTable: coreStack.aggregatesTable,
  rawDataBucket: coreStack.rawDataBucket,
  accessLogsBucket: coreStack.accessLogsBucket,
  kmsKey: coreStack.kmsKey,
  config,
  frontendDomain: coreStack.frontendDomainName,
});
ingestionStack.addDependency(coreStack);
tagStack(ingestionStack, 'Ingestion');

// ============================================
// Stack 3: VocProcessingStack
// Merges: Processing + Research
// ============================================
const processingStack = new VocProcessingStack(app, 'VocProcessingStack', {
  env,
  description: 'VoC Data Lake - Processing Layer (Lambda, Bedrock, Step Functions)',
  feedbackTable: coreStack.feedbackTable,
  aggregatesTable: coreStack.aggregatesTable,
  projectsTable: coreStack.projectsTable,
  jobsTable: coreStack.jobsTable,
  idempotencyTable: coreStack.idempotencyTable,
  processingQueue: ingestionStack.processingQueue,
  kmsKey: coreStack.kmsKey,
  config,
});
processingStack.addDependency(coreStack);
processingStack.addDependency(ingestionStack);
tagStack(processingStack, 'Processing');

// ============================================
// Stack 4: VocApiStack
// Merges: Analytics + Frontend deployment
// ============================================
const apiStack = new VocApiStack(app, 'VocApiStack', {
  env,
  description: 'VoC Data Lake - API & Frontend (API Gateway, Lambda, S3 Deploy)',
  feedbackTable: coreStack.feedbackTable,
  aggregatesTable: coreStack.aggregatesTable,
  projectsTable: coreStack.projectsTable,
  jobsTable: coreStack.jobsTable,
  conversationsTable: coreStack.conversationsTable,
  kmsKey: coreStack.kmsKey,
  rawDataBucket: coreStack.rawDataBucket,
  avatarsCdnUrl: coreStack.avatarsCdnUrl,
  websiteBucket: coreStack.websiteBucket,
  frontendDistribution: coreStack.frontendDistribution,
  frontendDomainName: coreStack.frontendDomainName,
  userPool: coreStack.userPool,
  userPoolClient: coreStack.userPoolClient,
  authenticatedRole: coreStack.authenticatedRole,
  processingQueueUrl: ingestionStack.processingQueue.queueUrl,
  processingQueueArn: ingestionStack.processingQueue.queueArn,
  secretsArn: ingestionStack.secretsArn,
  s3ImportBucket: ingestionStack.s3ImportBucket,
  researchStateMachine: processingStack.researchStateMachine,
  brandName: config.brandName,
  enabledSources,
});
apiStack.addDependency(coreStack);
apiStack.addDependency(ingestionStack);
apiStack.addDependency(processingStack);
tagStack(apiStack, 'Api');

// Apply cdk-nag checks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Global suppressions
if (bedrockAccessStack) {
  NagSuppressions.addStackSuppressions(bedrockAccessStack, [...pluginSystemSuppressions, ...comprehendSuppressions, ...translateSuppressions], true);
}
NagSuppressions.addStackSuppressions(coreStack, [...lambdaBasicExecutionRoleSuppressions, ...cdkAssetsSuppressions], true);
// Apply stack-level suppressions
NagSuppressions.addStackSuppressions(ingestionStack, [...lambdaBasicExecutionRoleSuppressions, ...dynamoDbGsiSuppressions, ...kmsEncryptionSuppressions, ...s3BucketSuppressions], true);
NagSuppressions.addStackSuppressions(processingStack, [...lambdaBasicExecutionRoleSuppressions, ...dynamoDbGsiSuppressions, ...kmsEncryptionSuppressions, ...bedrockModelSuppressions, ...pluginSystemSuppressions, ...comprehendSuppressions, ...translateSuppressions], true);
NagSuppressions.addStackSuppressions(apiStack, [...lambdaBasicExecutionRoleSuppressions, ...apiGatewayPushToCloudwatchLogsRoleSuppressions, ...dynamoDbGsiSuppressions, ...kmsEncryptionSuppressions, ...s3BucketSuppressions, ...bedrockModelSuppressions, ...pluginSystemSuppressions, ...cdkAssetsSuppressions, ...comprehendSuppressions, ...translateSuppressions], true);

app.synth();
