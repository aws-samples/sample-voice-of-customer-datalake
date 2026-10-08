/**
 * VocProcessingStack's research workflow (Step Functions): initialize →
 * analysis → synthesis → validate → save, with one error handler. Created on
 * the stack passed in (not a child construct), so logical ids are unchanged.
 */
import * as cdk from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';

export function createResearchStateMachine(
  scope: Construct,
  uniqueName: (baseName: string) => string,
  researchStepLambda: lambda.Function,
): sfn.StateMachine {
  // Step 1: Initialize
  const initializeStep = new tasks.LambdaInvoke(scope, 'InitializeResearch', {
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
      // step_initialize ALWAYS returns web_context (empty string when web
      // search is off) — an absent key here would fail the state outright.
      'web_context.$': '$.Payload.web_context',
      // Always returned ([] when web search is off/failed) — flows to the
      // save step for the report's web-search disclosure (#207).
      // Update skew: the definition GetAtts the function (implicit CFN
      // dependency), so the Lambda always updates BEFORE this definition
      // and a new definition never runs against the old Lambda. In-flight
      // executions keep the definition they started with; step_save's
      // .get() defaults cover that opposite skew (old definition, new
      // Lambda). Same rollout pattern as web_context (#157).
      'web_search_queries.$': '$.Payload.web_search_queries',
      // Always returned by step_initialize ('' when unused) — see #157.
      'documents_context.$': '$.Payload.documents_context',
      // What the report was built from (reference documents actually used,
      // how many were selected, feedback count, persona ids). step_initialize
      // is the only step that reads those inputs, and step_save is what
      // persists them, so it rides the state like web_search_queries does.
      // ALWAYS returned by step_initialize (empty when nothing was selected)
      // — an absent key here would fail the state outright.
      'derivation.$': '$.Payload.derivation',
    },
  });
  initializeStep.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout'], interval: cdk.Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });

  // Step 2: Analysis
  const analysisStep = new tasks.LambdaInvoke(scope, 'AnalyzeFeedback', {
    lambdaFunction: researchStepLambda,
    payload: sfn.TaskInput.fromObject({
      step: 'analyze',
      'job_id.$': '$.job_id',
      'project_id.$': '$.project_id',
      'research_config.$': '$.research_config',
      'feedback_context.$': '$.initialize_result.feedback_context',
      'feedback_stats.$': '$.initialize_result.feedback_stats',
      'personas_context.$': '$.initialize_result.personas_context',
      'web_context.$': '$.initialize_result.web_context',
      'documents_context.$': '$.initialize_result.documents_context',
    }),
    resultPath: '$.analysis_result',
    resultSelector: { 'analysis.$': '$.Payload.analysis' },
  });
  analysisStep.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout', 'BedrockThrottlingException'], interval: cdk.Duration.seconds(5), maxAttempts: 3, backoffRate: 2 });

  // Step 3: Synthesis
  const synthesisStep = new tasks.LambdaInvoke(scope, 'SynthesizeFindings', {
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
  const validateStep = new tasks.LambdaInvoke(scope, 'ValidateResearch', {
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
  const saveStep = new tasks.LambdaInvoke(scope, 'SaveResearchResults', {
    lambdaFunction: researchStepLambda,
    payload: sfn.TaskInput.fromObject({
      step: 'save',
      'job_id.$': '$.job_id',
      'project_id.$': '$.project_id',
      'research_config.$': '$.research_config',
      'feedback_count.$': '$.initialize_result.feedback_count',
      // Executed web-search queries for the report disclosure (#207).
      'web_search_queries.$': '$.initialize_result.web_search_queries',
      // Provenance decided at initialize, persisted on the document here.
      'derivation.$': '$.initialize_result.derivation',
      'analysis.$': '$.analysis_result.analysis',
      'synthesis.$': '$.synthesis_result.synthesis',
      'validation.$': '$.validate_result.validation',
    }),
    resultPath: '$.save_result',
  });
  saveStep.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout'], interval: cdk.Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });

  // Error handler
  const handleError = new tasks.LambdaInvoke(scope, 'HandleResearchError', {
    lambdaFunction: researchStepLambda,
    payload: sfn.TaskInput.fromObject({
      step: 'error',
      'job_id.$': '$.job_id',
      'project_id.$': '$.project_id',
      'error.$': '$.error',
    }),
  });
  handleError.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException'], interval: cdk.Duration.seconds(1), maxAttempts: 2, backoffRate: 2 });

  const successState = new sfn.Succeed(scope, 'ResearchComplete');
  const failState = new sfn.Fail(scope, 'ResearchFailed', { cause: 'Research job failed', error: 'ResearchError' });

  const addCatch = (step: tasks.LambdaInvoke) => step.addCatch(handleError, { resultPath: '$.error' });

  const definition = addCatch(initializeStep)
    .next(addCatch(analysisStep))
    .next(addCatch(synthesisStep))
    .next(addCatch(validateStep))
    .next(addCatch(saveStep))
    .next(successState);

  handleError.next(failState);

  return new sfn.StateMachine(scope, 'ResearchStateMachine', {
    stateMachineName: uniqueName('voc-research-workflow'),
    definitionBody: sfn.DefinitionBody.fromChainable(definition),
    timeout: cdk.Duration.hours(1),
    tracingEnabled: true,
    logs: {
      destination: new logs.LogGroup(scope, 'ResearchStateMachineLogs', {
        logGroupName: uniqueName('/aws/stepfunctions/voc-research-workflow'),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      level: sfn.LogLevel.ALL,
    },
  });
}
