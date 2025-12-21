import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface VocProcessingStackProps extends cdk.StackProps {
  feedbackTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  processingQueue: sqs.Queue;
  kmsKey: kms.Key;
  config: {
    brandName: string;
    brandHandles: string[];
    primaryLanguage: string;
    enabledSources: string[];
  };
}

export class VocProcessingStack extends cdk.Stack {
  public readonly processingLambda: lambda.Function;
  public readonly aggregationLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: VocProcessingStackProps) {
    super(scope, id, props);

    const { feedbackTable, aggregatesTable, projectsTable, processingQueue, kmsKey, config } = props;

    // Processing Lambda Role
    const processingRole = new iam.Role(this, 'ProcessingLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Bedrock permissions - use global inference profiles for cross-region availability
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/global.anthropic.claude-haiku-4-5-20250514-v1:0`,
      ],
    }));

    // Comprehend permissions
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ComprehendAnalysis',
      actions: ['comprehend:DetectSentiment', 'comprehend:DetectKeyPhrases', 'comprehend:DetectDominantLanguage'],
      resources: ['*'],
    }));

    // Translate permissions
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TranslateText',
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }));

    // Grant DynamoDB and KMS permissions
    feedbackTable.grantReadWriteData(processingRole);  // Read for dedup check, Write for inserts
    aggregatesTable.grantReadWriteData(processingRole);
    projectsTable.grantReadData(processingRole);  // Read categories config
    processingQueue.grantConsumeMessages(processingRole);
    kmsKey.grantEncryptDecrypt(processingRole);


    // Lambda Layer
    const processingLayer = new lambda.LayerVersion(this, 'ProcessingDepsLayer', {
      code: lambda.Code.fromAsset('lambda/layers/processing-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Dependencies for processing lambda',
    });

    // Main Processing Lambda
    this.processingLambda = new lambda.Function(this, 'FeedbackProcessor', {
      functionName: 'voc-feedback-processor',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/processor'),
      role: processingRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        PROJECTS_TABLE: projectsTable.tableName,
        PRIMARY_LANGUAGE: config.primaryLanguage,
        BEDROCK_MODEL_ID: 'global.anthropic.claude-haiku-4-5-20250514-v1:0',
        POWERTOOLS_SERVICE_NAME: 'voc-processor',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'ProcessorLogs', {
        logGroupName: '/aws/lambda/voc-feedback-processor',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Trigger from SQS
    this.processingLambda.addEventSource(new lambdaEventSources.SqsEventSource(processingQueue, {
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(30),
      reportBatchItemFailures: true,
    }));

    // Aggregation Lambda - triggered by DynamoDB Streams
    this.aggregationLambda = new lambda.Function(this, 'AggregationProcessor', {
      functionName: 'voc-aggregation-processor',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/aggregator'),
      role: processingRole,
      timeout: cdk.Duration.minutes(1),
      memorySize: 512,
      environment: {
        AGGREGATES_TABLE: aggregatesTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-aggregator',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'AggregatorLogs', {
        logGroupName: '/aws/lambda/voc-aggregation-processor',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Trigger aggregation from DynamoDB Streams (real-time updates)
    this.aggregationLambda.addEventSource(new lambdaEventSources.DynamoEventSource(feedbackTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(30),
      retryAttempts: 3,
      reportBatchItemFailures: true,
    }));

    // Outputs
    new cdk.CfnOutput(this, 'ProcessorFunctionArn', { value: this.processingLambda.functionArn });
    new cdk.CfnOutput(this, 'AggregatorFunctionArn', { value: this.aggregationLambda.functionArn });
  }
}
