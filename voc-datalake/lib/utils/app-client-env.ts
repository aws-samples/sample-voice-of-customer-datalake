/**
 * `APP_CLIENT_IDS`: the Cognito app clients whose tokens the REST API accepts (the SPA's web client and
 * the board pool's client). API Gateway's Cognito authorizer accepts a token of ANY client of the pool,
 * including the MCP OAuth clients (api-mcp-oauth.ts), so the handlers refuse every other client
 * themselves: `lambda/shared/app_clients.py` (every `create_api_resolver` handler) and
 * `lambda/stream/src/assistant/runtime/app-client.ts` (the assistant stream). docs/mcp.md → "OAuth sign-in".
 *
 * Which functions get it, without a hand-kept list: every Python function whose handler is an API
 * handler module (`<domain>_handler.lambda_handler`, which includes the assist twins) except the
 * global MCP endpoint (its own credential path), plus the functions named explicitly (the stream).
 * A handler that misses it fails closed (no env = every token refused); a function that never reads it
 * does not get it (scripts/audit/py_env_contract.py).
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';

/** Must equal APP_CLIENT_IDS_ENV in lambda/shared/app_clients.py (pinned by app-client-env.test.ts). */
export const APP_CLIENT_IDS_ENV = 'APP_CLIENT_IDS';

/** The global MCP endpoint verifies its own credentials (OAuth JWT / `voc_tok_`) and never reads the variable. */
const OWN_CREDENTIAL_HANDLERS: ReadonlySet<string> = new Set(['mcp_global_handler.lambda_handler']);
const API_HANDLER = /^\w+_handler\.lambda_handler$/;

/** `<domain>_handler.lambda_handler`, the global MCP endpoint excepted. */
export function isApiHandler(handler: unknown): boolean {
  return typeof handler === 'string' && API_HANDLER.test(handler) && !OWN_CREDENTIAL_HANDLERS.has(handler);
}

class AppClientEnvAspect implements cdk.IAspect {
  constructor(private readonly value: string) {}

  visit(node: IConstruct): void {
    if (!(node instanceof lambda.Function)) return;
    const cfn = node.node.defaultChild;
    if (cfn instanceof lambda.CfnFunction && isApiHandler(cfn.handler)) {
      node.addEnvironment(APP_CLIENT_IDS_ENV, this.value);
    }
  }
}

/** Set `APP_CLIENT_IDS` (comma-separated `clientIds`) on every API handler under `scope` and on `alsoOn`. */
export function applyAppClientEnv(scope: IConstruct, clientIds: readonly string[], alsoOn: readonly lambda.Function[]): void {
  if (clientIds.length === 0) throw new Error('applyAppClientEnv needs at least one app client id');
  const value = cdk.Fn.join(',', [...clientIds]);
  cdk.Aspects.of(scope).add(new AppClientEnvAspect(value));
  for (const fn of alsoOn) fn.addEnvironment(APP_CLIENT_IDS_ENV, value);
}
