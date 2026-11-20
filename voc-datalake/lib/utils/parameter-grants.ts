/**
 * A grant on SSM SecureString parameters whose names are known only at run time (7.60.00): the SSM actions on exactly
 * those parameters (a path's `*`), the stack's customer-managed key for them only through SSM and only for those
 * parameters (SSM puts the parameter's ARN in the key's encryption context), and the cdk-nag acknowledgement of the
 * path's wildcard. The engineering connectors' readers and writers use it: the broker's reads of the connections'
 * credentials and of the fine-grained connections' write tokens, and the checkout cache's writer's (engineering-broker.ts),
 * the GitHub Apps' token function's read of the Apps' keys (engineering-app-tokens.ts), and the Agents API's puts and
 * deletes of both connection paths (api-assistant-lambdas.ts).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';

import { acknowledgeNag, resourceFinding } from './nag-ack';

export interface ParameterGrant {
  /** The SSM statement's Sid; the key's is `${sid}Key` unless `keySid` names it. */
  readonly sid: string;
  readonly keySid?: string;
  /** The SSM actions (`ssm:GetParameter`; `ssm:PutParameter` and `ssm:DeleteParameter`). */
  readonly actions: readonly string[];
  /** The key's actions through SSM (`kms:Decrypt`; `kms:Encrypt` and `kms:GenerateDataKey`). */
  readonly keyActions: readonly string[];
  /** The parameters' ARNs (each a path's `*`). */
  readonly parameters: readonly string[];
  /** Why the wildcard is accepted (the cdk-nag acknowledgement's reason). */
  readonly reason: string;
}

/** `grant` on `role`: its SSM statement, the key through SSM for those parameters alone, and the acknowledgement. */
export function grantParameters(role: iam.Role, kmsKey: kms.IKey, grant: ParameterGrant): void {
  const parameters = [...grant.parameters];
  role.addToPrincipalPolicy(new iam.PolicyStatement({ sid: grant.sid, actions: [...grant.actions], resources: parameters }));
  acknowledgeNag(role, [{ id: 'AwsSolutions-IAM5', reason: grant.reason, findings: parameters.map(resourceFinding) }]);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: grant.keySid ?? `${grant.sid}Key`,
    actions: [...grant.keyActions],
    resources: [kmsKey.keyArn],
    conditions: {
      StringEquals: { 'kms:ViaService': `ssm.${cdk.Stack.of(role).region}.amazonaws.com` },
      // (one parameter path as a string, as these grants always rendered it; several as a list)
      StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': parameters.length === 1 ? parameters[0] : parameters },
    },
  }));
}
