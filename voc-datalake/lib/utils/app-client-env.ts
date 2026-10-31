/**
 * `APP_CLIENT_IDS` on every Lambda function of VocApiStack: the Cognito app clients whose tokens the
 * REST API accepts (the SPA's web client and the board pool's client). API Gateway's Cognito authorizer
 * accepts a token of ANY client of the pool, including the MCP OAuth clients (api-mcp-oauth.ts), so the
 * handlers refuse every other client themselves: `lambda/shared/app_clients.py` (Python APIs) and
 * `lambda/stream/src/assistant/runtime/app-client.ts` (the assistant stream). docs/mcp.md → "OAuth sign-in".
 *
 * Every function rather than a hand-kept list of route handlers, like inference-scope.ts: a missed
 * handler would fail closed (no env = every token refused), an extra variable costs nothing.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';

/** Must equal APP_CLIENT_IDS_ENV in lambda/shared/app_clients.py (pinned by app-client-env.test.ts). */
export const APP_CLIENT_IDS_ENV = 'APP_CLIENT_IDS';

class AppClientEnvAspect implements cdk.IAspect {
  constructor(private readonly value: string) {}

  visit(node: IConstruct): void {
    if (node instanceof lambda.Function) node.addEnvironment(APP_CLIENT_IDS_ENV, this.value);
  }
}

/** Set `APP_CLIENT_IDS` (comma-separated `clientIds`) on every function under `scope`. */
export function applyAppClientEnv(scope: IConstruct, clientIds: readonly string[]): void {
  if (clientIds.length === 0) throw new Error('applyAppClientEnv needs at least one app client id');
  cdk.Aspects.of(scope).add(new AppClientEnvAspect(cdk.Fn.join(',', [...clientIds])));
}
