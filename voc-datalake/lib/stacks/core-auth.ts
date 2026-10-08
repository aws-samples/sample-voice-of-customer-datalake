/**
 * VocCoreStack's identity layer: the Cognito user pool (custom-message trigger,
 * web client, hosted-UI domain, groups), the greenfield admin bootstrap, the
 * opt-in global model pin, and the identity pool with its authenticated role.
 * Created on the stack itself (not a child construct), so logical ids are unchanged.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as fs from 'fs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { ALLOWED_MODEL_IDS } from '../utils/model-allowlist';
import {
  cognitoSecuritySuppressions,
  cdkCustomResourceSuppressions,
  dynamoDbGsiSuppressions,
  kmsEncryptionSuppressions,
  lambdaBasicExecutionRoleSuppressions,
} from '../utils/nag-suppressions';
import type { CoreBuildContext } from './core-cdn';

export interface CoreAuth {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  userPoolDomain: cognito.UserPoolDomain;
  identityPool: cognito.CfnIdentityPool;
  authenticatedRole: iam.Role;
  /** The hosted-UI domain prefix (a DNS label). */
  domainPrefix: string;
  /** The bootstrap custom resource's generated initial admin password attribute. */
  initialAdminPassword: string;
}

export function createCoreAuth(ctx: CoreBuildContext, aggregatesTable: dynamodb.Table, frontendDomainName: string): CoreAuth {
  const { stack } = ctx;

  // ============================================
  // COGNITO AUTH
  // ============================================

  // Build callback URLs
  const callbackUrls = ['http://localhost:5173', 'http://localhost:5173/callback'];
  const logoutUrls = ['http://localhost:5173'];
  callbackUrls.push(`https://${frontendDomainName}`);
  callbackUrls.push(`https://${frontendDomainName}/callback`);
  logoutUrls.push(`https://${frontendDomainName}`);

  const signInUrl = `https://${frontendDomainName}`;

  // Custom Message Lambda Trigger
  const customMessageLambda = new lambda.Function(stack, 'CustomMessageLambda', {
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromInline(customMessageLambdaCode(signInUrl)),
    timeout: cdk.Duration.seconds(10),
    description: 'Customizes Cognito email messages for different scenarios',
    logGroup: new logs.LogGroup(stack, 'CustomMessageLambdaLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });

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
    standardAttributes: {
      email: { required: true, mutable: true },
      fullname: { required: false, mutable: true },
    },
    passwordPolicy: {
      minLength: 8,
      requireLowercase: true,
      requireUppercase: true,
      requireDigits: true,
      requireSymbols: true,
    },
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    userVerification: {
      emailSubject: 'VoC Analytics - Verify your email',
      emailBody: 'Welcome to VoC Analytics!\n\nYour verification code is: {####}\n\nThis code expires in 24 hours.\n\nIf you did not request this, please ignore this email.',
      emailStyle: cognito.VerificationEmailStyle.CODE,
    },
    userInvitation: {
      emailSubject: 'VoC Analytics - Welcome! Set up your account',
      emailBody: `<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="margin: 0;">Welcome to VoC Analytics</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>You have been invited to join the platform.</p>
    <p><strong>To get started:</strong></p>
    <ol>
      <li>Go to <a href="${signInUrl}" style="color: #667eea;">${signInUrl}</a></li>
      <li>Enter your email address</li>
      <li>Use this temporary password:
        <div style="font-family: monospace; font-size: 18px; font-weight: bold; color: #667eea; margin: 8px 0;">{####}</div>
      </li>
      <li>Set your new password when prompted</li>
    </ol>
    <p style="color: #666; font-size: 13px;">(Your account ID for reference: {username})</p>
    <p style="margin-top: 24px;">Best regards,<br>The VoC Analytics Team</p>
  </div>
</body>
</html>`,
    },
    lambdaTriggers: { customMessage: customMessageLambda },
  });
  NagSuppressions.addResourceSuppressions(userPool, cognitoSecuritySuppressions);

  // User Pool Client
  const userPoolClient = userPool.addClient('VocWebClient', {
    userPoolClientName: ctx.uniqueName('voc-web-client'),
    authFlows: { userPassword: true, userSrp: true },
    oAuth: {
      flows: {
        authorizationCodeGrant: true,
        // implicitCodeGrant is disabled: it is deprecated in OAuth 2.1, returns
        // tokens in the URL fragment (browser history / Referer leakage), and
        // cannot be protected by PKCE. The app signs in via SRP
        // (amazon-cognito-identity-js) and never uses the hosted-UI redirect
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
  const userPoolDomain = userPool.addDomain('VocUserPoolDomain', {
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
      retention: logs.RetentionDays.ONE_WEEK,
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

  NagSuppressions.addResourceSuppressions(adminBootstrapLambda, lambdaBasicExecutionRoleSuppressions, true);
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stack.stackName}/AdminBootstrapProvider/framework-onEvent`,
    [
      ...cdkCustomResourceSuppressions,
      ...lambdaBasicExecutionRoleSuppressions,
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The CDK Provider framework invokes its handler by qualified ARN, requiring a version/alias wildcard scoped to AdminBootstrapLambda only (same pattern as ModelAgreementLambda).',
        appliesTo: [{ regex: '/Resource::<.*AdminBootstrapLambda.*\\.Arn>:\\*/' }],
      },
    ],
    true
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
    aggregatesTable.grantWriteData(modelPinLambda);

    const modelPinProvider = new cr.Provider(stack, 'ModelPinProvider', {
      onEventHandler: modelPinLambda,
      logGroup: new logs.LogGroup(stack, 'ModelPinProviderLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
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

    // grantWriteData() emits the standard GSI (<TableArn>/index/*) and KMS
    // (GenerateDataKey*/ReEncrypt*) wildcards, so reuse the shared
    // suppressions rather than restating the same evidence.
    NagSuppressions.addResourceSuppressions(
      modelPinLambda,
      [...lambdaBasicExecutionRoleSuppressions, ...dynamoDbGsiSuppressions, ...kmsEncryptionSuppressions],
      true,
    );
    NagSuppressions.addResourceSuppressionsByPath(
      stack,
      `${stack.stackName}/ModelPinProvider/framework-onEvent`,
      [
        ...cdkCustomResourceSuppressions,
        ...lambdaBasicExecutionRoleSuppressions,
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The CDK Provider framework invokes its handler by qualified ARN, requiring a version/alias wildcard scoped to ModelPinLambda only (same pattern as AdminBootstrapLambda).',
          appliesTo: [{ regex: '/Resource::<.*ModelPinLambda.*\\.Arn>:\\*/' }],
        },
      ],
      true
    );
  }

  // ============================================
  // COGNITO IDENTITY POOL (for AWS IAM authentication)
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

  // NO PERMISSIONS BY DESIGN: Amplify still exchanges the User Pool session
  // for Identity Pool credentials, but application code does not consume them
  // or call AWS services with them. Chat streams over `POST /chat/stream` behind
  // the Cognito authorizer, and private CDN paths use signed URLs the API mints.
  // The pool and role are retained because Amplify is configured from
  // `identityPoolId` and the JWT -> credentials exchange needs an assumable
  // role. See issue #254.

  // Attach role to Identity Pool
  new cognito.CfnIdentityPoolRoleAttachment(stack, 'IdentityPoolRoleAttachment', {
    identityPoolId: identityPool.ref,
    roles: {
      authenticated: authenticatedRole.roleArn,
    },
  });

  return {
    userPool, userPoolClient, userPoolDomain, identityPool, authenticatedRole, domainPrefix,
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
    logGroup: new logs.LogGroup(ctx.stack, `${id}Logs`, {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
}

function customMessageLambdaCode(signInUrl: string): string {
  // Note: CustomMessage_AdminCreateUser doesn't work with COGNITO_DEFAULT email sender
  // (known AWS bug). We handle it via userInvitation config instead.
  // This Lambda handles ForgotPassword and ResendCode which DO work.
  return `
import json

def handler(event, context):
    trigger_source = event.get('triggerSource', '')
    request = event.get('request', {})
    code_param = request.get('codeParameter', '{####}')
    sign_in_url = '${signInUrl}'
    
    # ForgotPassword - styled HTML email
    if trigger_source == 'CustomMessage_ForgotPassword':
        event['response']['emailSubject'] = 'VoC Analytics - Reset your password'
        event['response']['emailMessage'] = f"""<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Password Reset</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>We received a request to reset your password for VoC Analytics.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666;">Your password reset code:</p>
      <p style="font-family: monospace; font-size: 24px; font-weight: bold; color: #667eea; margin: 0;">{code_param}</p>
    </div>
    <p style="color: #666; font-size: 14px;">If you did not request this, please ignore this email.</p>
    <p style="text-align: center; margin-top: 20px;"><a href="{sign_in_url}" style="color: #667eea;">Go to VoC Analytics</a></p>
  </div>
</body>
</html>"""
    
    # ResendCode - styled HTML email  
    elif trigger_source == 'CustomMessage_ResendCode':
        event['response']['emailSubject'] = 'VoC Analytics - Your verification code'
        event['response']['emailMessage'] = f"""<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Verification Code</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>Here is your verification code for VoC Analytics.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666;">Your verification code:</p>
      <p style="font-family: monospace; font-size: 24px; font-weight: bold; color: #667eea; margin: 0;">{code_param}</p>
    </div>
    <p style="text-align: center; margin-top: 20px;"><a href="{sign_in_url}" style="color: #667eea;">Go to VoC Analytics</a></p>
  </div>
</body>
</html>"""
    
    return event
`;
}
