import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_event_sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface ArtifactBuilderStackProps extends cdk.StackProps {
  kmsKey?: kms.Key;
}

export class ArtifactBuilderStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly artifactsBucket: s3.Bucket;
  public readonly previewDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: ArtifactBuilderStackProps) {
    super(scope, id, props);

    // ============================================
    // STORAGE
    // ============================================

    // S3 Bucket for artifacts (source zips, builds, logs)
    // Structure: jobs/{JOB_ID}/source.zip, build/, logs.txt, summary.json
    this.artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `artifact-builder-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          // Clean up old job artifacts after 30 days
          prefix: 'jobs/',
          expiration: cdk.Duration.days(30),
        },
      ],
    });

    // DynamoDB Table for job tracking
    // PK: JOB#{job_id}
    const jobsTable = new dynamodb.Table(this, 'ArtifactJobsTable', {
      tableName: 'artifact-builder-jobs',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for listing jobs by status
    jobsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-status',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // SQS Queue for job execution
    const dlq = new sqs.Queue(this, 'ArtifactBuilderDLQ', {
      queueName: 'artifact-builder-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const jobQueue = new sqs.Queue(this, 'ArtifactBuilderQueue', {
      queueName: 'artifact-builder-jobs',
      visibilityTimeout: cdk.Duration.minutes(30), // Match ECS task timeout
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 2,
      },
    });

    // ============================================
    // CLOUDFRONT FOR PREVIEW HOSTING
    // ============================================

    // CloudFront distribution for serving preview builds
    // Each job's build output is served from /jobs/{JOB_ID}/build/
    this.previewDistribution = new cloudfront.Distribution(this, 'PreviewDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.artifactsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // Handle SPA routing - return index.html for 404s within job paths
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'Artifact Builder Preview CDN',
    });

    // ============================================
    // VPC FOR ECS FARGATE
    // ============================================

    // VPC for ECS tasks (use default VPC for simplicity)
    const vpc = new ec2.Vpc(this, 'ArtifactBuilderVpc', {
      maxAzs: 2,
      natGateways: 1, // Need NAT for Fargate tasks to pull images and access AWS APIs
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'ArtifactBuilderCluster', {
      clusterName: 'artifact-builder',
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ============================================
    // ECS TASK DEFINITION (EXECUTOR)
    // ============================================

    // Task execution role (for pulling images, logging)
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task role (for the container to access AWS services)
    const taskRole = new iam.Role(this, 'ExecutorTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Grant task role access to S3 and DynamoDB
    this.artifactsBucket.grantReadWrite(taskRole);
    jobsTable.grantReadWriteData(taskRole);
    jobQueue.grantConsumeMessages(taskRole);

    // Bedrock access for Kiro CLI (Claude Sonnet 4.5)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ],
    }));

    // ECS Task Definition
    const executorTaskDef = new ecs.FargateTaskDefinition(this, 'ExecutorTaskDef', {
      family: 'artifact-builder-executor',
      cpu: 2048,  // 2 vCPU
      memoryLimitMiB: 4096,  // 4 GB
      taskRole,
      executionRole: taskExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Container definition - will use a Docker image with Node.js, npm, and Kiro CLI
    const executorContainer = executorTaskDef.addContainer('executor', {
      image: ecs.ContainerImage.fromAsset('artifact-builder/executor'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'executor',
        logGroup: new logs.LogGroup(this, 'ExecutorLogs', {
          logGroupName: '/ecs/artifact-builder-executor',
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      environment: {
        ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
        JOBS_TABLE: jobsTable.tableName,
        AWS_REGION: this.region,
      },
    });

    // ============================================
    // API LAMBDA (ORCHESTRATOR)
    // ============================================

    // Lambda Layer for dependencies
    const apiLayer = new lambda.LayerVersion(this, 'ArtifactBuilderApiLayer', {
      code: lambda.Code.fromAsset('lambda/layers/processing-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Dependencies for artifact builder API (ARM64)',
    });

    // API Lambda Role
    const apiRole = new iam.Role(this, 'ArtifactBuilderApiRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    jobsTable.grantReadWriteData(apiRole);
    this.artifactsBucket.grantReadWrite(apiRole);
    jobQueue.grantSendMessages(apiRole);

    // Grant permission to run ECS tasks
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: [executorTaskDef.taskDefinitionArn],
    }));
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, taskExecutionRole.roleArn],
    }));

    // API Lambda
    const apiLambda = new lambda.Function(this, 'ArtifactBuilderApi', {
      functionName: 'artifact-builder-api',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'artifact_builder_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: apiRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        JOBS_TABLE: jobsTable.tableName,
        ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
        JOB_QUEUE_URL: jobQueue.queueUrl,
        ECS_CLUSTER: cluster.clusterArn,
        ECS_TASK_DEF: executorTaskDef.taskDefinitionArn,
        ECS_SUBNETS: vpc.privateSubnets.map(s => s.subnetId).join(','),
        PREVIEW_URL: `https://${this.previewDistribution.distributionDomainName}`,
        POWERTOOLS_SERVICE_NAME: 'artifact-builder-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        logGroupName: '/aws/lambda/artifact-builder-api',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // ============================================
    // SQS TRIGGER FOR ECS TASKS
    // ============================================

    // Lambda to trigger ECS tasks from SQS
    const triggerRole = new iam.Role(this, 'TriggerLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    jobQueue.grantConsumeMessages(triggerRole);
    jobsTable.grantReadWriteData(triggerRole);

    triggerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: [executorTaskDef.taskDefinitionArn],
    }));
    triggerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, taskExecutionRole.roleArn],
    }));

    const triggerLambda = new lambda.Function(this, 'TriggerLambda', {
      functionName: 'artifact-builder-trigger',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'artifact_trigger_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: triggerRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        JOBS_TABLE: jobsTable.tableName,
        ECS_CLUSTER: cluster.clusterArn,
        ECS_TASK_DEF: executorTaskDef.taskDefinitionArn,
        ECS_SUBNETS: vpc.privateSubnets.map(s => s.subnetId).join(','),
        ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'artifact-builder-trigger',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
    });

    // SQS event source for trigger Lambda
    triggerLambda.addEventSource(new lambda_event_sources.SqsEventSource(jobQueue, {
      batchSize: 1,  // Process one job at a time
    }));

    // ============================================
    // API GATEWAY
    // ============================================

    this.api = new apigateway.RestApi(this, 'ArtifactBuilderApiGateway', {
      restApiName: 'artifact-builder-api',
      description: 'Artifact Builder API',
      deployOptions: {
        stageName: 'v1',
        throttlingBurstLimit: 50,
        throttlingRateLimit: 100,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const apiIntegration = new apigateway.LambdaIntegration(apiLambda);

    // /jobs endpoints
    const jobsResource = this.api.root.addResource('jobs');
    jobsResource.addMethod('GET', apiIntegration);   // List jobs
    jobsResource.addMethod('POST', apiIntegration);  // Create job

    const jobResource = jobsResource.addResource('{jobId}');
    jobResource.addMethod('GET', apiIntegration);    // Get job status

    // /jobs/{jobId}/logs
    const logsResource = jobResource.addResource('logs');
    logsResource.addMethod('GET', apiIntegration);   // Get job logs

    // /jobs/{jobId}/download
    const downloadResource = jobResource.addResource('download');
    downloadResource.addMethod('GET', apiIntegration);  // Get download URL

    // /templates endpoint
    const templatesResource = this.api.root.addResource('templates');
    templatesResource.addMethod('GET', apiIntegration);  // List available templates

    // ============================================
    // OUTPUTS
    // ============================================

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.api.url,
      description: 'Artifact Builder API Endpoint',
    });

    new cdk.CfnOutput(this, 'PreviewUrl', {
      value: `https://${this.previewDistribution.distributionDomainName}`,
      description: 'Preview CDN URL',
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketName', {
      value: this.artifactsBucket.bucketName,
      description: 'Artifacts S3 Bucket',
    });

    new cdk.CfnOutput(this, 'JobsTableName', {
      value: jobsTable.tableName,
      description: 'Jobs DynamoDB Table',
    });

    new cdk.CfnOutput(this, 'EcsClusterArn', {
      value: cluster.clusterArn,
      description: 'ECS Cluster ARN',
    });
  }
}
