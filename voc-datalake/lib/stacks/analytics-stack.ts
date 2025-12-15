import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import * as s3 from 'aws-cdk-lib/aws-s3';

export interface VocAnalyticsStackProps extends cdk.StackProps {
  feedbackTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  pipelinesTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  conversationsTable: dynamodb.Table;
  kmsKey: kms.Key;
  processingQueueUrl: string;
  processingQueueArn: string;
  secretsArn: string;
  brandName: string;
  researchStateMachineArn: string;
  s3ImportBucket?: s3.Bucket;
  rawDataBucket?: s3.Bucket;
  avatarsCdnUrl?: string;
}

export class VocAnalyticsStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: VocAnalyticsStackProps) {
    super(scope, id, props);

    const { feedbackTable, aggregatesTable, pipelinesTable, projectsTable, jobsTable, conversationsTable, kmsKey, processingQueueUrl, processingQueueArn, secretsArn, brandName, researchStateMachineArn, s3ImportBucket, rawDataBucket, avatarsCdnUrl } = props;

    // Lambda Layer (shared across all API Lambdas)
    const apiLayer = new lambda.LayerVersion(this, 'ApiDepsLayer', {
      code: lambda.Code.fromAsset('lambda/layers/processing-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Dependencies for API lambdas',
    });

    // ============================================
    // Lambda 1: Metrics API (read-only queries)
    // Handles: /feedback/*, /metrics/*
    // ============================================
    const metricsRole = new iam.Role(this, 'MetricsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    feedbackTable.grantReadData(metricsRole);
    aggregatesTable.grantReadData(metricsRole);
    kmsKey.grantDecrypt(metricsRole);

    const metricsLambda = new lambda.Function(this, 'MetricsApi', {
      functionName: 'voc-metrics-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'metrics_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: metricsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-metrics-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'MetricsApiLogs', {
        logGroupName: '/aws/lambda/voc-metrics-api',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ============================================
    // Lambda 2: Integrations API
    // Handles: /integrations/*, /sources/*
    // ============================================
    const integrationsRole = new iam.Role(this, 'IntegrationsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    integrationsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [secretsArn],
    }));
    integrationsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:EnableRule', 'events:DisableRule', 'events:DescribeRule'],
      resources: [`arn:aws:events:${this.region}:${this.account}:rule/voc-ingest-*-schedule`],
    }));

    const integrationsLambda = new lambda.Function(this, 'IntegrationsApi', {
      functionName: 'voc-integrations-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'integrations_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: integrationsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { SECRETS_ARN: secretsArn, POWERTOOLS_SERVICE_NAME: 'voc-integrations-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'IntegrationsApiLogs', { logGroupName: '/aws/lambda/voc-integrations-api', retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    // ============================================
    // Lambda 3: Scrapers API
    // Handles: /scrapers/*
    // ============================================
    const scrapersRole = new iam.Role(this, 'ScrapersLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    aggregatesTable.grantReadWriteData(scrapersRole);
    kmsKey.grantEncryptDecrypt(scrapersRole);
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [secretsArn],
    }));
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:voc-ingestor-webscraper`],
    }));
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`],
    }));

    const scrapersLambda = new lambda.Function(this, 'ScrapersApi', {
      functionName: 'voc-scrapers-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'scrapers_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: scrapersRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: { SECRETS_ARN: secretsArn, AGGREGATES_TABLE: aggregatesTable.tableName, POWERTOOLS_SERVICE_NAME: 'voc-scrapers-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'ScrapersApiLogs', { logGroupName: '/aws/lambda/voc-scrapers-api', retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    // ============================================
    // Lambda 4: Settings API
    // Handles: /settings/*
    // ============================================
    const settingsRole = new iam.Role(this, 'SettingsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    aggregatesTable.grantReadWriteData(settingsRole);
    kmsKey.grantEncryptDecrypt(settingsRole);
    settingsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`],
    }));

    const settingsLambda = new lambda.Function(this, 'SettingsApi', {
      functionName: 'voc-settings-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'settings_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: settingsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, POWERTOOLS_SERVICE_NAME: 'voc-settings-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'SettingsApiLogs', { logGroupName: '/aws/lambda/voc-settings-api', retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    // ============================================
    // Lambda: Feedback Form API (embeddable form)
    // Handles: /feedback-form/*
    // ============================================
    const feedbackFormRole = new iam.Role(this, 'FeedbackFormLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    aggregatesTable.grantReadWriteData(feedbackFormRole);
    kmsKey.grantEncryptDecrypt(feedbackFormRole);
    feedbackFormRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [processingQueueArn],
    }));

    const feedbackFormLambda = new lambda.Function(this, 'FeedbackFormApi', {
      functionName: 'voc-feedback-form-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'feedback_form_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: feedbackFormRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        AGGREGATES_TABLE: aggregatesTable.tableName,
        PROCESSING_QUEUE_URL: processingQueueUrl,
        BRAND_NAME: brandName,
        POWERTOOLS_SERVICE_NAME: 'voc-feedback-form-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'FeedbackFormApiLogs', { logGroupName: '/aws/lambda/voc-feedback-form-api', retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    // ============================================
    // Lambda 5: Chat API (pipelines + chat)
    // Handles: /chat/*, /pipelines/*
    // ============================================
    const chatRole = new iam.Role(this, 'ChatLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    feedbackTable.grantReadData(chatRole);
    aggregatesTable.grantReadWriteData(chatRole);
    pipelinesTable.grantReadWriteData(chatRole);
    conversationsTable.grantReadWriteData(chatRole);
    kmsKey.grantEncryptDecrypt(chatRole);
    chatRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`],
    }));

    const chatLambda = new lambda.Function(this, 'ChatApi', {
      functionName: 'voc-chat-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'chat_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: chatRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        PIPELINES_TABLE: pipelinesTable.tableName,
        CONVERSATIONS_TABLE: conversationsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-chat-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'ChatApiLogs', { logGroupName: '/aws/lambda/voc-chat-api', retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });


    // ============================================
    // Lambda 3: Projects API
    // Handles: /projects/*
    // ============================================
    const projectsRole = new iam.Role(this, 'ProjectsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    feedbackTable.grantReadData(projectsRole);
    aggregatesTable.grantReadWriteData(projectsRole);  // ReadWrite for prioritization scores
    projectsTable.grantReadWriteData(projectsRole);
    jobsTable.grantReadWriteData(projectsRole);
    kmsKey.grantEncryptDecrypt(projectsRole);

    projectsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [researchStateMachineArn],
    }));
    projectsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        // Claude Sonnet 4.5 for persona generation
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
        // Amazon Nova Canvas for persona avatar generation (Lambda calls us-east-1 explicitly)
        'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-canvas-v1:0',
      ],
    }));
    projectsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:voc-projects-api`],
    }));

    // S3 access for persona avatar storage
    if (rawDataBucket) {
      rawDataBucket.grantReadWrite(projectsRole, 'avatars/*');
    }

    const projectsLambda = new lambda.Function(this, 'ProjectsApi', {
      functionName: 'voc-projects-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'projects_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: projectsRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        RESEARCH_STATE_MACHINE_ARN: researchStateMachineArn,
        RAW_DATA_BUCKET: rawDataBucket?.bucketName || '',
        AVATARS_CDN_URL: avatarsCdnUrl || '',
        POWERTOOLS_SERVICE_NAME: 'voc-projects-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'ProjectsApiLogs', {
        logGroupName: '/aws/lambda/voc-projects-api',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ============================================
    // Lambda 4: Chat Stream (Function URL for streaming)
    // ============================================
    const chatStreamRole = new iam.Role(this, 'ChatStreamLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    feedbackTable.grantReadData(chatStreamRole);
    aggregatesTable.grantReadData(chatStreamRole);
    projectsTable.grantReadData(chatStreamRole);
    kmsKey.grantDecrypt(chatStreamRole);

    chatStreamRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ],
    }));

    const chatStreamLambda = new lambda.Function(this, 'ChatStreamApi', {
      functionName: 'voc-chat-stream',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'chat_stream_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: chatStreamRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-chat-stream',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'ChatStreamLogs', {
        logGroupName: '/aws/lambda/voc-chat-stream',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const chatStreamUrl = chatStreamLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['Content-Type'],
      },
    });

    projectsLambda.addEnvironment('CHAT_STREAM_URL', chatStreamUrl.url);


    // ============================================
    // Lambda 5: Webhook (Trustpilot)
    // ============================================
    const webhookRole = new iam.Role(this, 'WebhookLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    feedbackTable.grantReadWriteData(webhookRole);
    kmsKey.grantEncryptDecrypt(webhookRole);
    webhookRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [processingQueueArn],
    }));

    const trustpilotWebhook = new lambda.Function(this, 'TrustpilotWebhook', {
      functionName: 'voc-webhook-trustpilot',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/webhooks/trustpilot'),
      role: webhookRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        PROCESSING_QUEUE_URL: processingQueueUrl,
        FEEDBACK_TABLE: feedbackTable.tableName,
        BRAND_NAME: brandName,
        POWERTOOLS_SERVICE_NAME: 'voc-webhook-trustpilot',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'TrustpilotWebhookLogs', {
        logGroupName: '/aws/lambda/voc-webhook-trustpilot',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ============================================
    // REST API with optimized endpoint structure
    // Using proxies to minimize Lambda permissions
    // ============================================
    this.api = new apigateway.RestApi(this, 'VocAnalyticsApi', {
      restApiName: 'voc-analytics-api',
      description: 'Voice of the Customer Analytics API',
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
        exposeHeaders: ['Content-Type'],
      },
    });

    // Lambda integrations
    const metricsIntegration = new apigateway.LambdaIntegration(metricsLambda, { proxy: true });
    const integrationsIntegration = new apigateway.LambdaIntegration(integrationsLambda, { proxy: true });
    const scrapersIntegration = new apigateway.LambdaIntegration(scrapersLambda, { proxy: true });
    const settingsIntegration = new apigateway.LambdaIntegration(settingsLambda, { proxy: true });
    const feedbackFormIntegration = new apigateway.LambdaIntegration(feedbackFormLambda, { proxy: true });
    const chatIntegration = new apigateway.LambdaIntegration(chatLambda, { proxy: true });
    const projectsIntegration = new apigateway.LambdaIntegration(projectsLambda, { proxy: true });
    const webhookIntegration = new apigateway.LambdaIntegration(trustpilotWebhook, { proxy: true });

    // ============================================
    // Metrics Lambda: /feedback/*, /metrics/*
    // Keep existing structure but route to new Lambda
    // ============================================
    const feedbackResource = this.api.root.addResource('feedback');
    feedbackResource.addMethod('GET', metricsIntegration);
    const feedbackIdResource = feedbackResource.addResource('{id}');
    feedbackIdResource.addMethod('GET', metricsIntegration);
    const feedbackIdSimilarResource = feedbackIdResource.addResource('similar');
    feedbackIdSimilarResource.addMethod('GET', metricsIntegration);
    const urgentResource = feedbackResource.addResource('urgent');
    urgentResource.addMethod('GET', metricsIntegration);
    const entitiesResource = feedbackResource.addResource('entities');
    entitiesResource.addMethod('GET', metricsIntegration);

    const metricsResource = this.api.root.addResource('metrics');
    const summaryResource = metricsResource.addResource('summary');
    summaryResource.addMethod('GET', metricsIntegration);
    const sentimentResource = metricsResource.addResource('sentiment');
    sentimentResource.addMethod('GET', metricsIntegration);
    const categoriesResource = metricsResource.addResource('categories');
    categoriesResource.addMethod('GET', metricsIntegration);
    const metricSourcesResource = metricsResource.addResource('sources');
    metricSourcesResource.addMethod('GET', metricsIntegration);
    const personasResource = metricsResource.addResource('personas');
    personasResource.addMethod('GET', metricsIntegration);

    // ============================================
    // Chat Lambda: /chat/*, /pipelines/*
    // ============================================
    const chatResource = this.api.root.addResource('chat');
    chatResource.addMethod('POST', chatIntegration);
    const chatConversationsResource = chatResource.addResource('conversations');
    chatConversationsResource.addProxy({ defaultIntegration: chatIntegration, anyMethod: true });

    const pipelinesResource = this.api.root.addResource('pipelines');
    pipelinesResource.addMethod('GET', chatIntegration);
    pipelinesResource.addMethod('POST', chatIntegration);
    const pipelineIdResource = pipelinesResource.addResource('{pipelineId}');
    pipelineIdResource.addMethod('GET', chatIntegration);
    pipelineIdResource.addMethod('PUT', chatIntegration);
    pipelineIdResource.addMethod('DELETE', chatIntegration);
    const pipelineRunResource = pipelineIdResource.addResource('run');
    pipelineRunResource.addMethod('POST', chatIntegration);

    // ============================================
    // Integrations Lambda: /integrations/*, /sources/*
    // ============================================
    const integrationsResource = this.api.root.addResource('integrations');
    const intStatusResource = integrationsResource.addResource('status');
    intStatusResource.addMethod('GET', integrationsIntegration);
    const intSourceResource = integrationsResource.addResource('{source}');
    const intCredentialsResource = intSourceResource.addResource('credentials');
    intCredentialsResource.addMethod('PUT', integrationsIntegration);
    const intTestResource = intSourceResource.addResource('test');
    intTestResource.addMethod('POST', integrationsIntegration);

    const sourcesResource = this.api.root.addResource('sources');
    const srcStatusResource = sourcesResource.addResource('status');
    srcStatusResource.addMethod('GET', integrationsIntegration);
    const srcSourceResource = sourcesResource.addResource('{source}');
    const srcEnableResource = srcSourceResource.addResource('enable');
    srcEnableResource.addMethod('PUT', integrationsIntegration);
    const srcDisableResource = srcSourceResource.addResource('disable');
    srcDisableResource.addMethod('PUT', integrationsIntegration);

    // ============================================
    // Scrapers Lambda: /scrapers/*
    // ============================================
    const scrapersResource = this.api.root.addResource('scrapers');
    scrapersResource.addMethod('GET', scrapersIntegration);
    scrapersResource.addMethod('POST', scrapersIntegration);
    scrapersResource.addProxy({ defaultIntegration: scrapersIntegration, anyMethod: true });

    // ============================================
    // S3 Import Lambda (dedicated to avoid policy limit)
    // ============================================
    if (s3ImportBucket) {
      const s3ImportRole = new iam.Role(this, 'S3ImportLambdaRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });
      s3ImportBucket.grantReadWrite(s3ImportRole);
      kmsKey.grantEncryptDecrypt(s3ImportRole);

      const s3ImportLambda = new lambda.Function(this, 'S3ImportApi', {
        functionName: 'voc-s3-import-api',
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 's3_import_handler.lambda_handler',
        code: lambda.Code.fromAsset('lambda/api'),
        role: s3ImportRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          S3_IMPORT_BUCKET: s3ImportBucket.bucketName,
          POWERTOOLS_SERVICE_NAME: 'voc-s3-import-api',
          LOG_LEVEL: 'INFO',
        },
        layers: [apiLayer],
        logGroup: new logs.LogGroup(this, 'S3ImportApiLogs', {
          logGroupName: '/aws/lambda/voc-s3-import-api',
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });
      const s3ImportIntegration = new apigateway.LambdaIntegration(s3ImportLambda, { proxy: true });

      // S3 Import file explorer endpoints
      const s3ImportResource = this.api.root.addResource('s3-import');
      const s3FilesResource = s3ImportResource.addResource('files');
      s3FilesResource.addMethod('GET', s3ImportIntegration);
      const s3SourcesResource = s3ImportResource.addResource('sources');
      s3SourcesResource.addMethod('GET', s3ImportIntegration);
      s3SourcesResource.addMethod('POST', s3ImportIntegration);
      const s3UploadResource = s3ImportResource.addResource('upload-url');
      s3UploadResource.addMethod('POST', s3ImportIntegration);
      const s3FileResource = s3ImportResource.addResource('file');
      const s3FilePathResource = s3FileResource.addResource('{key}');
      s3FilePathResource.addMethod('DELETE', s3ImportIntegration);
    }

    // ============================================
    // Settings Lambda: /settings/*
    // ============================================
    const settingsResource = this.api.root.addResource('settings');
    const brandResource = settingsResource.addResource('brand');
    brandResource.addMethod('GET', settingsIntegration);
    brandResource.addMethod('PUT', settingsIntegration);
    
    // Categories configuration endpoints
    const settingsCategoriesResource = settingsResource.addResource('categories');
    settingsCategoriesResource.addMethod('GET', settingsIntegration);
    settingsCategoriesResource.addMethod('PUT', settingsIntegration);
    const categoriesGenerateResource = settingsCategoriesResource.addResource('generate');
    categoriesGenerateResource.addMethod('POST', settingsIntegration);

    // ============================================
    // Feedback Form Lambda: /feedback-form/* (legacy single form)
    // ============================================
    const feedbackFormResource = this.api.root.addResource('feedback-form');
    const feedbackFormConfigResource = feedbackFormResource.addResource('config');
    feedbackFormConfigResource.addMethod('GET', feedbackFormIntegration);
    feedbackFormConfigResource.addMethod('PUT', feedbackFormIntegration);
    const feedbackFormSubmitResource = feedbackFormResource.addResource('submit');
    feedbackFormSubmitResource.addMethod('POST', feedbackFormIntegration);
    const feedbackFormEmbedResource = feedbackFormResource.addResource('embed');
    feedbackFormEmbedResource.addMethod('GET', feedbackFormIntegration);
    const feedbackFormIframeResource = feedbackFormResource.addResource('iframe');
    feedbackFormIframeResource.addMethod('GET', feedbackFormIntegration);

    // ============================================
    // Feedback Forms Lambda: /feedback-forms/* (multiple forms)
    // ============================================
    const feedbackFormsResource = this.api.root.addResource('feedback-forms');
    feedbackFormsResource.addMethod('GET', feedbackFormIntegration);  // List all forms
    feedbackFormsResource.addMethod('POST', feedbackFormIntegration); // Create form
    // Use proxy for dynamic form_id routes: /feedback-forms/{form_id}/*
    feedbackFormsResource.addProxy({ defaultIntegration: feedbackFormIntegration, anyMethod: true });

    // ============================================
    // Projects Lambda: /projects/*
    // ============================================
    const projectsResource = this.api.root.addResource('projects');
    projectsResource.addMethod('GET', projectsIntegration);
    projectsResource.addMethod('POST', projectsIntegration);
    projectsResource.addProxy({ defaultIntegration: projectsIntegration, anyMethod: true });

    // ============================================
    // Webhook: /webhooks/trustpilot
    // ============================================
    const webhooksResource = this.api.root.addResource('webhooks');
    const trustpilotResource = webhooksResource.addResource('trustpilot');
    trustpilotResource.addMethod('POST', webhookIntegration);

    // ============================================
    // Outputs
    // ============================================
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.url });
    new cdk.CfnOutput(this, 'ApiId', { value: this.api.restApiId });
    new cdk.CfnOutput(this, 'TrustpilotWebhookUrl', { value: `${this.api.url}webhooks/trustpilot` });
    new cdk.CfnOutput(this, 'ChatStreamUrl', { value: chatStreamUrl.url });
  }
}
