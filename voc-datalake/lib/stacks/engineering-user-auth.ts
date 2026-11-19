/**
 * voc-engineering-user-auth (VocProcessingStack, with `-c engineeringAgents=true`; 7.57.00, docs/autonomous-engineering.md
 * "Any public repository"): the one function that exchanges a GitHub App's OAuth code for a person's user-to-server
 * token. The connectors' code (lambda/engineering/connectors/user_auth.py), entered at
 * `connectors/user_auth.lambda_handler`, which takes `exchange` alone (the Agents API's, after the person's sign-in on
 * GitHub came back to the SPA: the code, the App and the person) and refuses every other request before anything is
 * read. It reads the App's OAuth client, exchanges the code on github.com, and writes the person's token where the broker
 * reads it for the run's upstream pull request (engineering-user-auth-parameters.ts); it never answers a token.
 *
 * Its own role holds exactly `ssm:GetParameter` on the Apps' OAuth clients (`…/engineering-user-auth/app/<app id>/client`)
 * and `ssm:PutParameter` on the people's tokens (`…/engineering-user-auth/user/*`), with the stack's key through SSM for
 * each alone (`kms:Decrypt` for the clients, `kms:Encrypt` and `kms:GenerateDataKey` for the tokens; the `PARAMETER_ARN`
 * context): no read of a token, no connection's parameter, no App key, no table, no bucket, no function URL, no resource
 * policy. Only the Agents API's role invokes it, by name (api-engineering-user-auth.ts). Pay per use: no fixed cost.
 */
import * as cdk from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

import { ENGINEERING_USER_AUTH_FUNCTION_BASE_NAME } from '../utils/function-names';
import { workerRole } from '../utils/worker-lambda';
import { connectorFunction } from './engineering-app-tokens';
import { engineeringUserAuthPrefix, grantUserAuthParameters } from './engineering-user-auth-parameters';

/** The Agents API's env var it finds the function by (lambda/shared/engineering_agents.py USER_AUTH_FUNCTION_ENV). */
export const USER_AUTH_FUNCTION_ENV = 'ENGINEERING_USER_AUTH_FUNCTION';

/** The function's name in `uniqueName`'s naming (the same in both stacks). */
export function userAuthFunctionName(uniqueName: (baseName: string) => string): string {
  return uniqueName(ENGINEERING_USER_AUTH_FUNCTION_BASE_NAME);
}

interface UserAuthProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  /** The stack's customer-managed key, which encrypts the user authorizations' SecureString parameters. */
  kmsKey: kms.IKey;
  deploymentPrefix: string | undefined;
}

/** The function's own role: the Apps' OAuth clients read, the people's tokens written, each through SSM; nothing else. */
function userAuthRole(scope: Construct, props: UserAuthProps): iam.Role {
  const role = workerRole(scope, 'EngineeringUserAuthRole');
  grantUserAuthParameters(role, props.kmsKey, props.deploymentPrefix, [
    ['GitHubAppOAuthClients', ['ssm:GetParameter'], ['clients']],
    ['GitHubUserTokens', ['ssm:PutParameter'], ['users']],
    ['GitHubAppOAuthClientsKey', ['kms:Decrypt'], ['clients']],
    ['GitHubUserTokensKey', ['kms:Encrypt', 'kms:GenerateDataKey'], ['users']],
  ], 'One OAuth client per GitHub App and one token per person who authorizes it, made at run time, so the read is '
    + 'scoped to the Apps\' OAuth clients (/[<prefix>-]voc/engineering-user-auth/app/*/client) and the write to the '
    + 'people\'s tokens (/[<prefix>-]voc/engineering-user-auth/user/*): never a read of a token');
  return role;
}

export function createEngineeringUserAuth(scope: Construct, props: UserAuthProps): lambda.Function {
  return connectorFunction(scope, 'EngineeringUserAuth', 'user_auth', ENGINEERING_USER_AUTH_FUNCTION_BASE_NAME, {
    functionName: userAuthFunctionName(props.uniqueName),
    role: userAuthRole(scope, props),
    layer: props.layer,
    // Under the Agents API's wait: one SSM read, two GitHub requests (the exchange, the user's login) and one SSM write.
    timeout: cdk.Duration.seconds(15),
    environment: {
      ENGINEERING_USER_AUTH_PREFIX: engineeringUserAuthPrefix(props.deploymentPrefix),
      ENGINEERING_PARAMETER_KEY: props.kmsKey.keyArn,
    },
  });
}
