/**
 * The feature-request board's OWN Cognito user pool (docs/deployment.md, "Participant email and
 * the feature-request board"). Created on EVERY deployment (5.45.00; before, only with
 * `-c emailFrom`): boards and document review links (docs/document-review.md) sign people in
 * with an emailed code.
 *
 * Two sign-in modes, chosen by the deploy's email sender (runtime config `board.signIn`):
 * - `-c emailFrom` set: Cognito sends through SES, and the sign-in is the EMAIL_OTP first factor
 *   (a code plus a link). The pool, client and their logical ids are exactly as before, so an
 *   existing deployment's pool is updated in place, never replaced.
 * - no `-c emailFrom`: Cognito's own email (`no-reply@verificationemail.com`, limited to 50
 *   messages a day per account; EMAIL_OTP needs SES). A new person confirms their sign-up with
 *   the emailed code; a returning one gets a password-reset code and the SPA sets a fresh random
 *   password it never keeps (account recovery by email is on for exactly this). Setting
 *   `-c emailFrom` later switches the pool to SES and EMAIL_OTP.
 *
 * A separate identity from the app's pool, on purpose: the main API authorizer knows only the app
 * pool, so a board token can reach nothing but the routes whose authorizer lists this pool
 * (/feature-requests, /review, api-gateway.ts) — the fail-closed boundary. The app pool is untouched.
 *
 * Self sign-up is ON, gated by the PreSignUp trigger (lambda/auth/board_triggers.py): it refuses
 * an email no board and no active review link admits. It never auto-confirms: the emailed
 * confirmation code proves the inbox. The CustomMessage trigger renders every emailed code with a
 * `/board/login` link.
 *
 * Resources are created on the stack itself (not a child construct), like core-auth.ts.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { acknowledgeNagOnResource } from '../utils/nag-ack';
import { boardPoolMfaSuppressions, cognitoPlusOffSuppressions } from '../utils/nag-suppressions';
import { cognitoPlusEnabled, userPoolFeaturePlan } from '../utils/cognito-plus';
import { retainOnReplace } from '../utils/retain-on-replace';
import { selfContainedTriggerCode } from '../utils/self-contained-trigger';
import type { EmailSender } from '../utils/email-sender';
import type { CoreBuildContext } from './core-cdn';
import { USER_POOL_STANDARD_ATTRIBUTES, lambdaLogGroup } from './core-auth';

/** Base physical names of the two trigger functions (lib/sizing/policy.ts sizes them). */
const BOARD_PRE_SIGN_UP_FUNCTION_BASE_NAME = 'voc-board-pre-sign-up';
const BOARD_CUSTOM_MESSAGE_FUNCTION_BASE_NAME = 'voc-board-custom-message';

/** Trigger memory: one GetItem or a string render; well inside Cognito's 5 s trigger budget. */
// 128 MB peaked at 74.2 % on the PreSignUp trigger (2026-11-09 capacity check): one step up (lib/sizing/policy.ts).
const BOARD_TRIGGER_MEMORY_MB = 256;
const BOARD_TRIGGER_TIMEOUT = cdk.Duration.seconds(5);

/**
 * The SPA signs up with a random password it never keeps (sign-in is the emailed code). It is 32
 * characters with at least one upper-case letter, lower-case letter, digit and Cognito-allowed symbol
 * (frontend services/boardCognito.ts `randomBoardPassword`, pinned by its test), so the pool holds it to
 * the app pool's character classes too (cdk-nag COG1) and 16 characters, twice the app pool's 8.
 * The policy is checked only when a password is SET (sign-up, ConfirmForgotPassword), never at an
 * EMAIL_OTP sign-in, so it cannot lock out an existing board user.
 */
const BOARD_PASSWORD_MIN_LENGTH = 16;

export interface BoardAuthInputs {
  participantsTable: dynamodb.Table;
  /** Review links (`DOCSHARE#{id}`) the PreSignUp trigger reads, one item per sign-up. */
  projectsTable: dynamodb.Table;
  kmsKey: kms.Key;
  frontendDomainName: string;
  /** `-c emailFrom`: SES + EMAIL_OTP; undefined: Cognito's default email + the code sign-in. */
  sender?: EmailSender;
}

/** How the board pool signs people in (runtime config `board.signIn`, frontend services/boardAuth.ts). */
type BoardSignInMode = 'email_otp' | 'code';

export interface BoardAuth {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  signIn: BoardSignInMode;
}

/**
 * The files the trigger bundle ships, relative to `lambda/` — and nothing else.
 * `auth/board_triggers.py` imports `shared.participants_settings` and `shared.review_share_audience`;
 * all are stdlib (+ the runtime's boto3) only, and lambda/auth/test/test_board_triggers_bundle.py
 * imports the trigger with ONLY these files on sys.path to keep it that way.
 */
export const BOARD_TRIGGER_FILES = [
  'auth/board_triggers.py',
  'shared/__init__.py',
  'shared/participants_settings.py',
  'shared/review_share_audience.py',
] as const;


/** One board trigger (stdlib + boto3, no layer), Python 3.14 ARM64, 30-day logs. */
function boardTrigger(
  ctx: CoreBuildContext,
  id: string,
  spec: { baseName: string; description: string; environment: Record<string, string> },
): lambda.Function {
  return new lambda.Function(ctx.stack, id, {
    functionName: ctx.uniqueName(spec.baseName),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    // Path-style (the runtime turns `/` into `.`): `auth.board_triggers` beside `shared/`. One entry
    // point for both triggers (it dispatches on the trigger source); each function keeps its own role.
    handler: 'auth/board_triggers.handler',
    code: selfContainedTriggerCode(BOARD_TRIGGER_FILES),
    memorySize: BOARD_TRIGGER_MEMORY_MB,
    timeout: BOARD_TRIGGER_TIMEOUT,
    description: spec.description,
    environment: { ...spec.environment, LOG_LEVEL: 'INFO' },
    logGroup: lambdaLogGroup(ctx.stack, `${id}Logs`),
  });
}

/** The pool's email and first factors: SES + EMAIL_OTP with a sender, Cognito's own email without. */
function signInSettings(sender: EmailSender | undefined): Pick<cognito.UserPoolProps, 'email' | 'signInPolicy' | 'accountRecovery'> {
  if (sender !== undefined) {
    return {
      email: cognito.UserPoolEmail.withSES({ fromEmail: sender.address, sesVerifiedDomain: sender.domain }),
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      // No recovery: there is no password to recover — a new code is the recovery.
      accountRecovery: cognito.AccountRecovery.NONE,
    };
  }
  return {
    // Cognito's default sender (no-reply@verificationemail.com): 50 emails a day per account.
    email: cognito.UserPoolEmail.withCognito(),
    // EMAIL_OTP needs SES, so PASSWORD is the only first factor here — a password the SPA sets from
    // an emailed reset code and never keeps (frontend services/boardAuth.ts).
    signInPolicy: { allowedFirstAuthFactors: { password: true } },
    // The returning person's emailed code IS the password-reset code.
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
  };
}

export function createBoardAuth(ctx: CoreBuildContext, inputs: BoardAuthInputs): BoardAuth {
  const { stack } = ctx;
  const { participantsTable, projectsTable, kmsKey, frontendDomainName, sender } = inputs;
  // Both functions run the same dispatching entry point, so both carry what it reads; only the
  // pre-sign-up role may use the tables (the custom-message one has no table or key grant at all).
  const environment = {
    PARTICIPANTS_TABLE: participantsTable.tableName,
    PROJECTS_TABLE: projectsTable.tableName,
    FRONTEND_URL: `https://${frontendDomainName}`,
  };

  const preSignUp = boardTrigger(ctx, 'BoardPreSignUpLambda', {
    baseName: BOARD_PRE_SIGN_UP_FUNCTION_BASE_NAME,
    description: 'Board sign-up: an address some board or an active review link admits',
    environment,
  });
  // Exactly the item reads it needs (SETTINGS rows; one DOCSHARE#{id} / META) and the key — no index, no write.
  preSignUp.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [participantsTable.tableArn, projectsTable.tableArn],
  }));
  kmsKey.grantDecrypt(preSignUp);

  const customMessage = boardTrigger(ctx, 'BoardCustomMessageLambda', {
    baseName: BOARD_CUSTOM_MESSAGE_FUNCTION_BASE_NAME,
    description: 'Board sign-in email: the emailed code and a sign-in link',
    environment,
  });

  const userPool = new cognito.UserPool(stack, 'VocBoardUserPool', {
    userPoolName: ctx.uniqueName('voc-board-user-pool'),
    selfSignUpEnabled: true,
    signInAliases: { email: true },
    signInCaseSensitive: false,
    autoVerify: { email: true },
    standardAttributes: USER_POOL_STANDARD_ATTRIBUTES,
    passwordPolicy: {
      minLength: BOARD_PASSWORD_MIN_LENGTH,
      requireLowercase: true,
      requireUppercase: true,
      requireDigits: true,
      requireSymbols: true,
    },
    // Choice-based (USER_AUTH) sign-in, and Email OTP with a sender; both need the Essentials plan
    // (or Plus with `-c cognitoPlus=true` / performanceTier, lib/utils/cognito-plus.ts).
    ...userPoolFeaturePlan(stack),
    mfa: cognito.Mfa.OFF,
    ...signInSettings(sender),
    removalPolicy: ctx.dataProtection.removalPolicy,
    deletionProtection: ctx.dataProtection.deletionProtection,
    lambdaTriggers: { preSignUp, customMessage },
  });
  // Kept if a change ever forces a replacement: a board user's email keys their supports.
  retainOnReplace(userPool);
  acknowledgeNagOnResource(userPool, [
    ...boardPoolMfaSuppressions, ...(cognitoPlusEnabled(stack) ? [] : cognitoPlusOffSuppressions),
  ]);

  const userPoolClient = userPool.addClient('VocBoardWebClient', {
    userPoolClientName: ctx.uniqueName('voc-board-web-client'),
    // ALLOW_USER_AUTH (+ ALLOW_REFRESH_TOKEN_AUTH, which CDK adds with any flow): EMAIL_OTP only.
    authFlows: { user: true },
    // The SPA calls InitiateAuth / RespondToAuthChallenge directly; no hosted UI, no OAuth.
    disableOAuth: true,
    preventUserExistenceErrors: true,
    generateSecret: false,
    authSessionValidity: cdk.Duration.minutes(10),
    accessTokenValidity: cdk.Duration.hours(1),
    idTokenValidity: cdk.Duration.hours(1),
    refreshTokenValidity: cdk.Duration.days(30),
  });

  return { userPool, userPoolClient, signIn: sender === undefined ? 'code' : 'email_otp' };
}
