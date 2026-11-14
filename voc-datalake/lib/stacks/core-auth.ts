/**
 * VocCoreStack's identity layer: the Cognito user pool (custom-message trigger,
 * web client, hosted-UI domain, groups), the greenfield admin bootstrap, the
 * opt-in global model pin, and the identity pool with its authenticated role (unused by the app since
 * 5.64.00; kept until a release removes it).
 * Created on the stack itself (not a child construct), so logical ids are unchanged.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { LOG_RETENTION } from '../utils/log-retention';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as fs from 'fs';
import * as path from 'path';
import { ALLOWED_MODEL_IDS } from '../utils/model-allowlist';
import { acknowledgeNag, acknowledgeNagOnResource } from '../utils/nag-ack';
import {
  cdkCustomResourceSuppressions,
  cognitoPlusOffSuppressions,
  cognitoSecuritySuppressions,
} from '../utils/nag-suppressions';
import type { CoreBuildContext } from './core-cdn';
import { retainOnReplace } from '../utils/retain-on-replace';
import { isDevDeployment } from '../utils/context';
import { cognitoPlusEnabled, userPoolFeaturePlan } from '../utils/cognito-plus';
import { grantWrites } from '../utils/table-write-grants';
import { booleanContextFlag } from '../utils/context-flag';
import { selfContainedTriggerCode } from '../utils/self-contained-trigger';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

export interface CoreAuth {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  identityPool: cognito.CfnIdentityPool;
  /** The hosted-UI domain prefix (a DNS label). */
  domainPrefix: string;
  /** The bootstrap custom resource's generated initial admin password attribute. */
  initialAdminPassword: string;
}

/** Email (required) and name: the attributes both user pools (app, board) carry. */
export const USER_POOL_STANDARD_ATTRIBUTES: cognito.StandardAttributes = {
  email: { required: true, mutable: true },
  fullname: { required: false, mutable: true },
};

/**
 * The files the app pool's message trigger ships, relative to `lambda/` (stdlib + boto3 only):
 * lambda/auth/test/test_user_messages_bundle.py imports it with only these on sys.path.
 */
export const USER_MESSAGES_FILES = ['auth/user_messages.py'] as const;

/** The message trigger's memory: a 2.5 s cold start at 128 MB was too close to Cognito's 5 s budget (lib/sizing/policy.ts). */
const USER_MESSAGES_MEMORY_MB = 256;

/** How long an invitation's temporary password works; the pool's policy and the email both state it. */
export const TEMPORARY_PASSWORD_DAYS = 7;

/** The brand row's partition key in the aggregates table (api/settings_handler.py SETTINGS_PK). */
export const BRAND_SETTINGS_PK = 'SETTINGS#brand';

/** The design system's partition key (shared/company_context.py DESIGN_SYSTEM_PK): the invitation's accent colour. */
export const DESIGN_SYSTEM_SETTINGS_PK = 'SETTINGS#design_system';

/** The context key marking a workshop deployment: `-c workshop=true` (npm run generate:workshop-artifacts). */
const WORKSHOP_CONTEXT = 'workshop';

/**
 * Whether this deployment is for an AWS workshop: then an invitation without a configured brand names the
 * workshop and its organizer instead of a generic administrator (lambda/auth/user_messages.py). Default false.
 */
function workshopDeployment(scope: Construct): boolean {
  return booleanContextFlag(scope.node.tryGetContext(WORKSHOP_CONTEXT), WORKSHOP_CONTEXT, false,
    'Use -c workshop=true or -c workshop=false.');
}

/** A trigger's or handler's own log group: `LOG_RETENTION` (30 days), deleted with the stack. */
export function lambdaLogGroup(stack: cdk.Stack, id: string): logs.LogGroup {
  return new logs.LogGroup(stack, id, {
    retention: LOG_RETENTION,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

export function createCoreAuth(
  ctx: CoreBuildContext, aggregatesTable: dynamodb.Table, kmsKey: kms.IKey, frontendDomainName: string,
): CoreAuth {
  const { stack } = ctx;

  // ============================================
  // COGNITO AUTH
  // ============================================

  // OAuth URLs: the deployed site, plus the Vite dev server only for a dev deployment
  // (IAM-8: a production client accepts no redirect to the operator's machine).
  const signInUrl = `https://${frontendDomainName}`;
  const origins = [...(isDevDeployment(stack.node) ? ['http://localhost:5173'] : []), signInUrl];
  const callbackUrls = origins.flatMap((origin) => [origin, `${origin}/callback`]);
  const logoutUrls = origins;

  // Custom message trigger (lambda/auth/user_messages.py): the invitation names the brand, the inviter and,
  // on a workshop deployment, the AWS workshop; it also writes the password-reset and resent-code emails.
  const customMessageLambda = new lambda.Function(stack, 'CustomMessageLambda', {
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'auth/user_messages.handler',
    code: selfContainedTriggerCode(USER_MESSAGES_FILES),
    memorySize: USER_MESSAGES_MEMORY_MB,
    timeout: cdk.Duration.seconds(10),
    description: 'App sign-in emails: the invitation (brand, inviter, workshop), password reset, resent code',
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      SIGN_IN_URL: signInUrl,
      WORKSHOP: String(workshopDeployment(stack)),
      TEMP_PASSWORD_DAYS: String(TEMPORARY_PASSWORD_DAYS),
    },
    logGroup: lambdaLogGroup(stack, 'CustomMessageLambdaLogs'),
  });
  // Exactly two settings rows (SETTINGS#brand, SETTINGS#design_system), read only, and the table's key.
  customMessageLambda.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'],
    resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [BRAND_SETTINGS_PK, DESIGN_SYSTEM_SETTINGS_PK] } },
  }));
  kmsKey.grantDecrypt(customMessageLambda);

  // Cognito User Pool
  //
  // signInCaseSensitive (#105) maps to UsernameConfiguration, which Cognito
  // treats as CREATE-ONLY: introducing it on a pool deployed before #105
  // fails the whole stack update with "Updates are not allowed for property
  // - UsernameConfiguration" (issue #184). Pre-#105 stacks set the context
  // flag below to keep their pool untouched; greenfield deployments keep
  // case-insensitive sign-in.
  const omitUsernameConfigRaw = stack.node.tryGetContext('omitUserPoolUsernameConfiguration');
  const omitUsernameConfig = omitUsernameConfigRaw === true || omitUsernameConfigRaw === 'true';
  const userPool = new cognito.UserPool(stack, 'VocUserPool', {
    userPoolName: ctx.uniqueName('voc-user-pool'),
    selfSignUpEnabled: false,
    signInAliases: { email: true, username: true },
    ...(omitUsernameConfig ? {} : { signInCaseSensitive: false }),
    autoVerify: { email: true },
    standardAttributes: USER_POOL_STANDARD_ATTRIBUTES,
    passwordPolicy: {
      minLength: 8,
      requireLowercase: true,
      requireUppercase: true,
      requireDigits: true,
      requireSymbols: true,
      tempPasswordValidity: cdk.Duration.days(TEMPORARY_PASSWORD_DAYS),
    },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    // Opt-in passkeys (docs/deployment.md -> Passkeys): after sign-in the SPA offers to register one
    // (Amplify associateWebAuthnCredential), and Login can then sign in with it (USER_AUTH, WEB_AUTHN). A password
    // stays the other first factor. Passkeys need the Essentials plan (the default for new pools; set here
    // so an older Lite pool moves too), or Plus with `-c cognitoPlus=true` / performanceTier (lib/utils/cognito-plus.ts).
    // The relying party is the site the SPA is served from.
    ...userPoolFeaturePlan(stack),
    signInPolicy: { allowedFirstAuthFactors: { password: true, passkey: true } },
    passkeyRelyingPartyId: frontendDomainName,
    passkeyUserVerification: cognito.PasskeyUserVerification.REQUIRED,
    removalPolicy: ctx.dataProtection.removalPolicy,
    deletionProtection: ctx.dataProtection.deletionProtection,
    userVerification: {
      emailSubject: 'VoC Analytics - Verify your email',
      emailBody: 'Welcome to VoC Analytics!\n\nYour verification code is: {####}\n\nThis code expires in 24 hours.\n\nIf you did not request this, please ignore this email.',
      emailStyle: cognito.VerificationEmailStyle.CODE,
    },
    userInvitation: {
      // Only a fallback: the custom-message trigger (lambda/auth/user_messages.py) writes the real invitation,
      // naming the brand, the inviter and the workshop. Cognito sends this text only if the trigger fails.
      emailSubject: 'You are invited to VoC Analytics',
      emailBody: `<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: #4c51bf; padding: 24px 30px;">
    <h1 style="color: #ffffff; margin: 0; font-size: 22px;">Welcome to VoC Analytics</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>You have been invited to a VoC Analytics workspace.</p>
    <p>VoC (Voice of the Customer) Analytics brings your customers' feedback together and helps your team understand it with AI.</p>
    <p><strong>To sign in:</strong></p>
    <ol>
      <li>Open <a href="${signInUrl}" style="color: #4c51bf;">${signInUrl}</a></li>
      <li>Sign in with this email address and the temporary password below:
        <div style="font-family: monospace; font-size: 18px; font-weight: bold; color: #4c51bf; margin: 8px 0;">{####}</div>
      </li>
      <li>Choose your own password when asked. The temporary one works for ${TEMPORARY_PASSWORD_DAYS} days.</li>
    </ol>
    <p>If you were not expecting this invitation, check with your VoC Analytics administrator before signing in, or ignore this email.</p>
    <p style="color: #666; font-size: 12px;">Support reference: {username}</p>
  </div>
</body>
</html>`,
    },
    lambdaTriggers: { customMessage: customMessageLambda },
  });
  // Deleted with the stack (teardown), but KEPT if a change ever forces a replacement:
  // every user's `sub` keys project ownership, conversations, memory and plan approvals.
  retainOnReplace(userPool);
  acknowledgeNagOnResource(userPool, [
    ...cognitoSecuritySuppressions, ...(cognitoPlusEnabled(stack) ? [] : cognitoPlusOffSuppressions),
  ]);

  // User Pool Client
  const userPoolClient = userPool.addClient('VocWebClient', {
    userPoolClientName: ctx.uniqueName('voc-web-client'),
    // `user` = the choice-based USER_AUTH flow, which passkey sign-in uses.
    authFlows: { userPassword: true, userSrp: true, user: true },
    oAuth: {
      flows: {
        authorizationCodeGrant: true,
        // implicitCodeGrant is disabled: it is deprecated in OAuth 2.1, returns
        // tokens in the URL fragment (browser history / Referer leakage), and
        // cannot be protected by PKCE. The app signs in via SRP
        // (Amplify v6, aws-amplify/auth) and never uses the hosted-UI redirect
        // flow, so nothing here depends on it.
        implicitCodeGrant: false,
      },
      scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
      callbackUrls,
      logoutUrls,
    },
    preventUserExistenceErrors: true,
    generateSecret: false,
    accessTokenValidity: cdk.Duration.hours(1),
    idTokenValidity: cdk.Duration.hours(1),
    refreshTokenValidity: cdk.Duration.days(30),
  });

  // User Pool Domain. A hosted-UI domain prefix is a DNS label, so it is held
  // to 63 characters rather than the 64 most names get.
  const domainPrefix = ctx.uniqueDnsName('voc');
  userPool.addDomain('VocUserPoolDomain', {
    cognitoDomain: { domainPrefix },
  });

  // User groups
  const adminGroup = new cognito.CfnUserPoolGroup(stack, 'AdminGroup', {
    userPoolId: userPool.userPoolId,
    groupName: 'admins',
    description: 'VoC administrators with full access',
  });

  new cognito.CfnUserPoolGroup(stack, 'UsersGroup', {
    userPoolId: userPool.userPoolId,
    groupName: 'users',
    description: 'VoC users with standard access',
  });

  // The production e2e test users (since 5.63.00): every model call the app makes for a
  // member resolves to Haiku 5.5 (lambda/shared/model_profile.py, lambda/stream/src/bedrock/model-profile.ts).
  // Grants no access by itself; membership is admin-only (`aws cognito-idp admin-add-user-to-group`).
  new cognito.CfnUserPoolGroup(stack, 'E2eGroup', {
    userPoolId: userPool.userPoolId,
    groupName: 'e2e',
    description: 'Production e2e test users: every AI surface runs on Claude Haiku 5.5',
  });

  // ============================================
  // INITIAL ADMIN USER (for greenfield deployments)
  // ============================================
  // Idempotent bootstrap (issue #196). The handler generates the initial
  // password AT RUNTIME, and only when it actually creates the admin:
  //  - first deployment: create admin -> set temporary password -> add to
  //    admins group -> the real password surfaces in InitialAdminPassword
  //    (printing it is BY DESIGN: it is how operators find their first
  //    login, and first use forces a change).
  //  - any redeployment / admin already exists: strict no-op — no user
  //    creation, no password reset, no fresh password minted. All resource
  //    properties are deterministic, so the template no longer churns.
  const adminBootstrapLambda = createInlineCustomResourceHandler(ctx, 'AdminBootstrapLambda', {
    baseName: 'voc-admin-bootstrap',
    sourceFile: 'admin_bootstrap.py',
    description: 'Idempotent initial-admin bootstrap (create once, never reset)',
  });
  adminBootstrapLambda.addToRolePolicy(new iam.PolicyStatement({
    actions: [
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminSetUserPassword',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminListGroupsForUser',
    ],
    resources: [userPool.userPoolArn],
  }));

  const adminBootstrapProvider = new cr.Provider(stack, 'AdminBootstrapProvider', {
    onEventHandler: adminBootstrapLambda,
    // MUST stay FATAL: at INFO the provider framework logs the full
    // custom resource response — including Data.Password — to CloudWatch.
    // FATAL is the aws-cdk-lib default today; pinning it guards against a
    // default change and against anyone raising it while debugging.
    frameworkLambdaLoggingLevel: lambda.ApplicationLogLevel.FATAL,
    logGroup: new logs.LogGroup(stack, 'AdminBootstrapProviderLogs', {
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });

  const adminBootstrap = new cdk.CustomResource(stack, 'AdminBootstrap', {
    serviceToken: adminBootstrapProvider.serviceToken,
    resourceType: 'Custom::AdminBootstrap',
    properties: {
      UserPoolId: userPool.userPoolId,
      Username: 'admin',
      Email: 'admin@local.host',
      GroupName: 'admins',
    },
  });
  adminBootstrap.node.addDependency(adminGroup);

  acknowledgeNag(
    adminBootstrapProvider.node.findChild('framework-onEvent'),
    cdkCustomResourceSuppressions,
  );

  // ============================================
  // GLOBAL MODEL PIN (opt-in, for accounts that cannot use the newest models)
  // ============================================
  // `-c defaultModelId=<allowlisted id>` seeds settings.model_id, the legacy
  // global override that outranks SURFACE_DEFAULTS in both resolvers
  // (shared/model_config.py and lambda/stream/src/bedrock/model-override.ts).
  // One attribute therefore repoints every AI surface without touching the
  // built-in defaults, so deployments that CAN use the newer models are
  // unaffected.
  //
  // Motivating case: Workshop Studio events sit behind a Private Marketplace
  // that refuses the model agreements for Sonnet 5 / Opus 5, and they are
  // fully automated — there is no human to pick a model per participant
  // account. Without the flag nothing below is created at all.
  const defaultModelIdRaw = stack.node.tryGetContext('defaultModelId');
  if (defaultModelIdRaw !== undefined && defaultModelIdRaw !== null && defaultModelIdRaw !== '') {
    const defaultModelId = String(defaultModelIdRaw);
    // Fail at synth rather than writing a value the app would ignore:
    // _allowlisted() drops non-allowlisted ids at read time, which would
    // silently fall back to the defaults this flag exists to avoid.
    if (!ALLOWED_MODEL_IDS.includes(defaultModelId)) {
      throw new Error(
        `defaultModelId '${defaultModelId}' is not in the model allowlist. ` +
        `Allowed: ${ALLOWED_MODEL_IDS.join(', ')}`,
      );
    }

    const modelPinLambda = createInlineCustomResourceHandler(ctx, 'ModelPinLambda', {
      baseName: 'voc-model-pin',
      sourceFile: 'model_pin.py',
      description: 'Seeds the global Bedrock model pin (create once, never reset)',
    });
    // One conditional UpdateItem on the pin row (model_pin.py): no read, no put, no delete.
    grantWrites(aggregatesTable, modelPinLambda, ['UpdateItem']);

    const modelPinProvider = new cr.Provider(stack, 'ModelPinProvider', {
      onEventHandler: modelPinLambda,
      logGroup: new logs.LogGroup(stack, 'ModelPinProviderLogs', {
        retention: LOG_RETENTION,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    new cdk.CustomResource(stack, 'ModelPin', {
      serviceToken: modelPinProvider.serviceToken,
      resourceType: 'Custom::ModelPin',
      properties: {
        TableName: aggregatesTable.tableName,
        ModelId: defaultModelId,
      },
    });

    new cdk.CfnOutput(stack, 'DefaultModelPin', { value: defaultModelId });

    acknowledgeNag(
      modelPinProvider.node.findChild('framework-onEvent'),
      cdkCustomResourceSuppressions,
    );
  }

  // ============================================
  // COGNITO IDENTITY POOL (unused since 5.64.00: no app code exchanges tokens for AWS credentials)
  // ============================================
  const identityPool = new cognito.CfnIdentityPool(stack, 'VocIdentityPool', {
    identityPoolName: ctx.uniqueName('voc-identity-pool'),
    allowUnauthenticatedIdentities: false,
    cognitoIdentityProviders: [{
      clientId: userPoolClient.userPoolClientId,
      providerName: userPool.userPoolProviderName,
    }],
  });

  // Create authenticated role for Identity Pool users
  const authenticatedRole = new iam.Role(stack, 'CognitoAuthenticatedRole', {
    assumedBy: new iam.FederatedPrincipal(
      'cognito-identity.amazonaws.com',
      {
        StringEquals: {
          'cognito-identity.amazonaws.com:aud': identityPool.ref,
        },
        'ForAnyValue:StringLike': {
          'cognito-identity.amazonaws.com:amr': 'authenticated',
        },
      },
      'sts:AssumeRoleWithWebIdentity'
    ),
    description: 'Role for authenticated Cognito Identity Pool users',
  });

  // NO PERMISSIONS BY DESIGN: since 5.61.00 the SPA configures Amplify with the
  // user pool only, and since 5.64.00 it no longer reads identityPoolId (config.json
  // still carries it for one release, for cached older pages), so nothing exchanges
  // a User Pool session for Identity Pool credentials. Chat streams over
  // `POST /chat/stream` behind the Cognito authorizer, and private CDN paths use
  // signed URLs the API mints. The pool and role stay until the release that
  // deletes them (CHANGELOG 5.64.00, Deprecated). See issue #254.

  // Attach role to Identity Pool
  new cognito.CfnIdentityPoolRoleAttachment(stack, 'IdentityPoolRoleAttachment', {
    identityPoolId: identityPool.ref,
    roles: {
      authenticated: authenticatedRole.roleArn,
    },
  });

  return {
    userPool, userPoolClient, identityPool, domainPrefix,
    initialAdminPassword: adminBootstrap.getAttString('Password'),
  };
}

/**
 * The on-event handler behind a custom-resource Provider: a real, unit-tested
 * file under lambda/custom_resources (see its test/), inlined so a small
 * handler needs no asset bundling. Its log group is `<id>Logs`.
 */
function createInlineCustomResourceHandler(
  ctx: CoreBuildContext,
  id: string,
  handler: { baseName: string; sourceFile: string; description: string },
): lambda.Function {
  return new lambda.Function(ctx.stack, id, {
    functionName: ctx.uniqueName(handler.baseName),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromInline(
      fs.readFileSync(path.join(__dirname, '../../lambda/custom_resources', handler.sourceFile), 'utf8'),
    ),
    timeout: cdk.Duration.minutes(1),
    description: handler.description,
    logGroup: lambdaLogGroup(ctx.stack, `${id}Logs`),
  });
}
