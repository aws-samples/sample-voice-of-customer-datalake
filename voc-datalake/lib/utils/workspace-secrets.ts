/**
 * The per-workspace credentials secrets (docs/multi-workspace.md, decision 8): `{prefix}/{ws}/credentials`, the
 * prefix `voc/ws` (`<deployment prefix>-voc/ws` with `-c deploymentPrefix`). The workspaces API creates them
 * (lib/stacks/api-workspaces-lambda.ts), the plugin ingestors read them (lib/stacks/ingestion-roles.ts), and the
 * integrations and scrapers APIs read and write them for a request in a workspace (lib/stacks/api-data-lambdas.ts,
 * {@link grantWorkspaceSecretsReadWrite}); all build the name prefix and the ARN pattern here, and the Lambdas get the
 * prefix in `WORKSPACE_SECRET_PREFIX` (lambda/shared/workspace_ids.py builds each name from it and a verified
 * workspace id).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';

import { acknowledgeNag, resourceFinding } from './nag-ack';

/** The name prefix of every per-workspace credentials secret, before the deployment prefix. */
export const WORKSPACE_SECRET_BASE_PREFIX = 'voc/ws';
/** The environment variable every Lambda that names a workspace secret reads the prefix from (the ingestors, the
 * workspaces API, lambda/shared/workspace_plugin_store.py). */
export const WORKSPACE_SECRET_PREFIX_ENV = 'WORKSPACE_SECRET_PREFIX';

/** Every secret under `prefix` (`{prefix}/*`: Secrets Manager appends a random suffix to each name's ARN). */
export function workspaceSecretsArn(stack: cdk.Stack, prefix: string): string {
  return stack.formatArn({
    service: 'secretsmanager', resource: 'secret', resourceName: `${prefix}/*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}

/**
 * Read and write (GetSecretValue, PutSecretValue) every workspace's credentials secret, with the deployment key they
 * are encrypted with, and no Create, Delete, Describe or Tag: an operator API's request in a workspace saves and reads
 * that workspace's plugin credentials, app connectors and scraper configs there
 * (lambda/shared/workspace_plugin_store.py, the name built from the
 * request's resolved workspace only; IAM reaches every workspace's secret, so only that code keeps a request to its
 * own: decision 1's soft isolation). Returns the environment the Lambda reads the prefix from.
 */
export function grantWorkspaceSecretsReadWrite(
  stack: cdk.Stack, role: iam.Role, prefix: string, kmsKey: kms.IKey,
): Record<string, string> {
  const secretsArn = workspaceSecretsArn(stack, prefix);
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'], resources: [secretsArn],
  }));
  // The secrets are encrypted with the deployment's customer-managed key (the workspaces API creates them with it,
  // `secretsmanager:KmsKeyArn`): a read decrypts with it, a write asks it for a data key. The same key actions the
  // plugin ingestors and the workspaces API hold on it, on that one key.
  kmsKey.grantEncryptDecrypt(role);
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'A request in a workspace reads and writes that workspace\'s credentials secret (voc/ws/{ws}/credentials, '
      + 'decision 8), its name built from the request\'s resolved workspace only; the grant reaches only that name '
      + 'prefix of this deployment, with no create, delete or tag',
    findings: [resourceFinding(secretsArn)],
  }]);
  return { [WORKSPACE_SECRET_PREFIX_ENV]: prefix };
}
