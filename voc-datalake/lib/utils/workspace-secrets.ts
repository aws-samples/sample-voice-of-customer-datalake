/**
 * A workspace's plugin credentials (docs/multi-workspace.md, decision 19): SSM Parameter Store SecureStrings,
 * standard tier (no monthly fee, 4 KB each), encrypted with the deployment's customer-managed KMS key, one per plugin
 * namespace: `{prefix}/{ws}/credentials/{plugin}` (the plugin's keys, its webhook secret among them). The prefix is
 * `/voc/ws` (`/<deployment prefix>-voc/ws` with `-c deploymentPrefix`, the convention of
 * lib/utils/radar-exa-parameter.ts); the Lambdas get it in `WORKSPACE_PARAMETER_PREFIX` ({@link workspaceParameterEnv})
 * and build each name from it, a verified workspace id and a plugin id (lambda/shared/workspace_ids.py).
 * CloudFormation never creates one, and neither does a workspace's creation: the first save in a workspace does
 * (lambda/shared/workspace_credentials.py). A plugin's config list is not a credential: it is a voc-aggregates row
 * (lambda/shared/plugin_configs.py) under the grants those roles already hold on that table.
 *
 * The grants, each on exactly one workspace id in the pattern (`ws_` and 26 `?`, lib/stacks/core-buckets.ts
 * WORKSPACE_ID_PATTERN, as the DynamoDB `LeadingKeys` conditions use it):
 *   - a reader ({@link grantWorkspaceParameterRead}: an ingestor role, the webhook role) gets `ssm:GetParameter` on its
 *     own plugins' names only, and `kms:Decrypt` through SSM for those names only;
 *   - the operator APIs ({@link grantWorkspaceParametersReadWrite}: integrations, scrapers) get `ssm:GetParameter` and
 *     `ssm:PutParameter` on every plugin's `credentials/*`, `ssm:GetParametersByPath` on that path (the integrations
 *     status), and `kms:Decrypt` and `kms:Encrypt` through SSM for those names only.
 * A standard-tier SecureString is encrypted and decrypted by SSM calling KMS directly with the parameter's ARN as the
 * encryption context (`kms:EncryptionContext:PARAMETER_ARN`), so no `kms:GenerateDataKey` is needed.
 *
 * The SSM-only key statements are NOT a second layer: every one of these roles also holds the deployment key
 * unconditioned (`grantEncryptDecrypt`, for its queues, tables and the shared secret), so they record which names the
 * parameters' key use is for; the boundary is the `ssm:GetParameter` / `ssm:PutParameter` resources (and, between
 * the plugins of one shared role and between workspaces, the code-built name).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';

import { WORKSPACE_ID_PATTERN } from '../stacks/core-buckets';
import { byCodeUnit } from './compare';
import { acknowledgeNag, resourceFinding } from './nag-ack';

/** The path of every workspace's parameters, before the deployment prefix and without the leading `/`. */
export const WORKSPACE_PARAMETER_BASE_PATH = 'voc/ws';
/** The environment variable a writer takes the customer-managed key it encrypts with from. */
const WORKSPACE_PARAMETER_KEY_ENV = 'WORKSPACE_PARAMETER_KEY_ARN';

/** `{WORKSPACE_PARAMETER_PREFIX: '/voc/ws'}` (or `/<prefix>-voc/ws`) from the prefixed base path
 *  (`ctx.prefixed(WORKSPACE_PARAMETER_BASE_PATH)`): the one place the variable and its value are built. */
export function workspaceParameterEnv(prefixedBasePath: string): Record<string, string> {
  return { WORKSPACE_PARAMETER_PREFIX: `/${prefixedBasePath}` };
}

/** The ARN of `{prefix}/ws_<one id>/credentials[/{last}]` (`last` a plugin id, or `*` for every plugin). */
function credentialsArn(stack: cdk.Stack, prefixedBasePath: string, last?: string): string {
  const path = `${prefixedBasePath}/${WORKSPACE_ID_PATTERN}/credentials`;
  return stack.formatArn({
    service: 'ssm', resource: 'parameter', resourceName: last === undefined ? path : `${path}/${last}`,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
}

/** The key actions SSM performs for these parameters, and only through SSM, for these names only. */
function keyThroughSsm(stack: cdk.Stack, kmsKey: kms.IKey, actions: readonly string[],
  parameterArns: readonly string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: [...actions],
    resources: [kmsKey.keyArn],
    conditions: {
      StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` },
      StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': [...parameterArns] },
    },
  });
}

/**
 * Read `plugins`' credentials parameters in any one workspace (GetParameter, decrypted), and nothing else: an
 * ingestor role's plugins, the webhook role's plugins. The names a call reads are built from the run's or the
 * delivery's verified workspace (decision 1's soft isolation keeps one workspace from another; IAM keeps a role to its
 * own plugins, which on the shared ingestor role are several). Returns the environment the Lambda reads the prefix
 * from.
 */
export function grantWorkspaceParameterRead(
  stack: cdk.Stack, role: iam.IRole, prefixedBasePath: string, kmsKey: kms.IKey, plugins: readonly string[],
): Record<string, string> {
  const arns = [...plugins].sort(byCodeUnit).map((plugin) => credentialsArn(stack, prefixedBasePath, plugin));
  if (arns.length > 0) {
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: arns }));
    role.addToPrincipalPolicy(keyThroughSsm(stack, kmsKey, ['kms:Decrypt'], arns));
  }
  return workspaceParameterEnv(prefixedBasePath);
}

/**
 * Read and write every plugin's credentials parameter in any one workspace, with the deployment key they are
 * encrypted with through SSM, and no delete: an operator API's request in a workspace saves and reads that
 * workspace's plugin credentials there (lambda/shared/workspace_plugin_store.py, the names built from the request's
 * resolved workspace only; IAM reaches every workspace's, so only that code keeps a request to its own: decision 1's
 * soft isolation). Returns the environment the Lambda reads the prefix and the key from.
 */
export function grantWorkspaceParametersReadWrite(
  stack: cdk.Stack, role: iam.Role, prefixedBasePath: string, kmsKey: kms.IKey,
): Record<string, string> {
  const everyPlugin = credentialsArn(stack, prefixedBasePath, '*');
  role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter', 'ssm:PutParameter'], resources: [everyPlugin] }));
  // The integrations status lists every plugin's keys of the workspace: one paged read of its credentials path.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['ssm:GetParametersByPath'], resources: [credentialsArn(stack, prefixedBasePath)],
  }));
  role.addToPolicy(keyThroughSsm(stack, kmsKey, ['kms:Decrypt', 'kms:Encrypt'], [everyPlugin]));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'A request in a workspace reads and writes that workspace\'s plugin credentials (voc/ws/{ws}/credentials/'
      + '{plugin}, decision 19), the names built from the request\'s resolved workspace and the route\'s validated '
      + 'plugin only; the grant reaches one workspace id segment of this deployment\'s path, no delete',
    findings: [resourceFinding(everyPlugin)],
  }]);
  return { ...workspaceParameterEnv(prefixedBasePath), [WORKSPACE_PARAMETER_KEY_ENV]: kmsKey.keyArn };
}
