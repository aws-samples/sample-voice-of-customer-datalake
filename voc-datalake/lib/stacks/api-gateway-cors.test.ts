/**
 * Gateway-generated errors answer with the API's own origin (issue #267 item 10).
 *
 * DEFAULT_4XX / DEFAULT_5XX / UNAUTHORIZED used to hardcode
 * `Access-Control-Allow-Origin: '*'` while every Lambda answered with
 * `ALLOWED_ORIGIN` (the frontend domain in production). They now take the same
 * value, add `Vary: Origin` when it is one origin, and never send credentials.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import type { Template } from 'aws-cdk-lib/assertions';

import { apiTemplate, apiTemplateDev, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

beforeAll(() => {
  apiTemplate();
  apiTemplateDev();
}, SYNTH_TIMEOUT_MS);

const ERROR_RESPONSES = ['DEFAULT_4XX', 'DEFAULT_5XX', 'UNAUTHORIZED'] as const;

const ResponseParamsSchema = z.object({
  Properties: z.object({
    ResponseType: z.string(),
    ResponseParameters: z.record(z.string(), z.string()),
  }),
});

/** The `gatewayresponse.header.*` parameters of the one `type` response. */
function headersOf(template: Template, type: string): Record<string, string> {
  const match = Object.values(template.findResources('AWS::ApiGateway::GatewayResponse'))
    .map((resource) => ResponseParamsSchema.parse(resource).Properties)
    .find((props) => props.ResponseType === type);
  return Object.fromEntries(
    Object.entries(match?.ResponseParameters ?? {})
      .map(([name, value]) => [name.replace('gatewayresponse.header.', ''), value]),
  );
}

/** What the Lambdas answer with, single-quoted as a gateway header value. */
function lambdaOrigin(template: Template): string {
  return `'${z.string().parse(serviceEnvironment(template, 'voc-metrics-api').ALLOWED_ORIGIN)}'`;
}

describe('gateway error responses carry the API origin', () => {
  it.each(ERROR_RESPONSES)('%s matches the Lambdas’ ALLOWED_ORIGIN in production', (type) => {
    const template = apiTemplate();
    expect(headersOf(template, type)['Access-Control-Allow-Origin']).toStrictEqual(lambdaOrigin(template));
  });

  it.each(ERROR_RESPONSES)('%s is not a wildcard in production and varies on Origin', (type) => {
    const headers = headersOf(apiTemplate(), type);
    expect(headers['Access-Control-Allow-Origin']).not.toBe("'*'");
    expect(headers.Vary).toMatch(/^'Origin(, Authorization)?'$/);
  });

  it.each(ERROR_RESPONSES)('%s stays a wildcard in dev', (type) => {
    expect(headersOf(apiTemplateDev(), type)['Access-Control-Allow-Origin']).toBe("'*'");
  });

  it.each(ERROR_RESPONSES)('%s never sends credentials', (type) => {
    expect(headersOf(apiTemplate(), type)['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  it('keeps the Authorization vary on the 401 in dev, without Origin', () => {
    expect(headersOf(apiTemplateDev(), 'UNAUTHORIZED').Vary).toBe("'Authorization'");
  });
});
