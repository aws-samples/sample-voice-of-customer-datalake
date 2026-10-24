/**
 * VocApiStack's PRD/PR-FAQ generation state machine.
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { ApiStackContext } from './api-context';

/**
 * PRD/PR-FAQ generation state machine. Splits the multi-step LLM chain across
 * Lambda invocations so each step gets its own fresh 15-minute budget — long
 * CJK documents (whose steps auto-continue past maxTokens over several Bedrock
 * calls) no longer overrun a single Lambda. Mirrors the research workflow.
 *
 * Flow: gather → step0 → step1 → step2 → [step3 if PR-FAQ] → save
 * PRD has 3 chain steps, PR-FAQ has 4 — a Choice on num_steps runs the 4th
 * step only for PR-FAQ. Each step's index drives which chain step runs; the
 * step handler reads/writes intermediate text in S3 (claim-check), so SF state
 * carries only scalars. Every LLM step has its own retry on throttling.
 */
export function createDocumentStateMachine(ctx: ApiStackContext, documentStepLambda: lambda.Function): sfn.StateMachine {
  const { stack } = ctx;
  const llmRetry = (t: tasks.LambdaInvoke) => {
    t.addRetry({
      // NOTE: a Lambda hitting ITS OWN configured timeout (as opposed to the
      // Step Functions task's own `States.Timeout`, which is only enforced if
      // a heartbeat/timeout is set on the state itself, which we don't do
      // here) surfaces as `Sandbox.Timedout` — verified live: a 32K-max_tokens
      // prd_document step exhausted the full 900s Lambda budget and the
      // execution history recorded `"error": "Sandbox.Timedout"`, which this
      // list did not previously include, so the retry never engaged and the
      // whole job failed outright instead of getting a fresh 15-minute budget.
      errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout', 'Sandbox.Timedout', 'BedrockThrottlingException'],
      interval: cdk.Duration.seconds(5), maxAttempts: 3, backoffRate: 2,
    });
    return t;
  };

  // gather: build chain steps + context, stash to S3. Returns scalars
  // (doc_type, title, feature_idea, num_steps) used by later states.
  const gather = new tasks.LambdaInvoke(stack, 'DocGather', {
    lambdaFunction: documentStepLambda,
    payload: sfn.TaskInput.fromObject({
      step: 'gather',
      'job_id.$': '$.job_id',
      'project_id.$': '$.project_id',
      'doc_config.$': '$.doc_config',
    }),
    resultPath: '$.gathered',
    resultSelector: {
      'doc_type.$': '$.Payload.doc_type',
      'title.$': '$.Payload.title',
      'feature_idea.$': '$.Payload.feature_idea',
      'num_steps.$': '$.Payload.num_steps',
      'replayed.$': '$.Payload.replayed',
    },
  });

  // One run_step state per fixed index. converse() auto-continues internally.
  const runStep = (index: number) => {
    const t = new tasks.LambdaInvoke(stack, `DocStep${index}`, {
      lambdaFunction: documentStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'run_step',
        index,
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
      }),
      resultPath: sfn.JsonPath.DISCARD, // output lives in S3; nothing to thread
    });
    return llmRetry(t);
  };

  const save = new tasks.LambdaInvoke(stack, 'DocSave', {
    lambdaFunction: documentStepLambda,
    payload: sfn.TaskInput.fromObject({
      step: 'save',
      'job_id.$': '$.job_id',
      'project_id.$': '$.project_id',
      'doc_type.$': '$.gathered.doc_type',
      'title.$': '$.gathered.title',
      'feature_idea.$': '$.gathered.feature_idea',
      'num_steps.$': '$.gathered.num_steps',
    }),
    resultPath: '$.save_result',
  });
  save.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout', 'Sandbox.Timedout'], interval: cdk.Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });

  const handleError = new tasks.LambdaInvoke(stack, 'DocHandleError', {
    lambdaFunction: documentStepLambda,
    payload: sfn.TaskInput.fromObject({
      step: 'error',
      'job_id.$': '$.job_id',
      'project_id.$': '$.project_id',
      'error.$': '$.error',
    }),
  });

  const success = new sfn.Succeed(stack, 'DocComplete');
  const fail = new sfn.Fail(stack, 'DocFailed', { cause: 'Document job failed', error: 'DocumentError' });
  handleError.next(fail);
  // addCatch mutates the state's Catch list, so call it exactly once per state.
  const addCatch = (s: tasks.LambdaInvoke) => s.addCatch(handleError, { resultPath: '$.error' });

  // Attach the error catch to every state ONCE, up front.
  addCatch(gather);
  const s0 = addCatch(runStep(0));
  const s1 = addCatch(runStep(1));
  const s2 = addCatch(runStep(2));
  const s3 = addCatch(runStep(3));
  addCatch(save);
  save.next(success);

  // PR-FAQ has a 4th chain step; PRD stops at 3. Branch on num_steps.
  // Both branches converge on the same (already-catch-wired) save state.
  const maybeStep3 = new sfn.Choice(stack, 'NeedsFourthStep')
    .when(sfn.Condition.numberGreaterThan('$.gathered.num_steps', 3),
          s3.next(save))
    .otherwise(save);

  const generation = s0
    .next(s1)
    .next(s2)
    .next(maybeStep3);
  const replayChoice = new sfn.Choice(stack, 'DocumentAlreadyGenerated')
    .when(sfn.Condition.booleanEquals('$.gathered.replayed', true), success)
    .otherwise(generation);

  const definition = gather.next(replayChoice);

  return new sfn.StateMachine(stack, 'DocumentStateMachine', {
    stateMachineName: ctx.uniqueName('voc-document-workflow'),
    definitionBody: sfn.DefinitionBody.fromChainable(definition),
    timeout: cdk.Duration.hours(2),
    tracingEnabled: true,
    logs: {
      destination: new logs.LogGroup(stack, 'DocumentStateMachineLogs', {
        logGroupName: ctx.uniqueName('/aws/stepfunctions/voc-document-workflow'),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      level: sfn.LogLevel.ALL,
    },
  });
}
