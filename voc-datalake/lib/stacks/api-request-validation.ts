/**
 * API Gateway request validation (cdk-nag AwsSolutions-APIG2) on the PUBLIC (unauthenticated) write routes.
 *
 * One `RequestValidator` (body + parameters) on the RestApi, and one JSON-schema model per route
 * (api-request-models.ts), attached to exactly:
 *
 *   POST /feedback-forms/{form_id}/submit   the embeddable widget and the prototype pin widget
 *   POST /voting-sessions/{session_id}/submit  the ballot page
 *   POST /oauth/register                    MCP clients' dynamic client registration (RFC 7591)
 *
 * A junk body is refused at the gateway, before it costs a Lambda invocation; the handler still validates
 * everything (the models are never stricter than it, and sometimes looser). Deliberately NOT validated:
 *
 *  - `POST /unsubscribe` ALWAYS answers 200, whatever the body (the answer never says whether a token was
 *    known), RFC 8058 one-click posts `List-Unsubscribe=One-Click` as a urlencoded form and the token rides
 *    in `?t=`, which wins over any body. Any model would refuse something the handler answers 200.
 *  - `POST /oauth/token`, `POST /oauth/revoke` take `application/x-www-form-urlencoded` (RFC 6749 §4.1.3,
 *    RFC 7009 §2.1). A model validates a JSON body; a form body is not JSON, so a model under that content
 *    type would refuse every legitimate request.
 *  - Signed-in routes: their Lambdas validate (Pydantic / Zod), unchanged.
 *
 * Models are keyed by `application/json` only, never `$default`: "If no matching content type is found,
 * request validation is not performed"
 * (https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-method-request-validation.html),
 * so a client sending another content type reaches the handler exactly as before.
 *
 * Parameters: no method declares a required request parameter, so parameter validation checks nothing
 * today (path parameters are always present once the route matched); cdk-nag requires both switches on.
 */
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { PUBLIC_BODY_MODELS, type PublicBodyModelName } from './api-request-models';

const VALIDATOR_ID = 'PublicBodyValidator';
const JSON_CONTENT_TYPE = 'application/json';

/**
 * The body of a gateway validation 400 (BAD_REQUEST_BODY). Gateway response templates are non-VTL, simple
 * substitution only (api-gateway-gatewayResponse-definition.html), and API-wide, so one shape serves every
 * validated route:
 *  - `success: false` + `error` (a string): the widgets' and the SPA's error shape;
 *  - `reason: 'invalid'`: what the ballot page maps to its "this ballot could not be read" copy
 *    (ballots_handler REASON_INVALID), a permanent refusal rather than "try again";
 *  - `error: 'invalid_request'` + `error_description`: an OAuth error object (RFC 6749 §5.2 code).
 * `$context.error.messageString` is the quoted, escaped "Invalid request body"; the unquoted
 * `validationErrorString` is NOT used, because it carries raw double quotes that would break the JSON.
 */
export const VALIDATION_ERROR_TEMPLATE = '{"success":false,"reason":"invalid","error":"invalid_request",'
  + '"error_description":"The request body does not match what this endpoint accepts.",'
  + '"message":$context.error.messageString}';

/**
 * The gateway answer to a body that failed validation: 400, the same CORS headers as every other gateway
 * error (`corsHeaders` = gatewayErrorCorsHeaders(allowedOrigin), api-gateway.ts), and the body above.
 */
export function addRequestValidationResponse(api: apigateway.RestApi, corsHeaders: Record<string, string>): void {
  api.addGatewayResponse('BadRequestBody', {
    type: apigateway.ResponseType.BAD_REQUEST_BODY,
    statusCode: '400',
    responseHeaders: corsHeaders,
    templates: { [JSON_CONTENT_TYPE]: VALIDATION_ERROR_TEMPLATE },
  });
}

function validatorOf(api: apigateway.RestApi): apigateway.IRequestValidator {
  const existing = api.node.tryFindChild(VALIDATOR_ID);
  if (existing instanceof apigateway.RequestValidator) return existing;
  return api.addRequestValidator(VALIDATOR_ID, {
    requestValidatorName: 'voc-public-body-validator',
    validateRequestBody: true,
    validateRequestParameters: true,
  });
}

function modelOf(api: apigateway.RestApi, name: PublicBodyModelName): apigateway.IModel {
  const id = `${name}Model`;
  const existing = api.node.tryFindChild(id);
  if (existing instanceof apigateway.Model) return existing;
  return api.addModel(id, { modelName: name, contentType: JSON_CONTENT_TYPE, schema: PUBLIC_BODY_MODELS[name] });
}

/** The method options that validate a public route's JSON body against its model (created once per API). */
export function publicBodyValidation(
  api: apigateway.RestApi, name: PublicBodyModelName,
): Pick<apigateway.MethodOptions, 'requestValidator' | 'requestModels'> {
  return { requestValidator: validatorOf(api), requestModels: { [JSON_CONTENT_TYPE]: modelOf(api, name) } };
}
