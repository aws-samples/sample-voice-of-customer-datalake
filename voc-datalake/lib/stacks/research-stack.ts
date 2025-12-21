import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface VocResearchStackProps extends cdk.StackProps {
  feedbackTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  kmsKey: kms.Key;
}

export class VocResearchStack extends cdk.Stack {
  public readonly researchStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: VocResearchStackProps) {
    super(scope, id, props);

    const { feedbackTable, projectsTable, jobsTable, kmsKey } = props;

    // Lambda Layer (reuse processing-deps)
    const researchLayer = new lambda.LayerVersion(this, 'ResearchDepsLayer', {
      code: lambda.Code.fromAsset('lambda/layers/processing-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Dependencies for research lambdas (ARM64/Graviton)',
    });

    // Research Lambda Role
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

    // Bedrock access (Claude Sonnet 4.5 via global inference profile)
    researchRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0`,
      ],
    }));

    // Research Step Lambda - handles each step of the research process
    const researchStepLambda = new lambda.Function(this, 'ResearchStepLambda', {
      functionName: 'voc-research-step',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'research_step_handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda/research'),
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
      layers: [researchLayer],
      logGroup: new logs.LogGroup(this, 'ResearchStepLogs', {
        logGroupName: '/aws/lambda/voc-research-step',
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });


    // Step Functions Definition
    // Step 1: Initialize - Fetch data and update job status
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

    // Step 2: Analysis - Deep dive into feedback data
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
      resultSelector: {
        'analysis.$': '$.Payload.analysis',
      },
    });

    // Step 3: Synthesis - Combine findings into insights
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
      resultSelector: {
        'synthesis.$': '$.Payload.synthesis',
      },
    });

    // Step 4: Validate - Cross-check and finalize
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
      resultSelector: {
        'validation.$': '$.Payload.validation',
      },
    });

    // Step 5: Save - Store final results
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

    // Error handler - Update job status on failure
    const handleError = new tasks.LambdaInvoke(this, 'HandleResearchError', {
      lambdaFunction: researchStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'error',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'error.$': '$.error',
      }),
    });

    // Success state
    const successState = new sfn.Succeed(this, 'ResearchComplete');

    // Fail state
    const failState = new sfn.Fail(this, 'ResearchFailed', {
      cause: 'Research job failed',
      error: 'ResearchError',
    });

    // Add error handling to each step
    const addCatch = (step: tasks.LambdaInvoke) => {
      return step.addCatch(handleError, {
        resultPath: '$.error',
      });
    };

    // Build the state machine
    const definition = addCatch(initializeStep)
      .next(addCatch(analysisStep))
      .next(addCatch(synthesisStep))
      .next(addCatch(validateStep))
      .next(addCatch(saveStep))
      .next(successState);

    handleError.next(failState);

    // Create the state machine
    this.researchStateMachine = new sfn.StateMachine(this, 'ResearchStateMachine', {
      stateMachineName: 'voc-research-workflow',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'ResearchStateMachineLogs', {
          logGroupName: '/aws/stepfunctions/voc-research-workflow',
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'ResearchStateMachineArn', { value: this.researchStateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'ResearchStepLambdaArn', { value: researchStepLambda.functionArn });
  }
}
