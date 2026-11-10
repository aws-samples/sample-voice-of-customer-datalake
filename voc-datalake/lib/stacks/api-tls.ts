/**
 * The REST API's TLS security policy (Well-Architected SEC09-BP02, finding EDGE-1).
 *
 * A REST API with no policy keeps API Gateway's legacy `TLS_1_0` default on its execute-api endpoint, so a
 * client could negotiate TLS 1.0/1.1. The L2 `RestApi` has no prop for it; the L1 `CfnRestApi` does
 * (`SecurityPolicy` + `EndpointAccessMode`, required together for an enhanced policy).
 *
 * - `SecurityPolicy_TLS12_PFS_2025_EDGE`: TLS 1.2 and 1.3 with forward-secret ciphers only, on the
 *   edge-optimized endpoint this API uses (the default endpoint type).
 *   https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-security-policies-list.html
 * - `BASIC` endpoint access mode first: AWS's migration advice is to move to an enhanced policy in BASIC, check
 *   the access log's `tlsVersion` (api-access-log.ts), then switch to STRICT.
 */
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

export const API_SECURITY_POLICY = 'SecurityPolicy_TLS12_PFS_2025_EDGE';
export const API_ENDPOINT_ACCESS_MODE = 'BASIC';

export function applyApiTlsPolicy(api: apigateway.RestApi): void {
  const cfn = api.node.defaultChild;
  if (!(cfn instanceof apigateway.CfnRestApi)) throw new Error('RestApi has no CfnRestApi default child');
  cfn.securityPolicy = API_SECURITY_POLICY;
  cfn.endpointAccessMode = API_ENDPOINT_ACCESS_MODE;
}
