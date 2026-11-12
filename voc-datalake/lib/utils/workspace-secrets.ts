/**
 * The per-workspace credentials secrets (docs/multi-workspace.md, decision 8): `{prefix}/{ws}/credentials`, the
 * prefix `voc/ws` (`<deployment prefix>-voc/ws` with `-c deploymentPrefix`). The workspaces API creates them
 * (lib/stacks/api-workspaces-lambda.ts) and the plugin ingestors read them (lib/stacks/ingestion-roles.ts); both
 * build the name prefix and the ARN pattern here, and the Lambdas get the prefix in `WORKSPACE_SECRET_PREFIX`
 * (lambda/shared/workspace_ids.py builds each name from it and a verified workspace id).
 */
import * as cdk from 'aws-cdk-lib';

/** The name prefix of every per-workspace credentials secret, before the deployment prefix. */
export const WORKSPACE_SECRET_BASE_PREFIX = 'voc/ws';

/** Every secret under `prefix` (`{prefix}/*`: Secrets Manager appends a random suffix to each name's ARN). */
export function workspaceSecretsArn(stack: cdk.Stack, prefix: string): string {
  return stack.formatArn({
    service: 'secretsmanager', resource: 'secret', resourceName: `${prefix}/*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}
