#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Tags } from 'aws-cdk-lib';
import { VocStorageStack } from '../lib/stacks/storage-stack';
import { VocIngestionStack } from '../lib/stacks/ingestion-stack';
import { VocProcessingStack } from '../lib/stacks/processing-stack';
import { VocAnalyticsStack } from '../lib/stacks/analytics-stack';
import { VocResearchStack } from '../lib/stacks/research-stack';
import { VocFrontendInfraStack, VocFrontendStack } from '../lib/stacks/frontend-stack';
import { VocAuthStack } from '../lib/stacks/auth-stack';
import { ArtifactBuilderStack } from '../lib/stacks/artifact-builder-stack';

const app = new cdk.App();

// Cost allocation tag helper - applies Feature tag + common tags to a stack
function tagStack(stack: cdk.Stack, feature: string) {
  Tags.of(stack).add('Project', 'VoC-DataLake');
  Tags.of(stack).add('Feature', feature);
  Tags.of(stack).add('Environment', process.env.CDK_ENV || 'dev');
  Tags.of(stack).add('ManagedBy', 'CDK');
}

// Configuration
const config = {
  brandName: app.node.tryGetContext('brandName') || 'MyBrand',
  brandHandles: app.node.tryGetContext('brandHandles') || ['@mybrand'],
  primaryLanguage: app.node.tryGetContext('primaryLanguage') || 'en',
  enabledSources: app.node.tryGetContext('enabledSources') || [
    'trustpilot', 'yelp', 'google_reviews', 'twitter', 'instagram', 'facebook', 'reddit', 'tavily',
    'appstore_apple', 'appstore_google', 'appstore_huawei', 'webscraper',
    'youtube', 'tiktok', 'linkedin', 's3_import'
  ],
};

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Stack 1: Storage (DynamoDB tables, KMS, S3 raw data lake)
const storageStack = new VocStorageStack(app, 'VocStorageStack', {
  env,
  description: 'VoC Data Lake - Storage Layer (DynamoDB, KMS, S3)',
});

// Stack 2: Frontend Infrastructure (S3 + CloudFront) - Created early to get CloudFront domain
// This stack creates the hosting infrastructure without deploying content
const frontendInfraStack = new VocFrontendInfraStack(app, 'VocFrontendInfraStack', {
  env,
  description: 'VoC Data Lake - Frontend Infrastructure (S3, CloudFront)',
});

// Get the CloudFront domain for CORS configuration
const frontendDomain = frontendInfraStack.distributionDomainName;

// Stack 3: Ingestion (Lambda ingestors, EventBridge, SQS)
const ingestionStack = new VocIngestionStack(app, 'VocIngestionStack', {
  env,
  description: 'VoC Data Lake - Ingestion Layer (Lambda, EventBridge, SQS)',
  feedbackTable: storageStack.feedbackTable,
  watermarksTable: storageStack.watermarksTable,
  aggregatesTable: storageStack.aggregatesTable,
  rawDataBucket: storageStack.rawDataBucket,
  accessLogsBucket: storageStack.accessLogsBucket,
  kmsKey: storageStack.kmsKey,
  config,
  frontendDomain,
});
ingestionStack.addDependency(storageStack);
ingestionStack.addDependency(frontendInfraStack);

// Stack 4: Processing (Lambda processors, Bedrock, DynamoDB Streams)
const processingStack = new VocProcessingStack(app, 'VocProcessingStack', {
  env,
  description: 'VoC Data Lake - Processing Layer (Lambda, Bedrock, Comprehend)',
  feedbackTable: storageStack.feedbackTable,
  aggregatesTable: storageStack.aggregatesTable,
  projectsTable: storageStack.projectsTable,
  idempotencyTable: storageStack.idempotencyTable,
  processingQueue: ingestionStack.processingQueue,
  kmsKey: storageStack.kmsKey,
  config,
});
processingStack.addDependency(storageStack);
processingStack.addDependency(ingestionStack);

// Stack 5: Research (Step Functions for long-running research jobs)
const researchStack = new VocResearchStack(app, 'VocResearchStack', {
  env,
  description: 'VoC Data Lake - Research Workflow (Step Functions)',
  feedbackTable: storageStack.feedbackTable,
  projectsTable: storageStack.projectsTable,
  jobsTable: storageStack.jobsTable,
  kmsKey: storageStack.kmsKey,
});
researchStack.addDependency(storageStack);

// Stack 6: Auth (Cognito User Pool)
const authStack = new VocAuthStack(app, 'VocAuthStack', {
  env,
  description: 'VoC Data Lake - Authentication (Cognito)',
  brandName: config.brandName,
  frontendDomain,
});
authStack.addDependency(frontendInfraStack);

// Stack 7: Analytics (API Gateway, Lambda, Webhooks)
const analyticsStack = new VocAnalyticsStack(app, 'VocAnalyticsStack', {
  env,
  description: 'VoC Data Lake - Analytics API (API Gateway, Lambda, Webhooks)',
  feedbackTable: storageStack.feedbackTable,
  aggregatesTable: storageStack.aggregatesTable,
  projectsTable: storageStack.projectsTable,
  jobsTable: storageStack.jobsTable,
  conversationsTable: storageStack.conversationsTable,
  kmsKey: storageStack.kmsKey,
  processingQueueUrl: ingestionStack.processingQueue.queueUrl,
  processingQueueArn: ingestionStack.processingQueue.queueArn,
  secretsArn: ingestionStack.secretsArn,
  brandName: config.brandName,
  researchStateMachineArn: researchStack.researchStateMachine.stateMachineArn,
  s3ImportBucket: ingestionStack.s3ImportBucket,
  rawDataBucket: storageStack.rawDataBucket,
  avatarsCdnUrl: storageStack.avatarsCdnUrl,
  frontendDomain,
  userPool: authStack.userPool,
});
analyticsStack.addDependency(storageStack);
analyticsStack.addDependency(ingestionStack);
analyticsStack.addDependency(researchStack);
analyticsStack.addDependency(authStack);
analyticsStack.addDependency(frontendInfraStack);

// Stack 8: Artifact Builder (Agentic PoC Builder)
// Standalone stack - can be deployed independently
const artifactBuilderStack = new ArtifactBuilderStack(app, 'ArtifactBuilderStack', {
  env,
  description: 'Artifact Builder - Agentic PoC Generator (ECS, S3, CloudFront)',
});

// Stack 9: Frontend Deployment (deploys built frontend to S3)
// This stack is deployed LAST after the API endpoint is known
const frontendStack = new VocFrontendStack(app, 'VocFrontendStack', {
  env,
  description: 'VoC Data Lake - Frontend Deployment',
  websiteBucket: frontendInfraStack.websiteBucket,
  distribution: frontendInfraStack.distribution,
  apiEndpoint: analyticsStack.api.url,
  artifactBuilderEndpoint: artifactBuilderStack.api.url,
  userPoolId: authStack.userPool.userPoolId,
  userPoolClientId: authStack.userPoolClient.userPoolClientId,
  cognitoRegion: env.region || 'us-east-1',
});
frontendStack.addDependency(analyticsStack);
frontendStack.addDependency(authStack);
frontendStack.addDependency(frontendInfraStack);
frontendStack.addDependency(artifactBuilderStack);

// Apply cost allocation tags to all stacks
tagStack(storageStack, 'Storage');
tagStack(frontendInfraStack, 'Frontend');
tagStack(ingestionStack, 'Ingestion');
tagStack(processingStack, 'Processing');
tagStack(researchStack, 'Research');
tagStack(authStack, 'Auth');
tagStack(analyticsStack, 'Analytics');
tagStack(frontendStack, 'Frontend');
tagStack(artifactBuilderStack, 'ArtifactBuilder');

app.synth();
