#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Tags, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { VocCoreStack } from '../lib/stacks/core-stack';
import { VocIngestionStack } from '../lib/stacks/ingestion-stack';
import { VocProcessingStack } from '../lib/stacks/processing-stack-consolidated';
import { VocApiStack } from '../lib/stacks/api-stack';
import { VocWebSearchStack } from '../lib/stacks/web-search-stack';
import { BedrockAccessStack, AnthropicUseCaseSchema } from '../lib/stacks/bedrock-access-stack';
import { lambdaBasicExecutionRoleSuppressions, dynamoDbGsiSuppressions, kmsEncryptionSuppressions, s3BucketSuppressions, bedrockModelSuppressions, pluginSystemSuppressions, cdkAssetsSuppressions, comprehendSuppressions, translateSuppressions, apiGatewayPushToCloudwatchLogsRoleSuppressions } from '../lib/utils/nag-suppressions';
import { shouldDeployWebSearch } from '../lib/utils/web-search-default';

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
// Stack 0a: VocWebSearchStack (default-on, opt-out)
// AgentCore Gateway for the AWS-managed web-search connector.
// ============================================
// Flag semantics live in lib/utils/web-search-default.ts (single source of
// truth). Summary: deploys by default; `enableWebSearch: false` opts out;
// unrecognized values throw. Per-request search stays opt-in in both UIs
// ($7/1k queries; the gateway itself has no standing cost).
//
// The connector only exists in us-east-1, so the stack always deploys
// there. When the app itself lives in another region this additionally
// requires a us-east-1 bootstrap and CDK cross-region references.
const webSearchContextRaw = app.node.tryGetContext('enableWebSearch');
const deployWebSearch = shouldDeployWebSearch(webSearchContextRaw);
const webSearchCrossRegion = deployWebSearch && env.region !== 'us-east-1';

let webSearchStack: VocWebSearchStack | undefined;
if (deployWebSearch) {
  webSearchStack = new VocWebSearchStack(app, 'VocWebSearchStack', {
    env: { account: env.account, region: 'us-east-1' },
    crossRegionReferences: webSearchCrossRegion,
    description: 'VoC Data Lake - Web Search (AgentCore Gateway, web-search connector) (uksb-0q2jyqfvlm)(tag:VocWebSearchStack)',
  });
  tagStack(webSearchStack, 'WebSearch');
  if (webSearchCrossRegion) {
    // Upgrade hint (issue #205): web search now deploys by default, and a
    // non-us-east-1 app needs a us-east-1 bootstrap for the cross-region
    // references. Say so at synth, before `cdk bootstrap`'s error becomes
    // the first (and cryptic) signal.
    cdk.Annotations.of(webSearchStack).addInfo(
      `Web search deploys by default and requires a us-east-1 bootstrap when the app region is ${env.region} ` +
      '(cdk bootstrap aws://ACCOUNT/us-east-1). Opt out with -c enableWebSearch=false.',
    );
  }
}

// ============================================
// Stack 0: BedrockAccessStack (Optional)
// Submits Anthropic use case for first-time access
// ============================================
const anthropicUseCaseRaw = app.node.tryGetContext('anthropicUseCase');
let bedrockAccessStack: BedrockAccessStack | undefined;

if (anthropicUseCaseRaw) {
  // Validate the config using Zod schema
  const parseResult = AnthropicUseCaseSchema.safeParse(anthropicUseCaseRaw);
  // Accept either boolean true (from cdk.context.json) or string "true"
  // (from `--context skipUseCaseSubmission=true` on the CLI, which CDK always
  // parses as a string).
  const skipRaw = app.node.tryGetContext('skipUseCaseSubmission');
  const skipUseCaseSubmission = skipRaw === true || skipRaw === 'true';
  
  if (parseResult.success) {
    bedrockAccessStack = new BedrockAccessStack(app, 'BedrockAccessStack', {
      env,
      description: 'VoC Data Lake - Bedrock Access (Anthropic Use Case & Model Agreements) (uksb-0q2jyqfvlm)(tag:BedrockAccessStack)',
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
  description: 'VoC Data Lake - Core Infrastructure (Storage, Auth, Frontend Hosting) (uksb-0q2jyqfvlm)(tag:VocCoreStack)',
  brandName: config.brandName,
});
tagStack(coreStack, 'Core');

// ============================================
// Stack 2: VocIngestionStack
// (unchanged - plugin-based ingestors)
// ============================================
const ingestionStack = new VocIngestionStack(app, 'VocIngestionStack', {
  env,
  description: 'VoC Data Lake - Ingestion Layer (Lambda, EventBridge, SQS) (uksb-0q2jyqfvlm)(tag:VocIngestionStack)',
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
  crossRegionReferences: webSearchCrossRegion,
  description: 'VoC Data Lake - Processing Layer (Lambda, Bedrock, Step Functions) (uksb-0q2jyqfvlm)(tag:VocProcessingStack)',
  feedbackTable: coreStack.feedbackTable,
  aggregatesTable: coreStack.aggregatesTable,
  projectsTable: coreStack.projectsTable,
  jobsTable: coreStack.jobsTable,
  idempotencyTable: coreStack.idempotencyTable,
  processingQueue: ingestionStack.processingQueue,
  kmsKey: coreStack.kmsKey,
  webSearchGatewayUrl: webSearchStack?.gatewayUrl,
  webSearchGatewayArn: webSearchStack?.gatewayArn,
  webSearchToolName: webSearchStack?.toolName,
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
  crossRegionReferences: webSearchCrossRegion,
  description: 'VoC Data Lake - API & Frontend (API Gateway, Lambda, S3 Deploy) (uksb-0q2jyqfvlm)(tag:VocApiStack)',
  feedbackTable: coreStack.feedbackTable,
  aggregatesTable: coreStack.aggregatesTable,
  projectsTable: coreStack.projectsTable,
  jobsTable: coreStack.jobsTable,
  conversationsTable: coreStack.conversationsTable,
  kmsKey: coreStack.kmsKey,
  rawDataBucket: coreStack.rawDataBucket,
  avatarsCdnUrl: coreStack.avatarsCdnUrl,
  prototypesCdnUrl: coreStack.prototypesCdnUrl,
  websiteBucket: coreStack.websiteBucket,
  frontendDistribution: coreStack.frontendDistribution,
  frontendDomainName: coreStack.frontendDomainName,
  userPool: coreStack.userPool,
  userPoolClient: coreStack.userPoolClient,
  identityPool: coreStack.identityPool,
  authenticatedRole: coreStack.authenticatedRole,
  processingQueueUrl: ingestionStack.processingQueue.queueUrl,
  processingQueueArn: ingestionStack.processingQueue.queueArn,
  secretsArn: ingestionStack.secretsArn,
  s3ImportBucket: ingestionStack.s3ImportBucket,
  researchStateMachine: processingStack.researchStateMachine,
  webSearchGatewayUrl: webSearchStack?.gatewayUrl,
  webSearchGatewayArn: webSearchStack?.gatewayArn,
  webSearchToolName: webSearchStack?.toolName,
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
