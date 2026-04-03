---
inclusion: fileMatch
fileMatchPattern: "lib/**/*.ts"
---

# CDK Infrastructure Patterns

This guide applies when working with CDK stack definitions.

## Stack Structure

```typescript
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

// Define typed props interface for cross-stack references
export interface MyStackProps extends cdk.StackProps {
  feedbackTable: dynamodb.Table;
  kmsKey: kms.Key;
}

export class MyStack extends cdk.Stack {
  // Expose resources needed by other stacks
  public readonly myLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id, props);

    const { feedbackTable, kmsKey } = props;

    // Resource definitions...

    // Always add outputs for important resources
    new cdk.CfnOutput(this, 'LambdaArn', { 
      value: this.myLambda.functionArn 
    });
  }
}
```

## DynamoDB Tables

Always use on-demand billing and encryption:

```typescript
const table = new dynamodb.Table(this, 'MyTable', {
  tableName: 'my-table',
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,  // Serverless!
  encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
  encryptionKey: kmsKey,
  pointInTimeRecovery: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  timeToLiveAttribute: 'ttl',  // Enable TTL for cost control
  stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,  // If needed
});

// Add GSIs for access patterns
table.addGlobalSecondaryIndex({
  indexName: 'gsi1-by-date',
  partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
```

## Lambda Functions

Use Python 3.12 with Powertools:

```typescript
const fn = new lambda.Function(this, 'MyFunction', {
  functionName: 'my-function',
  runtime: lambda.Runtime.PYTHON_3_12,
  handler: 'handler.lambda_handler',
  code: lambda.Code.fromAsset('lambda/my-function'),
  timeout: cdk.Duration.minutes(5),
  memorySize: 1024,
  environment: {
    TABLE_NAME: table.tableName,
    POWERTOOLS_SERVICE_NAME: 'my-service',
    LOG_LEVEL: 'INFO',
  },
  layers: [dependenciesLayer],
  logGroup: new logs.LogGroup(this, 'MyFunctionLogs', {
    logGroupName: '/aws/lambda/my-function',
    retention: logs.RetentionDays.TWO_WEEKS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  }),
  reservedConcurrentExecutions: 50,  // Cost control
});

// Grant permissions
table.grantReadWriteData(fn);
kmsKey.grantEncryptDecrypt(fn);
```

## SQS Queues

Always include DLQ:

```typescript
const dlq = new sqs.Queue(this, 'DLQ', {
  queueName: 'my-queue-dlq',
  encryption: sqs.QueueEncryption.KMS,
  encryptionMasterKey: kmsKey,
  retentionPeriod: cdk.Duration.days(14),
});

const queue = new sqs.Queue(this, 'Queue', {
  queueName: 'my-queue',
  encryption: sqs.QueueEncryption.KMS,
  encryptionMasterKey: kmsKey,
  visibilityTimeout: cdk.Duration.minutes(6),  // > Lambda timeout
  deadLetterQueue: {
    queue: dlq,
    maxReceiveCount: 3,
  },
});
```

## EventBridge Schedules

```typescript
const rule = new events.Rule(this, 'ScheduleRule', {
  ruleName: 'my-schedule',
  schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
  targets: [new targets.LambdaFunction(fn, {
    retryAttempts: 2,
  })],
});
```

## API Gateway

```typescript
const api = new apigateway.RestApi(this, 'Api', {
  restApiName: 'my-api',
  deployOptions: {
    stageName: 'v1',
    throttlingRateLimit: 100,
    throttlingBurstLimit: 200,
    loggingLevel: apigateway.MethodLoggingLevel.INFO,
    metricsEnabled: true,
  },
  defaultCorsPreflightOptions: {
    allowOrigins: apigateway.Cors.ALL_ORIGINS,
    allowMethods: apigateway.Cors.ALL_METHODS,
  },
});

const integration = new apigateway.LambdaIntegration(apiLambda);
api.root.addResource('items').addMethod('GET', integration);
```

## IAM Best Practices

Use least-privilege with specific actions:

```typescript
// ✅ Good - specific actions with global inference profiles
role.addToPolicy(new iam.PolicyStatement({
  actions: ['bedrock:InvokeModel'],
  resources: [`arn:aws:bedrock:*:${cdk.Aws.ACCOUNT_ID}:inference-profile/global.anthropic.claude-sonnet-4-6`],
}));

// ❌ Bad - too permissive
role.addToPolicy(new iam.PolicyStatement({
  actions: ['bedrock:*'],
  resources: ['*'],
}));
```

## Cross-Stack References

```typescript
// In storage-stack.ts
export class StorageStack extends cdk.Stack {
  public readonly feedbackTable: dynamodb.Table;
  // ...
}

// In processing-stack.ts
export interface ProcessingStackProps extends cdk.StackProps {
  feedbackTable: dynamodb.Table;
}

// In bin/app.ts
const storageStack = new StorageStack(app, 'Storage', { env });
const processingStack = new ProcessingStack(app, 'Processing', {
  env,
  feedbackTable: storageStack.feedbackTable,
});
processingStack.addDependency(storageStack);
```

## Naming Conventions

- Stack names: `VocXxxStack` (e.g., `VocStorageStack`)
- Resource IDs: `PascalCase` (e.g., `FeedbackTable`)
- Physical names: `kebab-case` (e.g., `voc-feedback`)
