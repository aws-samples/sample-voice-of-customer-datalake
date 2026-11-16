/**
 * voc-engineering-app-tokens (VocProcessingStack, with `-c engineeringAgents=true`; 7.45.00, docs/autonomous-engineering.md
 * "A GitHub App in two clicks"): the one function besides the broker that signs with a GitHub App's key. The broker's code
 * (lambda/engineering/connectors/app_tokens.py), entered at `connectors/app_tokens.lambda_handler`, which takes
 * `inspect_installation` (the Agents API's: an installation's account and repositories, read with a token it revokes,
 * never answered) and `issues_token` (the github_issues ingestor's: `{issues: read, metadata: read}` tokens narrowed to a
 * run's repositories) and refuses every other request before anything is read.
 *
 * Its own role holds exactly `ssm:GetParameter` on the deployment's GitHub Apps' keys (`/[<prefix>-]voc/engineering/
 * _github-app/<app id>/key`) and `kms:Decrypt` on the stack's key through SSM for those parameters alone (the
 * `PARAMETER_ARN` context, as `grantConnectionCredentials`): no connection's parameter, no webhook secret, no table, no
 * bucket, no function URL, no resource policy. The Agents API's role and the github_issues ingestor's invoke it by name
 * (VocApiStack and VocIngestionStack: the ingestion stack deploys first). Pay per use: no fixed cost.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

import { ENGINEERING_APP_TOKENS_FUNCTION_BASE_NAME } from '../utils/function-names';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { createWorkerFunction, grantInvokeByName, workerRole } from '../utils/worker-lambda';
import { engineeringAgentsEnabled, engineeringParameterPrefix } from './engineering-broker';

/** The Apps' parameters under the connections' path (lambda/engineering/connectors/connections.py APP_PARAMETERS). */
const GITHUB_APP_PARAMETERS = '_github-app/';
/** The one plugin that signs in with a GitHub App and verifies its deliveries (plugins/github_issues). */
export const GITHUB_APP_SIGN_IN_PLUGIN = 'github_issues';
/** The env var the github_issues ingestor finds the token function by (plugins/github_issues/ingestor/handler.py). */
export const APP_TOKENS_FUNCTION_ENV = 'ENGINEERING_APP_TOKENS_FUNCTION';

/** `/[<prefix>-]voc/engineering/_github-app/`: where each App's `key` and `webhook` parameters are. */
export function githubAppParameterPrefix(deploymentPrefix: string | undefined): string {
  return `${engineeringParameterPrefix(deploymentPrefix)}${GITHUB_APP_PARAMETERS}`;
}

/** Every App's `leaf` parameter (`…/_github-app/<app id>/key` or `…/webhook`) in `stack`'s account and region. */
function githubAppParameterArns(stack: cdk.Stack, deploymentPrefix: string | undefined, leaf: 'key' | 'webhook'): string {
  return stack.formatArn({
    service: 'ssm', resource: 'parameter', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    resourceName: `${githubAppParameterPrefix(deploymentPrefix).slice(1)}*/${leaf}`,
  });
}

/** The token function's name in `uniqueName`'s naming (the same in every stack that reaches it). */
export function appTokensFunctionName(uniqueName: (baseName: string) => string): string {
  return uniqueName(ENGINEERING_APP_TOKENS_FUNCTION_BASE_NAME);
}

/** The token function's name where the engineering agents are deployed (it exists only there), else undefined. */
export function engineeringAppTokens(scope: Construct, uniqueName: (baseName: string) => string): string | undefined {
  return engineeringAgentsEnabled(scope) ? appTokensFunctionName(uniqueName) : undefined;
}

/** `lambda:InvokeFunction` on the token function by name, for a role of a stack that deploys before it or apart. */
export function grantAppTokensInvoke(role: iam.IRole, uniqueName: (baseName: string) => string): void {
  grantInvokeByName(cdk.Stack.of(role), role, [appTokensFunctionName(uniqueName)], 'GitHubAppTokens');
}

interface AppTokensProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  /** cryptography, for the App's JWT (RS256): the broker's own signing layer. */
  signingLayer: lambda.ILayerVersion;
  /** The stack's customer-managed key, which encrypts the Apps' SecureString parameters. */
  kmsKey: kms.IKey;
  deploymentPrefix: string | undefined;
}

/** The function's own role: the Apps' keys read, decrypted through SSM for them alone; nothing else. */
function appTokensRole(scope: Construct, props: AppTokensProps): iam.Role {
  const role = workerRole(scope, 'EngineeringAppTokensRole');
  const stack = cdk.Stack.of(scope);
  const keys = githubAppParameterArns(stack, props.deploymentPrefix, 'key');
  role.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'GitHubAppKeys', actions: ['ssm:GetParameter'], resources: [keys] }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'GitHubAppKeysKey',
    actions: ['kms:Decrypt'],
    resources: [props.kmsKey.keyArn],
    // Only through SSM, and only for the Apps' keys (SSM puts the parameter's ARN in the context).
    conditions: {
      StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` },
      StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': keys },
    },
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'One key parameter per GitHub App an administrator makes at run time (its id known only then), so the read '
      + 'is scoped to the Apps\' keys (/[<prefix>-]voc/engineering/_github-app/*/key), read-only: never a connection\'s '
      + 'parameter or an App\'s webhook secret',
    findings: [resourceFinding(keys)],
  }]);
  return role;
}

export function createEngineeringAppTokens(scope: Construct, props: AppTokensProps): lambda.Function {
  const fn = createWorkerFunction(scope, 'EngineeringAppTokens', {
    tree: 'engineering',
    functionName: appTokensFunctionName(props.uniqueName),
    handler: 'engineering/connectors/app_tokens.lambda_handler',
    role: appTokensRole(scope, props),
    layer: props.layer,
    // Under the Agents API's 25 s wait (agents_handler.py START_READ_TIMEOUT_SECONDS): each GitHub request has 5 s, an
    // inspection reads at most ten pages of repositories.
    timeout: cdk.Duration.seconds(20),
    memorySize: 256,
    serviceName: 'voc-engineering-app-tokens',
    environment: { ENGINEERING_PARAMETER_PREFIX: engineeringParameterPrefix(props.deploymentPrefix) },
  });
  fn.addLayers(props.signingLayer);
  return fn;
}

/**
 * The github_issues webhook's App path (VocApiStack, only with the engineering agents AND that webhook deployed): the
 * shared webhook role reads each App's webhook secret (`…/_github-app/<app id>/webhook`, `ssm:GetParameter` alone; its
 * `kms:Decrypt` is the role's own grant of the stack's key), and the github_issues function learns where they are
 * (`GITHUB_APP_PARAMETER_PREFIX`). Never an App's key.
 */
function grantGitHubAppWebhookSecrets(role: iam.Role, webhook: lambda.Function, deploymentPrefix: string | undefined): void {
  const secrets = githubAppParameterArns(cdk.Stack.of(role), deploymentPrefix, 'webhook');
  role.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'GitHubAppWebhookSecrets', actions: ['ssm:GetParameter'], resources: [secrets] }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'One webhook secret per GitHub App an administrator makes at run time, so the read is scoped to the Apps\' '
      + 'webhook secrets (/[<prefix>-]voc/engineering/_github-app/*/webhook), read-only: never an App\'s key',
    findings: [resourceFinding(secrets)],
  }]);
  webhook.addEnvironment('GITHUB_APP_PARAMETER_PREFIX', githubAppParameterPrefix(deploymentPrefix));
}

interface GitHubAppWebhookProps {
  /** The webhooks' shared role (api-stack.ts WebhookLambdaRole). */
  role: iam.Role;
  /** The deployed webhook functions, by plugin id. */
  webhooks: ReadonlyMap<string, lambda.Function>;
  /** The Agents API, whose manifests name the hook (GITHUB_APP_WEBHOOK_URL). */
  agentsApi: lambda.Function;
  /** `https://<id>.execute-api.<region>.<suffix>/v1` (api-gateway.ts restApiBaseUrl). */
  apiBaseUrl: string;
  deploymentPrefix: string | undefined;
}

/**
 * Where the engineering agents and the github_issues webhook are both deployed: the App deliveries' secrets for the
 * webhook (`grantGitHubAppWebhookSecrets`) and the hook's address for the Agents API, which puts it in an App's manifest
 * (lambda/engineering/connectors/github_apps.py). Elsewhere nothing: no grant, and a manifest without a hook.
 */
export function wireGitHubAppWebhook(props: GitHubAppWebhookProps): void {
  const webhook = engineeringAgentsEnabled(props.role) ? props.webhooks.get(GITHUB_APP_SIGN_IN_PLUGIN) : undefined;
  if (webhook === undefined) return;
  grantGitHubAppWebhookSecrets(props.role, webhook, props.deploymentPrefix);
  props.agentsApi.addEnvironment('GITHUB_APP_WEBHOOK_URL', `${props.apiBaseUrl}/webhooks/${GITHUB_APP_SIGN_IN_PLUGIN}`);
}
