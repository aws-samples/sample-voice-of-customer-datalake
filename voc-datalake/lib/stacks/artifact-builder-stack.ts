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
import * as efs from 'aws-cdk-lib/aws-efs';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface ArtifactBuilderStackProps extends cdk.StackProps {
  // Optional: pass existing VPC
  vpc?: ec2.IVpc;
}

export class ArtifactBuilderStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly artifactsBucket: s3.Bucket;
  public readonly previewDistribution: cloudfront.Distribution;
  public readonly templateRepo: codecommit.Repository;

  constructor(scope: Construct, id: string, props?: ArtifactBuilderStackProps) {
    super(scope, id, props);

    // ============================================
    // CODECOMMIT - TEMPLATE REPOSITORY
    // ============================================

    // Read-only template repository
    // Upload template-app contents here after deployment
    this.templateRepo = new codecommit.Repository(this, 'TemplateRepo', {
      repositoryName: 'artifact-builder-template',
      description: 'Read-only template for Artifact Builder (React + Vite + shadcn/ui)',
    });

    // ============================================
    // SSM PARAMETERS
    // ============================================

    // Note: Kiro CLI uses OAuth device flow for authentication
    // No API key needed - auth state is persisted in EFS volumes

    // ============================================
    // STORAGE
    // ============================================

    // S3 Bucket for artifacts (source zips, builds, logs)
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
          prefix: 'jobs/',
          expiration: cdk.Duration.days(30),
        },
      ],
    });

    // DynamoDB Table for job tracking
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
      visibilityTimeout: cdk.Duration.minutes(30),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 2,
      },
    });

    // ============================================
    // CLOUDFRONT FOR PREVIEW HOSTING
    // ============================================

    this.previewDistribution = new cloudfront.Distribution(this, 'PreviewDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.artifactsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
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

    const vpc = props?.vpc ?? new ec2.Vpc(this, 'ArtifactBuilderVpc', {
      maxAzs: 2,
      natGateways: 1,
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

    // Security group for ECS tasks
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      description: 'Security group for Artifact Builder ECS tasks',
      allowAllOutbound: true,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'ArtifactBuilderCluster', {
      clusterName: 'artifact-builder',
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ============================================
    // EFS FOR KIRO CLI AUTH PERSISTENCE
    // ============================================
    // Kiro CLI uses OAuth device flow - auth state must persist across task runs
    // Directories to persist:
    // - ~/.kiro/ (CLI config, agents, steering)
    // - ~/.config/kiro/ (settings)
    // - ~/.local/share/kiro-cli/ (auth state, sqlite db)

    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSecurityGroup', {
      vpc,
      description: 'Security group for Kiro CLI auth EFS',
      allowAllOutbound: false,
    });

    // Allow ECS tasks to access EFS
    efsSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(2049),
      'Allow NFS from ECS tasks'
    );

    const kiroAuthFileSystem = new efs.FileSystem(this, 'KiroAuthEfs', {
      vpc,
      securityGroup: efsSecurityGroup,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep auth state on stack delete
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
    });

    // Access point for Kiro CLI home directory
    const kiroAccessPoint = new efs.AccessPoint(this, 'KiroAccessPoint', {
      fileSystem: kiroAuthFileSystem,
      path: '/kiro-home',
      posixUser: {
        uid: '10001',  // Matches 'kiro' user in container
        gid: '10001',
      },
      createAcl: {
        ownerUid: '10001',
        ownerGid: '10001',
        permissions: '755',
      },
    });

    // ============================================
    // ECS TASK DEFINITION (EXECUTOR)
    // ============================================

    // Task execution role
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

    // Grant permissions
    this.artifactsBucket.grantReadWrite(taskRole);
    jobsTable.grantReadWriteData(taskRole);
    jobQueue.grantConsumeMessages(taskRole);
    this.templateRepo.grantPull(taskRole);

    // CodeCommit - create repos and push
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'codecommit:CreateRepository',
        'codecommit:GetRepository',
        'codecommit:GitPush',
        'codecommit:GitPull',
        'codecommit:TagResource',
      ],
      resources: [
        `arn:aws:codecommit:${this.region}:${this.account}:artifact-*`,
        this.templateRepo.repositoryArn,
      ],
    }));

    // SSM Parameter Store - read credentials (if any future needs)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/artifact-builder/*`],
    }));

    // ECS Task Definition - x86_64 for broader compatibility
    const executorTaskDef = new ecs.FargateTaskDefinition(this, 'ExecutorTaskDef', {
      family: 'artifact-builder-executor',
      cpu: 4096,   // 4 vCPU for faster builds
      memoryLimitMiB: 8192,  // 8 GB for npm install
      taskRole,
      executionRole: taskExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Add EFS volume for Kiro CLI auth persistence
    executorTaskDef.addVolume({
      name: 'kiro-auth',
      efsVolumeConfiguration: {
        fileSystemId: kiroAuthFileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: kiroAccessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    // Grant EFS access to task role
    kiroAuthFileSystem.grantReadWrite(taskRole);

    // Container definition
    const executorLogGroup = new logs.LogGroup(this, 'ExecutorLogs', {
      logGroupName: '/ecs/artifact-builder-executor',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    executorTaskDef.addContainer('executor', {
      image: ecs.ContainerImage.fromAsset('artifact-builder/executor'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'executor',
        logGroup: executorLogGroup,
      }),
      environment: {
        ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
        JOBS_TABLE: jobsTable.tableName,
        AWS_REGION: this.region,
        TEMPLATE_REPO_NAME: this.templateRepo.repositoryName,
        PREVIEW_URL: `https://${this.previewDistribution.distributionDomainName}`,
        HOME: '/home/kiro',
      },
    }).addMountPoints({
      // Mount EFS to /home/kiro for Kiro CLI auth persistence
      // This persists ~/.kiro, ~/.config/kiro, ~/.local/share/kiro-cli
      sourceVolume: 'kiro-auth',
      containerPath: '/home/kiro',
      readOnly: false,
    });

    // ============================================
    // API LAMBDA (ORCHESTRATOR)
    // ============================================

    const apiLayer = new lambda.LayerVersion(this, 'ArtifactBuilderApiLayer', {
      code: lambda.Code.fromAsset('lambda/layers/processing-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Dependencies for artifact builder API (ARM64)',
    });

    const apiRole = new iam.Role(this, 'ArtifactBuilderApiRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    jobsTable.grantReadWriteData(apiRole);
    this.artifactsBucket.grantReadWrite(apiRole);
    jobQueue.grantSendMessages(apiRole);

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
    // SQS TRIGGER LAMBDA
    // ============================================

    const triggerRole = new iam.Role(this, 'TriggerLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    jobQueue.grantConsumeMessages(triggerRole);
    jobsTable.grantReadWriteData(triggerRole);

    // ECS RunTask permissions
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
        ECS_SECURITY_GROUP: ecsSecurityGroup.securityGroupId,
        ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
        TEMPLATE_REPO_NAME: this.templateRepo.repositoryName,
        PREVIEW_URL: `https://${this.previewDistribution.distributionDomainName}`,
        POWERTOOLS_SERVICE_NAME: 'artifact-builder-trigger',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
    });

    triggerLambda.addEventSource(new lambda_event_sources.SqsEventSource(jobQueue, {
      batchSize: 1,
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
    jobsResource.addMethod('GET', apiIntegration);
    jobsResource.addMethod('POST', apiIntegration);

    const jobResource = jobsResource.addResource('{jobId}');
    jobResource.addMethod('GET', apiIntegration);

    const logsResource = jobResource.addResource('logs');
    logsResource.addMethod('GET', apiIntegration);

    const downloadResource = jobResource.addResource('download');
    downloadResource.addMethod('GET', apiIntegration);

    // /templates endpoint
    const templatesResource = this.api.root.addResource('templates');
    templatesResource.addMethod('GET', apiIntegration);

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

    new cdk.CfnOutput(this, 'TemplateRepoCloneUrl', {
      value: this.templateRepo.repositoryCloneUrlHttp,
      description: 'Template Repository Clone URL (upload template-app here)',
    });

    new cdk.CfnOutput(this, 'TemplateRepoName', {
      value: this.templateRepo.repositoryName,
      description: 'Template Repository Name',
    });

    new cdk.CfnOutput(this, 'EcsClusterArn', {
      value: cluster.clusterArn,
      description: 'ECS Cluster ARN',
    });

    new cdk.CfnOutput(this, 'KiroAuthEfsId', {
      value: kiroAuthFileSystem.fileSystemId,
      description: 'EFS File System ID for Kiro CLI auth persistence',
    });

    new cdk.CfnOutput(this, 'KiroAuthSetupInstructions', {
      value: `Run 'kiro-cli login --use-device-flow' in a container with EFS mounted to complete one-time auth setup`,
      description: 'Instructions for Kiro CLI authentication',
    });
  }
}
