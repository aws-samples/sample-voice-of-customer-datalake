import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { uniqueName } from '../utils/naming';

export interface VocProcessingStackProps extends cdk.StackProps {
  feedbackTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  idempotencyTable: dynamodb.Table;
  processingQueue: sqs.Queue;
  kmsKey: kms.Key;
  config: {
    brandName: string;
    brandHandles: string[];
    primaryLanguage: string;
    enabledSources: string[];
  };
}

/**
 * VocProcessingStack - Consolidated processing and research
 * 
 * Merges: VocProcessingStack + VocResearchStack
 * 
 * Contains:
 * - Feedback processor Lambda (SQS triggered)
 * - Aggregation Lambda (DynamoDB Streams triggered)
 * - Research Step Functions workflow
 * - Research step Lambda
 */
export class VocProcessingStack extends cdk.Stack {
  public readonly processingLambda: lambda.Function;
  public readonly aggregationLambda: lambda.Function;
  public readonly researchStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: VocProcessingStackProps) {
    super(scope, id, props);

    const { feedbackTable, aggregatesTable, projectsTable, jobsTable, idempotencyTable, processingQueue, kmsKey, config } = props;


    // Shared Lambda Layer
    const processingLayer = new lambda.LayerVersion(this, 'ProcessingDepsLayer', {
      code: lambda.Code.fromAsset('lambda/layers/processing-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Dependencies for processing lambdas (ARM64/Graviton)',
    });

    // ============================================
    // PROCESSING ROLE (shared for processor + aggregator)
    // ============================================
    const processingRole = new iam.Role(this, 'ProcessingLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Bedrock permissions
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
    }));

    // Comprehend + Translate permissions
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ComprehendAnalysis',
      actions: ['comprehend:DetectSentiment', 'comprehend:DetectKeyPhrases', 'comprehend:DetectDominantLanguage'],
      resources: ['*'],
    }));
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TranslateText',
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }));

    // DynamoDB + KMS permissions
    feedbackTable.grantReadWriteData(processingRole);
    aggregatesTable.grantReadWriteData(processingRole);
    projectsTable.grantReadData(processingRole);
    idempotencyTable.grantReadWriteData(processingRole);
    processingQueue.grantConsumeMessages(processingRole);
    kmsKey.grantEncryptDecrypt(processingRole);

    // ============================================
    // FEEDBACK PROCESSOR LAMBDA
    // ============================================
    const processorCode = lambda.Code.fromAsset('lambda', {
      exclude: ['**/__pycache__', '*.pyc', 'api/**', 'ingestors/**', 'webhooks/**', 'research/**', 'layers/**', 'aggregator/**'],
      bundling: {
        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
        command: ['bash', '-c', 'mkdir -p /asset-output && cp -r /asset-input/processor/* /asset-output/ && cp -r /asset-input/shared /asset-output/'],
        platform: 'linux/arm64',
      },
    });

    this.processingLambda = new lambda.Function(this, 'FeedbackProcessor', {
      functionName: uniqueName('voc-feedback-processor'),
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: processorCode,
      role: processingRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        PROJECTS_TABLE: projectsTable.tableName,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        PRIMARY_LANGUAGE: config.primaryLanguage,
        BEDROCK_MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        POWERTOOLS_SERVICE_NAME: 'voc-processor',
        POWERTOOLS_IDEMPOTENCY_DISABLED: '0',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'ProcessorLogs', {
        logGroupName: uniqueName('/aws/lambda/voc-feedback-processor'),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    this.processingLambda.addEventSource(new lambdaEventSources.SqsEventSource(processingQueue, {
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(30),
      reportBatchItemFailures: true,
    }));


    // ============================================
    // AGGREGATION LAMBDA
    // ============================================
    const aggregatorCode = lambda.Code.fromAsset('lambda', {
      exclude: ['**/__pycache__', '*.pyc', 'api/**', 'ingestors/**', 'webhooks/**', 'research/**', 'layers/**', 'processor/**'],
      bundling: {
        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
        command: ['bash', '-c', 'mkdir -p /asset-output && cp -r /asset-input/aggregator/* /asset-output/ && cp -r /asset-input/shared /asset-output/'],
        platform: 'linux/arm64',
      },
    });

    this.aggregationLambda = new lambda.Function(this, 'AggregationProcessor', {
      functionName: uniqueName('voc-aggregation-processor'),
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: aggregatorCode,
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
        logGroupName: uniqueName('/aws/lambda/voc-aggregation-processor'),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    this.aggregationLambda.addEventSource(new lambdaEventSources.DynamoEventSource(feedbackTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(30),
      retryAttempts: 3,
      reportBatchItemFailures: true,
    }));

    // ============================================
    // RESEARCH WORKFLOW (Step Functions)
    // ============================================
    const researchRole = new iam.Role(this, 'ResearchLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    feedbackTable.grantReadData(researchRole);
    projectsTable.grantReadWriteData(researchRole);
    jobsTable.grantReadWriteData(researchRole);
    kmsKey.grantEncryptDecrypt(researchRole);

    researchRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
      ],
    }));

    const researchCode = lambda.Code.fromAsset('.', {
      exclude: ['**/__pycache__', '*.pyc', 'node_modules/**', 'cdk.out/**', 'frontend/**', '*.ts', '*.js', '*.json', '*.md', 'bin/**', 'lib/**', 'dist/**', '.venv/**', '.pytest_cache/**', 'plugins/**', 'lambda/api/**', 'lambda/processor/**', 'lambda/ingestors/**', 'lambda/aggregator/**', 'lambda/webhooks/**', 'lambda/artifact-builder/**', 'lambda/layers/**'],
      bundling: {
        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
        command: ['bash', '-c', 'mkdir -p /asset-output && cp -r /asset-input/lambda/research/* /asset-output/ && cp -r /asset-input/lambda/shared /asset-output/'],
        platform: 'linux/arm64',
      },
    });

    const researchStepLambda = new lambda.Function(this, 'ResearchStepLambda', {
      functionName: uniqueName('voc-research-step'),
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'research_step_handler.lambda_handler',
      code: researchCode,
      role: researchRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        PROJECTS_TABLE: projectsTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-research-step',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'ResearchStepLogs', {
        logGroupName: uniqueName('/aws/lambda/voc-research-step'),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Step Functions workflow
    this.researchStateMachine = this.createResearchStateMachine(researchStepLambda);

    // ============================================
    // OUTPUTS
    // ============================================
    new cdk.CfnOutput(this, 'ProcessorFunctionArn', { value: this.processingLambda.functionArn });
    new cdk.CfnOutput(this, 'AggregatorFunctionArn', { value: this.aggregationLambda.functionArn });
    new cdk.CfnOutput(this, 'ResearchStateMachineArn', { value: this.researchStateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'ResearchStepLambdaArn', { value: researchStepLambda.functionArn });
  }

  private createResearchStateMachine(researchStepLambda: lambda.Function): sfn.StateMachine {
    // Step 1: Initialize
    const initializeStep = new tasks.LambdaInvoke(this, 'InitializeResearch', {
      lambdaFunction: researchStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'initialize',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'research_config.$': '$.research_config',
      }),
      resultPath: '$.initialize_result',
      resultSelector: {
        'feedback_context.$': '$.Payload.feedback_context',
        'feedback_stats.$': '$.Payload.feedback_stats',
        'feedback_count.$': '$.Payload.feedback_count',
        'personas_context.$': '$.Payload.personas_context',
      },
    });
    initializeStep.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout'], interval: cdk.Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });

    // Step 2: Analysis
    const analysisStep = new tasks.LambdaInvoke(this, 'AnalyzeFeedback', {
      lambdaFunction: researchStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'analyze',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'research_config.$': '$.research_config',
        'feedback_context.$': '$.initialize_result.feedback_context',
        'feedback_stats.$': '$.initialize_result.feedback_stats',
        'personas_context.$': '$.initialize_result.personas_context',
      }),
      resultPath: '$.analysis_result',
      resultSelector: { 'analysis.$': '$.Payload.analysis' },
    });
    analysisStep.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout', 'BedrockThrottlingException'], interval: cdk.Duration.seconds(5), maxAttempts: 3, backoffRate: 2 });

    // Step 3: Synthesis
    const synthesisStep = new tasks.LambdaInvoke(this, 'SynthesizeFindings', {
      lambdaFunction: researchStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'synthesize',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'research_config.$': '$.research_config',
        'analysis.$': '$.analysis_result.analysis',
      }),
      resultPath: '$.synthesis_result',
      resultSelector: { 'synthesis.$': '$.Payload.synthesis' },
    });
    synthesisStep.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout', 'BedrockThrottlingException'], interval: cdk.Duration.seconds(5), maxAttempts: 3, backoffRate: 2 });

    // Step 4: Validate
    const validateStep = new tasks.LambdaInvoke(this, 'ValidateResearch', {
      lambdaFunction: researchStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'validate',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'research_config.$': '$.research_config',
        'analysis.$': '$.analysis_result.analysis',
        'synthesis.$': '$.synthesis_result.synthesis',
      }),
      resultPath: '$.validate_result',
      resultSelector: { 'validation.$': '$.Payload.validation' },
    });
    validateStep.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout', 'BedrockThrottlingException'], interval: cdk.Duration.seconds(5), maxAttempts: 3, backoffRate: 2 });

    // Step 5: Save
    const saveStep = new tasks.LambdaInvoke(this, 'SaveResearchResults', {
      lambdaFunction: researchStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'save',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'research_config.$': '$.research_config',
        'feedback_count.$': '$.initialize_result.feedback_count',
        'analysis.$': '$.analysis_result.analysis',
        'synthesis.$': '$.synthesis_result.synthesis',
        'validation.$': '$.validate_result.validation',
      }),
      resultPath: '$.save_result',
    });
    saveStep.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout'], interval: cdk.Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });

    // Error handler
    const handleError = new tasks.LambdaInvoke(this, 'HandleResearchError', {
      lambdaFunction: researchStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'error',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'error.$': '$.error',
      }),
    });
    handleError.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException'], interval: cdk.Duration.seconds(1), maxAttempts: 2, backoffRate: 2 });

    const successState = new sfn.Succeed(this, 'ResearchComplete');
    const failState = new sfn.Fail(this, 'ResearchFailed', { cause: 'Research job failed', error: 'ResearchError' });

    const addCatch = (step: tasks.LambdaInvoke) => step.addCatch(handleError, { resultPath: '$.error' });

    const definition = addCatch(initializeStep)
      .next(addCatch(analysisStep))
      .next(addCatch(synthesisStep))
      .next(addCatch(validateStep))
      .next(addCatch(saveStep))
      .next(successState);

    handleError.next(failState);

    return new sfn.StateMachine(this, 'ResearchStateMachine', {
      stateMachineName: uniqueName('voc-research-workflow'),
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'ResearchStateMachineLogs', {
          logGroupName: uniqueName('/aws/stepfunctions/voc-research-workflow'),
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
      },
    });
  }
}
