import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

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
}

export class VocAnalyticsStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: VocAnalyticsStackProps) {
    super(scope, id, props);

    const { feedbackTable, aggregatesTable, pipelinesTable, projectsTable, jobsTable, conversationsTable, kmsKey, processingQueueUrl, processingQueueArn, secretsArn, brandName, researchStateMachineArn } = props;

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
    // Lambda 2: Operations API (CRUD, integrations)
    // Handles: /pipelines/*, /integrations/*, /sources/*, /scrapers/*, /chat/*
    // ============================================
    const opsRole = new iam.Role(this, 'OpsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    feedbackTable.grantReadData(opsRole);
    aggregatesTable.grantReadWriteData(opsRole);
    pipelinesTable.grantReadWriteData(opsRole);
    conversationsTable.grantReadWriteData(opsRole);
    kmsKey.grantEncryptDecrypt(opsRole);

    opsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [secretsArn],
    }));
    opsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ],
    }));
    opsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:voc-ingestor-webscraper`],
    }));
    opsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:EnableRule', 'events:DisableRule', 'events:DescribeRule'],
      resources: [`arn:aws:events:${this.region}:${this.account}:rule/voc-ingest-*-schedule`],
    }));

    const opsLambda = new lambda.Function(this, 'OpsApi', {
      functionName: 'voc-ops-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'ops_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: opsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        PIPELINES_TABLE: pipelinesTable.tableName,
        CONVERSATIONS_TABLE: conversationsTable.tableName,
        SECRETS_ARN: secretsArn,
        POWERTOOLS_SERVICE_NAME: 'voc-ops-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'OpsApiLogs', {
        logGroupName: '/aws/lambda/voc-ops-api',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
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
    aggregatesTable.grantReadData(projectsRole);
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
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ],
    }));
    projectsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:voc-projects-api`],
    }));

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
    const opsIntegration = new apigateway.LambdaIntegration(opsLambda, { proxy: true });
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
    // Ops Lambda: /chat/*, /pipelines/*, /integrations/*, /sources/*, /scrapers/*
    // ============================================
    const chatResource = this.api.root.addResource('chat');
    chatResource.addMethod('POST', opsIntegration);
    const chatConversationsResource = chatResource.addResource('conversations');
    chatConversationsResource.addProxy({ defaultIntegration: opsIntegration, anyMethod: true });

    const pipelinesResource = this.api.root.addResource('pipelines');
    pipelinesResource.addMethod('GET', opsIntegration);
    pipelinesResource.addMethod('POST', opsIntegration);
    const pipelineIdResource = pipelinesResource.addResource('{pipelineId}');
    pipelineIdResource.addMethod('GET', opsIntegration);
    pipelineIdResource.addMethod('PUT', opsIntegration);
    pipelineIdResource.addMethod('DELETE', opsIntegration);
    const pipelineRunResource = pipelineIdResource.addResource('run');
    pipelineRunResource.addMethod('POST', opsIntegration);

    const integrationsResource = this.api.root.addResource('integrations');
    const intStatusResource = integrationsResource.addResource('status');
    intStatusResource.addMethod('GET', opsIntegration);
    const intSourceResource = integrationsResource.addResource('{source}');
    const intCredentialsResource = intSourceResource.addResource('credentials');
    intCredentialsResource.addMethod('PUT', opsIntegration);
    const intTestResource = intSourceResource.addResource('test');
    intTestResource.addMethod('POST', opsIntegration);

    const sourcesResource = this.api.root.addResource('sources');
    const srcStatusResource = sourcesResource.addResource('status');
    srcStatusResource.addMethod('GET', opsIntegration);
    const srcSourceResource = sourcesResource.addResource('{source}');
    const srcEnableResource = srcSourceResource.addResource('enable');
    srcEnableResource.addMethod('PUT', opsIntegration);
    const srcDisableResource = srcSourceResource.addResource('disable');
    srcDisableResource.addMethod('PUT', opsIntegration);

    const scrapersResource = this.api.root.addResource('scrapers');
    scrapersResource.addMethod('GET', opsIntegration);
    scrapersResource.addMethod('POST', opsIntegration);
    scrapersResource.addProxy({ defaultIntegration: opsIntegration, anyMethod: true });

    // Settings endpoints (brand configuration)
    const settingsResource = this.api.root.addResource('settings');
    const brandResource = settingsResource.addResource('brand');
    brandResource.addMethod('GET', opsIntegration);
    brandResource.addMethod('PUT', opsIntegration);

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
