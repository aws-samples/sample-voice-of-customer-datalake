/**
 * The GitHub App user authorizations' parameters (7.57.00, docs/autonomous-engineering.md "Any public repository"):
 * where a deployment's GitHub Apps' OAuth clients and the people's user-to-server tokens are kept, and the broker's grant
 * on them. A path of its own, `/[<prefix>-]voc/engineering-user-auth/`, deliberately OUTSIDE the connections' path
 * (`/[<prefix>-]voc/engineering/*`), so the grant the broker and the checkout cache's writer hold on the connections'
 * credentials (engineering-broker.ts grantConnectionCredentials) never reaches a person's token:
 *
 * - `…/engineering-user-auth/app/<app id>/client`: `{app_id, client_id, client_secret}`, an App's OAuth client. The Agents
 *   API writes and deletes it (api-engineering-user-auth.ts), voc-engineering-user-auth (the code exchange,
 *   engineering-user-auth.ts) and the broker (a refresh) read it.
 * - `…/engineering-user-auth/user/<app id>/<sha256 of the person's subject>`: the person's user-to-server token and its
 *   refresh token. voc-engineering-user-auth writes it (the exchange), the broker reads it and writes it again (a refresh
 *   rotates both tokens), for its `open_upstream_pr` operation alone; the Agents API deletes it ("remove my
 *   authorization"). No other role holds any grant on the path (the negative pins of engineering-user-auth.test.ts).
 *
 * Every parameter is a SecureString of the standard tier under the stack's customer-managed key.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';

import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';

/** The user authorizations' path (lambda/engineering/connectors/user_auth.py reads it from `ENGINEERING_USER_AUTH_PREFIX`). */
const ENGINEERING_USER_AUTH_PATH = 'voc/engineering-user-auth/';

/** Which of the path's parameters a grant names. */
type UserAuthParameters = 'clients' | 'apps' | 'users';

const RESOURCE_NAMES: Readonly<Record<UserAuthParameters, string>> = {
  // An App's OAuth client alone (the readers').
  clients: 'app/*/client',
  // Everything under an App's own segment (the Agents API's writer and remover of the client).
  apps: 'app/*',
  // The people's tokens.
  users: 'user/*',
};

/**
 * `/voc/engineering-user-auth/`, or `/<prefix>-voc/engineering-user-auth/` on a prefixed deployment (the prefix on the
 * `voc` segment, as engineeringParameterPrefix places it): `ENGINEERING_USER_AUTH_PREFIX`.
 */
export function engineeringUserAuthPrefix(deploymentPrefix: string | undefined): string {
  return deploymentPrefix ? `/${deploymentPrefix}-${ENGINEERING_USER_AUTH_PATH}` : `/${ENGINEERING_USER_AUTH_PATH}`;
}

/** The ARN pattern of `which` of the path's parameters in `stack`'s account and region. */
function userAuthParameterArns(stack: cdk.Stack, deploymentPrefix: string | undefined,
  which: UserAuthParameters): string {
  return stack.formatArn({
    service: 'ssm', resource: 'parameter', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    resourceName: `${engineeringUserAuthPrefix(deploymentPrefix).slice(1)}${RESOURCE_NAMES[which]}`,
  });
}

/** `kms:ViaService` SSM and `PARAMETER_ARN` one of `parameters`: the stack's key used by SSM for those parameters alone. */
function viaSsmFor(stack: cdk.Stack, parameters: string[]): Record<string, Record<string, unknown>> {
  return {
    StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` },
    StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': parameters.length === 1 ? parameters[0] : parameters },
  };
}

/** One statement of a user-auth grant: its sid, its actions and which of the path's parameters it names. */
export type UserAuthStatement = readonly [sid: string, actions: readonly string[], which: readonly UserAuthParameters[]];

/**
 * `statements` on `role`: an SSM statement on the parameters it names; a KMS one (every action `kms:*`) on the stack's key
 * through SSM and for those parameters alone (`viaSsmFor`); and the one IAM5 acknowledgement `reason` of the wildcards
 * the SSM statements name. Each role's own list says exactly what it may do (engineering-user-auth.test.ts pins them).
 */
export function grantUserAuthParameters(role: iam.Role, kmsKey: kms.IKey, deploymentPrefix: string | undefined,
  statements: readonly UserAuthStatement[], reason: string): void {
  const stack = cdk.Stack.of(role);
  const named = new Set<string>();
  for (const [sid, actions, which] of statements) {
    const parameters = which.map((name) => userAuthParameterArns(stack, deploymentPrefix, name));
    const viaKey = actions.every((action) => action.startsWith('kms:'));
    if (!viaKey) parameters.forEach((parameter) => named.add(parameter));
    role.addToPrincipalPolicy(new iam.PolicyStatement(viaKey
      ? { sid, actions: [...actions], resources: [kmsKey.keyArn], conditions: viaSsmFor(stack, parameters) }
      : { sid, actions: [...actions], resources: parameters }));
  }
  acknowledgeNag(role, [{ id: 'AwsSolutions-IAM5', reason, findings: [...named].map(resourceFinding) }]);
}

/**
 * The broker's grant (engineering-broker.ts), for `open_upstream_pr` alone: `ssm:GetParameter` on the Apps' OAuth clients
 * and the people's tokens, `ssm:PutParameter` on the people's tokens only (a refresh rotates them), `kms:Decrypt` through
 * SSM for those two, and `kms:Encrypt` and `kms:GenerateDataKey` through SSM for the people's tokens only. No delete, no
 * other parameter.
 */
export function grantBrokerUserAuthorizations(role: iam.Role, kmsKey: kms.IKey, deploymentPrefix: string | undefined): void {
  grantUserAuthParameters(role, kmsKey, deploymentPrefix, [
    ['UserAuthorizationReads', ['ssm:GetParameter'], ['clients', 'users']],
    ['UserAuthorizationRefresh', ['ssm:PutParameter'], ['users']],
    ['UserAuthorizationReadsKey', ['kms:Decrypt'], ['clients', 'users']],
    ['UserAuthorizationRefreshKey', ['kms:Encrypt', 'kms:GenerateDataKey'], ['users']],
  ], 'One OAuth client per GitHub App and one user-to-server token per person who authorizes it, both made at run '
    + 'time, so the reads are scoped to the user authorizations\' own path (/[<prefix>-]voc/engineering-user-auth/app/*'
    + '/client and /user/*), and the one write (a refresh rotates the token) to the people\'s tokens alone');
}
