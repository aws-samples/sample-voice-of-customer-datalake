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
import { AnthropicUseCaseSchema, AnthropicUseCaseConfig } from '../lib/stacks/bedrock-access-stack';
import { lambdaBasicExecutionRoleSuppressions, dynamoDbGsiSuppressions, kmsEncryptionSuppressions, s3BucketSuppressions, bedrockModelSuppressions, pluginSystemSuppressions, cdkAssetsSuppressions, comprehendSuppressions, translateSuppressions, apiGatewayPushToCloudwatchLogsRoleSuppressions } from '../lib/utils/nag-suppressions';
import { shouldDeployWebSearch } from '../lib/utils/web-search-default';
import { shouldDeployAiEnablement } from '../lib/utils/ai-enablement-default';
import { validateDeploymentPrefix } from '../lib/utils/naming';

const app = new cdk.App();

// Deployment prefix — lets two independent copies share ONE account and region.
// See docs/deployment.md ("Two Deployments in One Account and Region") for usage
// and the length budget.
//
// OPT-IN, and it must stay that way: applying a prefix unconditionally would
// rename tables, buckets and the user pool, which CloudFormation implements as a
// REPLACEMENT — silent data loss on every existing deployment. Hence also no
// default for this key in cdk.context.json; it is a per-deployment `-c` flag.
// lib/app-baseline.test.ts proves the unset case is byte-identical.
const deploymentPrefix = validateDeploymentPrefix(app.node.tryGetContext('deploymentPrefix'));

/**
 * Stack id, namespaced when a deployment prefix is in force.
 *
 * Load-bearing beyond the id itself: without it a second deploy UPDATES the
 * first deployment's stacks rather than creating new ones, and CDK derives its
 * automatic cross-stack export names from the stack name, so prefixing the id
 * namespaces all of those too.
 */
const stackId = (id: string): string => (deploymentPrefix ? `${deploymentPrefix}-${id}` : id);

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
// Stack 0: VocWebSearchStack — the us-east-1 AI-enablement stack
// ============================================
// Two independently switchable halves in ONE stack, because they are one
// deployment unit: both run in us-east-1 (the web-search connector exists only
// there; the use-case form has only ever been submitted there), both are
// one-shot account enablement, and neither depends on the core stack chain.
// They used to be two stacks, which put the app at six CloudFormation
// templates — one over Workshop Studio's ceiling of five.
//
//   half 1: AgentCore Gateway for the AWS-managed web-search connector.
//           Deploys by default; `enableWebSearch: false` opts out;
//           unrecognized values throw. Flag semantics live in
//           lib/utils/web-search-default.ts (single source of truth).
//           Per-request search stays opt-in in both UIs ($7/1k queries; the
//           gateway itself has no standing cost).
//   half 2: Anthropic use-case form submission. Opt-in: only when
//           `anthropicUseCase` is set and `skipUseCaseSubmission` is not.
//           Unset by default, so the form is submitted in the Bedrock console.
//
// The model agreements are NOT here: VocCoreStack creates them in the app's
// region on every deploy. So with web search off and no form to submit, this
// stack is not created and nothing is deployed to us-east-1.
//
// The BASE id stays `VocWebSearchStack` deliberately: it determines the
// CloudFormation export names VocProcessingStack and VocApiStack import. It goes
// through stackId() like every other stack, so a prefixed deployment namespaces
// the exports and both importers in lockstep — which is what keeps two copies
// from importing each other's gateway.
const webSearchContextRaw = app.node.tryGetContext('enableWebSearch');
const deployWebSearch = shouldDeployWebSearch(webSearchContextRaw);
const webSearchCrossRegion = deployWebSearch && env.region !== 'us-east-1';

// Accept either boolean true (from cdk.context.json) or string "true"
// (from `--context skipUseCaseSubmission=true` on the CLI, which CDK always
// parses as a string).
const skipRaw = app.node.tryGetContext('skipUseCaseSubmission');
const skipUseCaseSubmission = skipRaw === true || skipRaw === 'true';

const anthropicUseCaseRaw = app.node.tryGetContext('anthropicUseCase');
let anthropicUseCase: AnthropicUseCaseConfig | undefined;
if (anthropicUseCaseRaw) {
  const parseResult = AnthropicUseCaseSchema.safeParse(anthropicUseCaseRaw);
  if (parseResult.success) {
    anthropicUseCase = parseResult.data;
  } else {
    console.warn('⚠️  Invalid anthropicUseCase config in cdk.context.json:');
    console.warn(parseResult.error.format());
    console.warn('Skipping the use case submission. See "Anthropic Model Access" in docs/deployment.md for the required format.');
  }
}
// What half 2 submits, if anything. Skipping applies here, so a skipped
// submission with web search off leaves no reason to create the stack.
const useCaseToSubmit = skipUseCaseSubmission ? undefined : anthropicUseCase;

let webSearchStack: VocWebSearchStack | undefined;
if (shouldDeployAiEnablement(deployWebSearch, useCaseToSubmit)) {
  webSearchStack = new VocWebSearchStack(app, stackId('VocWebSearchStack'), {
    env: { account: env.account, region: 'us-east-1' },
    deploymentPrefix,
    // Unconditionally true, matching what the model-access half required when
    // it was its own us-east-1 stack. CDK only emits the SSM cross-region
    // machinery when the regions actually differ, so this only *permits* it.
    crossRegionReferences: true,
    description: 'VoC Data Lake - AI Enablement (web search gateway, Bedrock model access) (uksb-0q2jyqfvlm)(tag:VocWebSearchStack)',
    deployWebSearch,
    anthropicUseCase: useCaseToSubmit,
  });
  tagStack(webSearchStack, 'AiEnablement');
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
// Stack 1: VocCoreStack
// Merges: Storage + Auth + FrontendInfra
// ============================================
const coreStack = new VocCoreStack(app, stackId('VocCoreStack'), {
  env,
  deploymentPrefix,
  description: 'VoC Data Lake - Core Infrastructure (Storage, Auth, Frontend Hosting) (uksb-0q2jyqfvlm)(tag:VocCoreStack)',
  brandName: config.brandName,
});
tagStack(coreStack, 'Core');
// The form goes in before Core's model agreements are attempted, as it did
// when both lived in one construct. Only when there IS a form: otherwise Core
// must not wait on (or, with `cdk deploy VocCoreStack`, drag in) a us-east-1 stack.
if (webSearchStack && useCaseToSubmit) {
  coreStack.addDependency(webSearchStack);
}

// ============================================
// Stack 2: VocIngestionStack
// (unchanged - plugin-based ingestors)
// ============================================
const ingestionStack = new VocIngestionStack(app, stackId('VocIngestionStack'), {
  env,
  deploymentPrefix,
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
const processingStack = new VocProcessingStack(app, stackId('VocProcessingStack'), {
  env,
  deploymentPrefix,
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
const apiStack = new VocApiStack(app, stackId('VocApiStack'), {
  env,
  deploymentPrefix,
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
  cdnSigningSecretArn: coreStack.cdnSigningSecretArn,
  cdnSigningKeyPairId: coreStack.cdnSigningKeyPairId,
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

// Global suppressions.
// VocWebSearchStack deliberately gets NONE: the gateway half has always passed
// cdk-nag unsuppressed (its IAM is scoped to the concrete gateway ARN), and the
// model-access half carries its own resource-scoped suppressions inside
// BedrockModelAccess. The plugin/Comprehend/Translate sets that used to be
// applied to BedrockAccessStack at stack level were copy-paste — that stack
// calls neither service — so they are dropped rather than inherited by the
// gateway resources.
NagSuppressions.addStackSuppressions(coreStack, [...lambdaBasicExecutionRoleSuppressions, ...cdkAssetsSuppressions], true);
// Apply stack-level suppressions
NagSuppressions.addStackSuppressions(ingestionStack, [...lambdaBasicExecutionRoleSuppressions, ...dynamoDbGsiSuppressions, ...kmsEncryptionSuppressions, ...s3BucketSuppressions], true);
NagSuppressions.addStackSuppressions(processingStack, [...lambdaBasicExecutionRoleSuppressions, ...dynamoDbGsiSuppressions, ...kmsEncryptionSuppressions, ...bedrockModelSuppressions, ...pluginSystemSuppressions(deploymentPrefix), ...comprehendSuppressions, ...translateSuppressions], true);
NagSuppressions.addStackSuppressions(apiStack, [...lambdaBasicExecutionRoleSuppressions, ...apiGatewayPushToCloudwatchLogsRoleSuppressions, ...dynamoDbGsiSuppressions, ...kmsEncryptionSuppressions, ...s3BucketSuppressions, ...bedrockModelSuppressions, ...pluginSystemSuppressions(deploymentPrefix), ...cdkAssetsSuppressions, ...comprehendSuppressions, ...translateSuppressions], true);

app.synth();
