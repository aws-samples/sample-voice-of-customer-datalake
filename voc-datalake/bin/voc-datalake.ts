#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VocStorageStack } from '../lib/stacks/storage-stack';
import { VocIngestionStack } from '../lib/stacks/ingestion-stack';
import { VocProcessingStack } from '../lib/stacks/processing-stack';
import { VocAnalyticsStack } from '../lib/stacks/analytics-stack';
import { VocResearchStack } from '../lib/stacks/research-stack';
import { VocFrontendStack } from '../lib/stacks/frontend-stack';

const app = new cdk.App();

// Configuration
const config = {
  brandName: app.node.tryGetContext('brandName') || 'MyBrand',
  brandHandles: app.node.tryGetContext('brandHandles') || ['@mybrand'],
  primaryLanguage: app.node.tryGetContext('primaryLanguage') || 'en',
  enabledSources: app.node.tryGetContext('enabledSources') || [
    'trustpilot', 'yelp', 'google_reviews', 'twitter', 'instagram', 'facebook', 'reddit', 'tavily',
    'appstore_apple', 'appstore_google', 'appstore_huawei', 'webscraper'
  ],
};

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Stack 1: Storage (DynamoDB tables, KMS)
const storageStack = new VocStorageStack(app, 'VocStorageStack', {
  env,
  description: 'VoC Data Lake - Storage Layer (DynamoDB, KMS)',
});

// Stack 2: Ingestion (Lambda ingestors, EventBridge, SQS)
const ingestionStack = new VocIngestionStack(app, 'VocIngestionStack', {
  env,
  description: 'VoC Data Lake - Ingestion Layer (Lambda, EventBridge, SQS)',
  feedbackTable: storageStack.feedbackTable,
  watermarksTable: storageStack.watermarksTable,
  aggregatesTable: storageStack.aggregatesTable,
  kmsKey: storageStack.kmsKey,
  config,
});
ingestionStack.addDependency(storageStack);

// Stack 3: Processing (Lambda processors, Bedrock, DynamoDB Streams)
const processingStack = new VocProcessingStack(app, 'VocProcessingStack', {
  env,
  description: 'VoC Data Lake - Processing Layer (Lambda, Bedrock, Comprehend)',
  feedbackTable: storageStack.feedbackTable,
  aggregatesTable: storageStack.aggregatesTable,
  processingQueue: ingestionStack.processingQueue,
  kmsKey: storageStack.kmsKey,
  config,
});
processingStack.addDependency(storageStack);
processingStack.addDependency(ingestionStack);

// Stack 4: Research (Step Functions for long-running research jobs)
const researchStack = new VocResearchStack(app, 'VocResearchStack', {
  env,
  description: 'VoC Data Lake - Research Workflow (Step Functions)',
  feedbackTable: storageStack.feedbackTable,
  projectsTable: storageStack.projectsTable,
  jobsTable: storageStack.jobsTable,
  kmsKey: storageStack.kmsKey,
});
researchStack.addDependency(storageStack);

// Stack 5: Analytics (API Gateway, Lambda, Webhooks)
const analyticsStack = new VocAnalyticsStack(app, 'VocAnalyticsStack', {
  env,
  description: 'VoC Data Lake - Analytics API (API Gateway, Lambda, Webhooks)',
  feedbackTable: storageStack.feedbackTable,
  aggregatesTable: storageStack.aggregatesTable,
  pipelinesTable: storageStack.pipelinesTable,
  projectsTable: storageStack.projectsTable,
  jobsTable: storageStack.jobsTable,
  conversationsTable: storageStack.conversationsTable,
  kmsKey: storageStack.kmsKey,
  processingQueueUrl: ingestionStack.processingQueue.queueUrl,
  processingQueueArn: ingestionStack.processingQueue.queueArn,
  secretsArn: ingestionStack.secretsArn,
  brandName: config.brandName,
  researchStateMachineArn: researchStack.researchStateMachine.stateMachineArn,
});
analyticsStack.addDependency(storageStack);
analyticsStack.addDependency(ingestionStack);
analyticsStack.addDependency(researchStack);

// Stack 6: Frontend (S3, CloudFront)
const frontendStack = new VocFrontendStack(app, 'VocFrontendStack', {
  env,
  description: 'VoC Data Lake - Frontend (S3, CloudFront)',
  apiEndpoint: analyticsStack.api.url,
});
frontendStack.addDependency(analyticsStack);

app.synth();
