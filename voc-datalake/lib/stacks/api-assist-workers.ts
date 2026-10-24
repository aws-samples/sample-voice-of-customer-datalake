/**
 * Assist workers: a 15-minute twin of each API Lambda whose routes run a long
 * model call (contract: lambda/shared/assist_jobs.py; "Workers: a twin of
 * each API Lambda").
 *
 * API Gateway cuts a REST integration at 29 s, so a route that waits on a slow
 * model answer starts an assist job instead (`shared/assist_jobs.start`): it
 * writes the job row, invokes the twin ASYNCHRONOUSLY by name and answers 202;
 * the browser polls the row. The twin is the API function itself — same code
 * asset, handler, role, layers and environment — with a 15-minute timeout and no
 * API Gateway integration; its `lambda_handler` recognises the assist event
 * first (`assist_jobs.is_assist_event`) and runs the work registered for it.
 *
 * Resources are created on the stack itself (api-context.ts): new logical ids
 * only, nothing existing moves.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { ApiStackContext } from './api-context';

/** Base physical names (before `uniqueName()`), one per twinned API Lambda. */
export const PROJECTS_ASSIST_FUNCTION_BASE_NAME = 'voc-projects-assist';
export const SETTINGS_ASSIST_FUNCTION_BASE_NAME = 'voc-settings-assist';
export const SCRAPERS_ASSIST_FUNCTION_BASE_NAME = 'voc-scrapers-assist';

/** The env var naming the twin on its API Lambda (read by `shared/assist_jobs.start`'s callers). */
export const ASSIST_WORKER_ENV = 'ASSIST_WORKER_FUNCTION';

/**
 * Exactly the jobs-table item actions `shared/assist_jobs.py` calls: the start's
 * put, the poll's consistent get, the worker's conditional claim and finish.
 * Granted to the roles that held no jobs-table access before (settings,
 * scrapers); the projects role already reads and writes the table.
 */
export const ASSIST_JOB_TABLE_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'] as const;

/** Lambda's own ceiling: the slowest model answer the platform waits for. */
const ASSIST_WORKER_TIMEOUT = cdk.Duration.minutes(15);

/**
 * How long a queued async event may wait for a free execution environment
 * (throttling) before Lambda drops it to the failure destination. An hour: the
 * browser stops polling at 15 minutes, so an older start is of no use to anyone.
 */
const ASSIST_WORKER_MAX_EVENT_AGE = cdk.Duration.hours(1);

/** The twin's physical name, prefix-aware. */
export function assistWorkerName(ctx: ApiStackContext, baseName: string): string {
  return ctx.uniqueName(baseName);
}

/**
 * Lets `role` invoke the twin. The ARN is built BY NAME: the twin shares the
 * API function's role, so `grantInvoke()` would make the role's policy depend on
 * a function that depends on the role (the same reason the settings self-invoke
 * is built this way).
 */
export function grantAssistWorkerInvoke(ctx: ApiStackContext, role: iam.Role, workerName: string): void {
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [functionArnByName(ctx, workerName)],
  }));
}

/** `arn:<partition>:lambda:<region>:<account>:function:<name>` of a function in this stack's account
 *  and region, unqualified ($LATEST). */
export function functionArnByName(ctx: ApiStackContext, functionName: string): string {
  return ctx.stack.formatArn({
    service: 'lambda',
    resource: 'function',
    resourceName: functionName,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}

/**
 * The twin of the API function built from `apiProps`.
 *
 * Inherits everything that makes it the SAME function (code asset, handler,
 * role, runtime, architecture, layers, environment) and overrides only
 * what makes it a worker:
 * - its own MemorySize, pinned in lib/sizing/policy.ts (the API function's was
 *   raised on 2026-10-18 from REST-path evidence that does not cover the twin);
 * - its own name and log group (same two-week retention as every API Lambda);
 * - a 15-minute timeout;
 * - `retryAttempts: 0` — one assist is one model call, neither cheap nor
 *   idempotent; a hidden re-drive would re-pay for it and overwrite the job row
 *   the user is watching (same reasoning as api-job-lambdas.ts);
 * - the async failure destination every API-stack Lambda invoked with
 *   InvocationType='Event' carries (#253, api-stack-async-failures.test.ts), so
 *   a twin killed before it records its own failure still leaves a trace.
 *
 * SnapStart: none of the three twinned API functions uses it, and the twin is
 * invoked by unqualified name, i.e. $LATEST — it needs no published version or
 * alias (api-routes.ts aliases only the SnapStart API functions).
 */
export function createAssistWorker(
  ctx: ApiStackContext,
  id: string,
  spec: { baseName: string; apiProps: lambda.FunctionProps; memorySize: number },
): lambda.Function {
  const name = assistWorkerName(ctx, spec.baseName);
  return new lambda.Function(ctx.stack, id, {
    ...spec.apiProps,
    functionName: name,
    memorySize: spec.memorySize,
    timeout: ASSIST_WORKER_TIMEOUT,
    retryAttempts: 0,
    maxEventAge: ASSIST_WORKER_MAX_EVENT_AGE,
    onFailure: ctx.asyncFailureDestination,
    logGroup: ctx.logGroup(`${id}Logs`, name),
  });
}
