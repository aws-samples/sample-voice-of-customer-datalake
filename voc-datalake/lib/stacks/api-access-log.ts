/**
 * The API stage's access-log line (api-gateway.ts `accessLogFormat`).
 *
 * It keeps every field of `AccessLogFormat.jsonWithStandardFields()` under the same
 * key, so existing Logs Insights queries keep working, and adds:
 * - (no `path`: the real path carries bearer ids, the ballot's `vs_…` session id among them, and
 *   ballots_handler.py promises that id never reaches a log; `resourcePath` is the template; DATA-3);
 * - `userAgent`: lets a sweep drop e2e traffic (`voc-e2e/<run id>`, frontend/e2e/README.md);
 * - `integrationStatus`: the status the Lambda integration returned (empty when the
 *   gateway answered itself: authorizer 401, throttle 429, missing route 403);
 * - `errorMessage`: the gateway's own error message;
 * - `sub` / `principalId`: who made the request (the Cognito `sub` claim, or a custom authorizer's
 *   principal such as an MCP token's), so an incident can be tied to an account (OPS-7);
 * - `tlsVersion`: the negotiated TLS version, the check before moving the API to STRICT mode (api-tls.ts).
 */
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

const Field = apigateway.AccessLogField;

/** Key → `$context` variable, in log order. Exported for the lockstep test. */
export const ACCESS_LOG_FIELDS: Readonly<Record<string, string>> = {
  // jsonWithStandardFields(), unchanged:
  requestId: Field.contextRequestId(),
  ip: Field.contextIdentitySourceIp(),
  user: Field.contextIdentityUser(),
  caller: Field.contextIdentityCaller(),
  requestTime: Field.contextRequestTime(),
  httpMethod: Field.contextHttpMethod(),
  resourcePath: Field.contextResourcePath(),
  status: Field.contextStatus(),
  protocol: Field.contextProtocol(),
  responseLength: Field.contextResponseLength(),
  // Added in 5.38 (`path` removed again: it logged bearer ids):
  userAgent: Field.contextIdentityUserAgent(),
  // No AccessLogField helper: `contextIntegrationStatus()` is `$context.integrationStatus`
  // (the Lambda function's own status for a proxy integration), not the integration's.
  integrationStatus: '$context.integration.status',
  errorMessage: Field.contextErrorMessage(),
  // Added with the Well-Architected security review:
  sub: '$context.authorizer.claims.sub',
  principalId: Field.contextAuthorizerPrincipalId(),
  tlsVersion: '$context.tlsVersion',
};

export function apiAccessLogFormat(): apigateway.AccessLogFormat {
  return apigateway.AccessLogFormat.custom(JSON.stringify(ACCESS_LOG_FIELDS));
}
