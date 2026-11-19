/**
 * The Agents API's side of the GitHub App user authorizations (7.57.00, lambda/engineering/connectors/github_apps.py;
 * docs/autonomous-engineering.md "Any public repository"), with `-c engineeringAgents=true` only:
 *
 * - `lambda:InvokeFunction` on voc-engineering-user-auth by name (VocProcessingStack, engineering-user-auth.ts), which
 *   exchanges a person's OAuth code and writes their token with its own role;
 * - `ssm:PutParameter` and `ssm:DeleteParameter` on the Apps' OAuth clients (`/[<prefix>-]voc/engineering-user-auth/
 *   app/*`: stored when an App is made, or pasted for an App made before 7.57.00, and removed with the App), and
 *   `ssm:DeleteParameter` on the people's tokens (`…/user/*`: "remove my authorization"), with `kms:Encrypt` and
 *   `kms:GenerateDataKey` on the stack's key only through SSM and only for the clients (SSM names the parameter in the
 *   encryption context; a delete needs no key).
 *
 * Never `ssm:GetParameter`: the Agents API writes an OAuth client and cannot read it back, and never reads a token.
 * Returns the env that names the function and the path to the Agents API.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import { grantInvokeByName } from '../utils/worker-lambda';
import type { ApiStackContext } from './api-context';
import { USER_AUTH_FUNCTION_ENV, userAuthFunctionName } from './engineering-user-auth';
import { engineeringUserAuthPrefix, grantUserAuthParameters } from './engineering-user-auth-parameters';

export function grantUserAuthorizationWrites(ctx: ApiStackContext, role: iam.Role): Record<string, string> {
  const stack = cdk.Stack.of(role);
  const name = userAuthFunctionName(ctx.uniqueName);
  grantInvokeByName(stack, role, [name], 'EngineeringUserAuth');
  grantUserAuthParameters(role, ctx.props.kmsKey, ctx.deploymentPrefix, [
    ['GitHubAppOAuthClientWrites', ['ssm:PutParameter', 'ssm:DeleteParameter'], ['apps']],
    ['GitHubUserTokenRemovals', ['ssm:DeleteParameter'], ['users']],
    ['GitHubAppOAuthClientKey', ['kms:Encrypt', 'kms:GenerateDataKey'], ['apps']],
  ], 'One OAuth client per GitHub App and one token per person, made at run time, so the writes are scoped to the user '
    + 'authorizations\' own path (/[<prefix>-]voc/engineering-user-auth/app/* put and delete, /user/* delete): never a '
    + 'read');
  return {
    [USER_AUTH_FUNCTION_ENV]: name,
    ENGINEERING_USER_AUTH_PREFIX: engineeringUserAuthPrefix(ctx.deploymentPrefix),
  };
}
