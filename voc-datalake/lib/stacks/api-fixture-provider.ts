/**
 * VocApiStack's verification-only fixture provider (prefixed deployments that
 * opt in). Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { ApiStackContext } from './api-context';

export function createVerificationFixtureProvider(ctx: ApiStackContext): void {
  const { stack, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const { aggregatesTable, projectsTable, kmsKey } = ctx.props;

  // Verification-only infrastructure, behind TWO independent conditions.
  //
  // A prefix alone is not enough. `deploymentPrefix` means "this is a
  // side-by-side copy" — a PRODUCTION slot can be one too — so topology must
  // not be the only thing standing between a live table and a Lambda that can
  // delete rows in it. The capability must also be asked for by intent.
  // Requiring both also keeps `no prefix means byte-identical`
  // (lib/app-baseline.test.ts) true for every default deploy.
  //
  // Read ONCE, and accept only `true`/`'true'` as with skipUseCaseSubmission
  // (CLI context always arrives as a string). Anything else is off, and off
  // means "no provider" — so a typo drops the fixture capability and the
  // verification run fails closed and loudly, which is the safe direction.
  const fixtureProviderContext: unknown = stack.node.tryGetContext('enableVerificationFixtureProvider');
  const enableVerificationFixtureProvider =
    fixtureProviderContext === true || fixtureProviderContext === 'true';
  if (ctx.deploymentPrefix && enableVerificationFixtureProvider) {
    // Private, target-owned fixture provider. No API route, Cognito authorizer,
    // Function URL, frontend config, or model access: ABCA may invoke one closed
    // setup/probe/teardown contract, while VoC retains every storage key/item rule.
    const verificationFixtureProviderRole = ctx.role(
      'VerificationFixtureProviderRole',
    );
    // Scoped to the two TABLE ARNs and nothing else. `Table.grant()` would
    // also add `<table>/index/*` because these tables carry GSIs, but the
    // provider only ever touches exact keys — it never queries an index — so
    // the wildcard would be unused privilege and an AwsSolutions-IAM5 finding.
    verificationFixtureProviderRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [projectsTable.tableArn, aggregatesTable.tableArn],
    }));
    const verificationKmsViaDynamo = {
      StringEquals: {
        'kms:ViaService': `dynamodb.${stack.region}.${stack.urlSuffix}`,
        'kms:CallerAccount': stack.account,
      },
    };
    const verificationKmsTableContext = {
      ...verificationKmsViaDynamo,
      'ForAnyValue:StringEquals': {
        'kms:EncryptionContext:aws:dynamodb:tableName': [
          projectsTable.tableName,
          aggregatesTable.tableName,
        ],
      },
    };
    verificationFixtureProviderRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'kms:Decrypt',
        'kms:Encrypt',
        'kms:ReEncryptFrom',
        'kms:ReEncryptTo',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
      ],
      resources: [kmsKey.keyArn],
      conditions: verificationKmsTableContext,
    }));
    verificationFixtureProviderRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:DescribeKey'],
      resources: [kmsKey.keyArn],
      conditions: verificationKmsViaDynamo,
    }));
    const verificationFixtureProvider = new lambda.Function(
      stack,
      'VerificationFixtureProvider',
      {
        functionName: ctx.uniqueName('voc-fixture-provider'),
        runtime: lambda.Runtime.PYTHON_3_14,
        architecture: lambda.Architecture.ARM_64,
        handler: 'verification_fixture_provider.lambda_handler',
        code: createApiLambdaCode('verification_fixture_provider.py'),
        role: verificationFixtureProviderRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          PROJECTS_TABLE: projectsTable.tableName,
          AGGREGATES_TABLE: aggregatesTable.tableName,
          POWERTOOLS_SERVICE_NAME: 'voc-fixture-provider',
          LOG_LEVEL: 'INFO',
        },
        layers: [apiLayer],
        logGroup: ctx.logGroup(
          'VerificationFixtureProviderLogs',
          ctx.uniqueName('voc-fixture-provider'),
        ),
      },
    );

    // Optional narrowing. Without this, invoke is governed only by identity
    // policies, which for a same-account caller means anyone holding
    // lambda:InvokeFunction on this ARN. Supplying the harness's role pins it
    // to exactly one principal. Validated here so a typo fails at synth rather
    // than producing a policy that silently grants nobody.
    const invokerArn: unknown = stack.node.tryGetContext('verificationFixtureInvokerArn');
    if (invokerArn !== undefined && invokerArn !== '') {
      // Anchored at both ends, and BOTH IAM wildcards (`*` and `?`) are
      // rejected anywhere in the path. IAM refuses a wildcard-path principal at
      // DEPLOY time, so accepting one here would break the promise that a bad
      // value fails at synth -- and `role/*` reads like a deliberate broad grant
      // rather than a mistake.
      if (typeof invokerArn !== 'string'
        || !/^arn:[a-z0-9-]+:iam::\d{12}:(role|user)\/[^*?\s]+$/.test(invokerArn)) {
        throw new Error(
          'verificationFixtureInvokerArn must be an IAM role or user ARN, got '
          + JSON.stringify(invokerArn),
        );
      }
      verificationFixtureProvider.addPermission('VerificationFixtureInvoker', {
        principal: new iam.ArnPrincipal(invokerArn),
        action: 'lambda:InvokeFunction',
      });
    }

    new cdk.CfnOutput(stack, 'VerificationFixtureProviderArn', {
      value: verificationFixtureProvider.functionArn,
      description: 'Private target-owned ABCA fixture provider ARN',
    });
  }
}
