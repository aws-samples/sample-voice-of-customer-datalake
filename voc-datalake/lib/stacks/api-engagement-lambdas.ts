/**
 * VocApiStack's people-facing API Lambdas: logs, users, feedback forms (the
 * embeddable widget), anonymous ballots and chat sessions.
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { stackModelArns } from '../utils/model-allowlist';
import { snapStartFunctionProps } from '../utils/snapstart';
import { PII_REDACTION_ENV, piiDetectionStatement } from '../utils/pii-redaction';
import type { ApiStackContext } from './api-context';

export interface EngagementLambdas {
  logsLambda: lambda.Function;
  usersLambda: lambda.Function;
  feedbackFormLambda: lambda.Function;
  ballotsLambda: lambda.Function;
  chatLambda: lambda.Function;
}

/** What the engagement Lambdas take from the data builder (see `DataLambdas`). */
export interface EngagementInputs {
  enabledSourcesEnv: string;
}

export function createEngagementLambdas(ctx: ApiStackContext, inputs: EngagementInputs): EngagementLambdas {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const {
    feedbackTable, aggregatesTable, projectsTable, conversationsTable, kmsKey, userPool, processingQueueUrl,
    processingQueueArn, brandName,
  } = ctx.props;

  // Logs API
  const logsRole = ctx.role('LogsLambdaRole');
  aggregatesTable.grantReadWriteData(logsRole);
  kmsKey.grantDecrypt(logsRole);

  const logsLambda = new lambda.Function(stack, 'LogsApi', {
    functionName: ctx.uniqueName('voc-logs-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'logs_handler.lambda_handler',
    code: createApiLambdaCode('logs_handler.py'),
    role: logsRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1024, // CPU-bound (105 % p95 at 512 MB, docs/lambda-sizing.md): memory buys vCPU
    environment: { AGGREGATES_TABLE: aggregatesTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-logs-api', LOG_LEVEL: 'INFO', ENABLED_SOURCES: inputs.enabledSourcesEnv },
    layers: [apiLayer],
    logGroup: ctx.logGroup('LogsApiLogs', ctx.uniqueName('voc-logs-api')),
  });

  // Users API
  const usersRole = ctx.role('UsersLambdaRole');
  // ListGroups + ListUsersInGroup: GET /users reads memberships per group
  // (a constant few calls) instead of AdminListGroupsForUser per user (E2E F10).
  usersRole.addToPolicy(new iam.PolicyStatement({
    actions: ['cognito-idp:ListUsers', 'cognito-idp:ListGroups', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminUpdateUserAttributes', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:AdminResetUserPassword', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminDeleteUser'],
    resources: [userPool.userPoolArn],
  }));
  // Per-user category access rows (CATEGORY_ACCESS / USER#{sub}) live in
  // aggregates: read and write one item. BatchGetItem: the user list reads
  // every listed user's USERFLAGS row in one call (shared/user_flags.py).
  aggregatesTable.grant(usersRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:BatchGetItem');
  kmsKey.grantEncryptDecrypt(usersRole);

  const usersLambda = new lambda.Function(stack, 'UsersApi', {
    functionName: ctx.uniqueName('voc-users-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'users_handler.lambda_handler',
    code: createApiLambdaCode('users_handler.py'),
    role: usersRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    environment: { USER_POOL_ID: userPool.userPoolId, AGGREGATES_TABLE: aggregatesTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-users-api', LOG_LEVEL: 'INFO' },
    layers: [apiLayer],
    logGroup: ctx.logGroup('UsersApiLogs', ctx.uniqueName('voc-users-api')),
  });

  // Feedback Form API
  const feedbackFormRole = ctx.role('FeedbackFormLambdaRole');
  aggregatesTable.grantReadWriteData(feedbackFormRole);
  feedbackTable.grantReadData(feedbackFormRole);
  kmsKey.grantEncryptDecrypt(feedbackFormRole);
  feedbackFormRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
  // A submission gets its source's PII policy before it is queued.
  feedbackFormRole.addToPolicy(piiDetectionStatement());

  const feedbackFormLambda = new lambda.Function(stack, 'FeedbackFormApi', {
    ...snapStartFunctionProps(), // GET /feedback-forms cold start (lib/utils/snapstart.ts)
    functionName: ctx.uniqueName('voc-feedback-form-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'feedback_form_handler.lambda_handler',
    code: createApiLambdaCode('feedback_form_handler.py'),
    role: feedbackFormRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1024, // CPU-bound: 512 MB breached 70 % (3.00.00 capacity, lib/sizing/policy.ts)
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      FEEDBACK_TABLE: feedbackTable.tableName,
      PROCESSING_QUEUE_URL: processingQueueUrl,
      BRAND_NAME: brandName,
      ...PII_REDACTION_ENV,
      // '*', DELIBERATELY, and the one Lambda in this stack that gets it rather
      // than `allowedOrigin`. The three public routes below
      // (/feedback-forms/{form_id}/config, /submit, /iframe) are fetched by
      // lambda/api/static/feedback-widget.js running on the CUSTOMER's own site,
      // so the Origin the browser sends is a domain this stack has never heard
      // of and cannot enumerate. Any single value here would break every embed.
      //
      // Stated HERE rather than left to the handler's own
      // `os.environ.get('ALLOWED_ORIGIN', '*')` fallback: the effective value was
      // already '*', but it arrived from a Python default, so a reader of this
      // stack saw an omission where 14 other Lambdas name the variable. This
      // makes the wildcard a recorded decision. Compare the ballots Lambda
      // below, whose comment records the opposite choice for the same reason.
      //
      // The permissiveness is bounded by the ROUTES, not by this variable: every
      // other route on this function carries the Cognito authorizer and is
      // refused before the handler runs, and a CORS header never grants access
      // to a caller that is not a browser anyway.
      //
      // TWO CONSEQUENCES, both deliberate and both out of scope to fix here:
      //
      // 1. This is the ONE Lambda in this stack whose CORS origin is
      //    INDEPENDENT OF THE `environment` CONTEXT. Every other API Lambda
      //    takes `allowedOrigin`, which is `isDev ? '*' : https://<frontend>`
      //    (see its declaration above), so `-c environment=dev` moves all of
      //    them and has no effect whatsoever on this one. Nothing at deploy
      //    time can tighten this value; changing it means editing this line.
      //    Worth knowing before adding a deployment-time CORS control and
      //    expecting it to cover the widget.
      //
      // 2. The wildcard is FUNCTION-WIDE, not route-wide. This function also
      //    serves the authenticated /feedback-forms, /{form_id}, /submissions
      //    and /stats routes, so their responses carry '*' too — which is the
      //    very reasoning the ballots Lambda's comment uses to REJECT '*' for
      //    itself. The paragraph above is why that is safe rather than why it
      //    is tidy: the honest shape is two variables (ALLOWED_ORIGIN = the
      //    site origin, plus a PUBLIC_ALLOWED_ORIGIN = '*' returned only on the
      //    three widget responses), which is a feedback_form_handler.py change
      //    and therefore a follow-up, not part of a CDK-only change.
      ALLOWED_ORIGIN: '*',
      POWERTOOLS_SERVICE_NAME: 'voc-feedback-form-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('FeedbackFormApiLogs', ctx.uniqueName('voc-feedback-form-api')),
  });

  // Anonymous Ballots API (voting sessions)
  //
  // Its OWN Lambda, its own role and its own resource tree, because two of its
  // routes are served without credentials. A public route carved out of the
  // authenticated /projects proxy is the shape that once left form update,
  // delete and submission reads anonymous (see api-stack.test.ts), and the
  // feedback-form routes are public for a customer widget rather than for this.
  //
  // ONE WRITABLE TABLE: the aggregates table, which holds both the voting
  // session records and the prioritization ballots (plus a single GetItem on the
  // projects table, below, for the project-access gate). Deliberately NO feedback
  // table and NO processing-queue grant — a ballot is a decision record, not
  // customer voice, so it must never be enriched, given a sentiment or assigned
  // a persona. The absent grants are what enforce that rather than remember it.
  //
  // THREE ACTIONS, not `grantReadWriteData`. That convenience method hands over
  // Query, Scan, DeleteItem, BatchGetItem and BatchWriteItem across the WHOLE
  // aggregates table, which also holds every feedback-form configuration and
  // every signed-in reviewer's ballot — and this is the one function in the
  // stack that two unauthenticated routes can reach. The handler reads one item
  // at a time (`get_item`), creates a session (`put_item`) and upserts
  // (`update_item`); it never lists, never deletes, never writes in bulk. So a
  // caller who found a flaw in it still cannot enumerate the table or erase
  // anybody's vote. `ballots Lambda IAM grants` in api-stack.test.ts pins both
  // the three actions and the absence of the rest.
  //
  // `UpdateItem` also covers the ballot write's TRANSACTION, and no fourth action
  // is needed for it. `TransactWriteItems` is authorised per PARTICIPANT rather
  // than as an action of its own, and both of that transaction's participants are
  // `Update` — the ballot record, and the row's freeze mark plus the counter a row
  // delete fences on. It needs no `ConditionCheckItem`, because the row's condition
  // rides on its own `Update` rather than on a separate `ConditionCheck`; that
  // shape is what keeps this role at three actions.
  const ballotsRole = ctx.role('BallotsLambdaRole');
  aggregatesTable.grant(ballotsRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
  // ONE read on the projects table: opening a session is gated on the caller's
  // edit access to the row's project (shared/project_access.py), which needs
  // that project's META. GetItem only — no Query/Scan, so a flaw here still
  // cannot enumerate projects.
  projectsTable.grant(ballotsRole, 'dynamodb:GetItem');
  kmsKey.grantEncryptDecrypt(ballotsRole);

  const ballotsLambda = new lambda.Function(stack, 'BallotsApi', {
    functionName: ctx.uniqueName('voc-ballots-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'ballots_handler.lambda_handler',
    code: createApiLambdaCode('ballots_handler.py'),
    role: ballotsRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06 picked 512 (balanced); kept at 1024 because 512 projects
    // to 71.5 % CPU on the production evidence (lib/sizing/policy.ts, voc-e2e/verify/power-tuning)
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      PROJECTS_TABLE: projectsTable.tableName,
      // The SAME origin every other API Lambda gets, not '*'. A phone reaches
      // the ballot page by opening `/vote/{id}` on this app's own CloudFront
      // domain, so the browser sends that domain as its Origin exactly as it
      // does for every other page — being unauthenticated changes nothing about
      // where the page is served from. And '*' here would loosen the three
      // FACILITATOR routes too, which live on this same function.
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-ballots-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('BallotsApiLogs', ctx.uniqueName('voc-ballots-api')),
  });

  // Chat API
  const chatRole = ctx.role('ChatLambdaRole');
  feedbackTable.grantReadData(chatRole);
  aggregatesTable.grantReadWriteData(chatRole);
  conversationsTable.grantReadWriteData(chatRole);
  kmsKey.grantEncryptDecrypt(chatRole);
  chatRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: stackModelArns(stack),
  }));

  const chatLambda = new lambda.Function(stack, 'ChatApi', {
    functionName: ctx.uniqueName('voc-chat-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'chat_handler.lambda_handler',
    code: createApiLambdaCode('chat_handler.py'),
    role: chatRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: { FEEDBACK_TABLE: feedbackTable.tableName, AGGREGATES_TABLE: aggregatesTable.tableName, CONVERSATIONS_TABLE: conversationsTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-chat-api', LOG_LEVEL: 'INFO' },
    layers: [apiLayer],
    logGroup: ctx.logGroup('ChatApiLogs', ctx.uniqueName('voc-chat-api')),
  });

  return { logsLambda, usersLambda, feedbackFormLambda, ballotsLambda, chatLambda };
}
