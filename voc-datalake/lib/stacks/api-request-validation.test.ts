/**
 * API Gateway request validation on the public write routes (api-request-validation.ts, cdk-nag APIG2).
 *
 * Pins: ONE validator (body + parameters) on the RestApi; a model on EXACTLY the two public JSON write
 * routes and on no other method (signed-in routes, `/unsubscribe`, the `/oauth/*` facade stay
 * unvalidated at the gateway); each model's exact draft-4 schema; the bounds lockstepped with the Python
 * constants they mirror; the BAD_REQUEST_BODY gateway response's CORS headers and body.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Template } from 'aws-cdk-lib/assertions';

import {
  apiMethods, apiTemplate, apiTemplateAllPlugins, apiTemplateFlagged, RefSchema,
} from '../test-support/api-stack-template';
import { pythonIntConstant } from '../test-support/cross-language-invariants';
import { gatewayResponseOfType } from '../test-support/gateway-responses';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import {
  FEEDBACK_SUBMISSION_BOUNDS,
} from './api-request-models';
import { VALIDATION_ERROR_TEMPLATE } from './api-request-validation';

beforeAll(() => {
  apiTemplate();
  apiTemplateAllPlugins();
  apiTemplateFlagged();
}, SYNTH_TIMEOUT_MS);

const ROOT = join(__dirname, '..', '..');
const FORM_HANDLER = ['lambda', 'api', 'feedback_form_handler.py'];
const BALLOTS_HANDLER = ['lambda', 'api', 'ballots_handler.py'];
const DRAFT4 = 'http://json-schema.org/draft-04/schema#';
const PINNED_MODELS = join(ROOT, 'schemas', 'public-body-models.json');

const VALIDATED_ROUTES: Record<string, string> = {
  'POST /feedback-forms/{form_id}/submit': 'FeedbackFormSubmission',
  'POST /voting-sessions/{session_id}/submit': 'BallotSubmission',
};

const ValidatorSchema = z.object({
  Properties: z.object({ RestApiId: RefSchema, ValidateRequestBody: z.boolean(), ValidateRequestParameters: z.boolean() }),
});
const ModelSchema = z.object({
  Properties: z.object({ Name: z.string(), ContentType: z.string(), RestApiId: RefSchema, Schema: z.unknown() }),
});
const MethodValidationSchema = z.object({
  Properties: z.object({
    RequestValidatorId: RefSchema.optional(),
    RequestModels: z.record(z.string(), RefSchema).optional(),
  }),
});
function restApiId(template: Template): string {
  const ids = Object.keys(template.findResources('AWS::ApiGateway::RestApi'));
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

/** Route -> model name, for every method carrying a validator or a model. */
function validatedRoutes(template: Template): Record<string, string> {
  const models = new Map(Object.entries(template.findResources('AWS::ApiGateway::Model'))
    .map(([id, model]) => [id, ModelSchema.parse(model).Properties.Name]));
  const resources = template.findResources('AWS::ApiGateway::Method');
  const routes: Record<string, string> = {};
  for (const method of apiMethods(template)) {
    const props = MethodValidationSchema.parse(resources[method.logicalId]).Properties;
    if (props.RequestValidatorId === undefined && props.RequestModels === undefined) continue;
    expect(Object.keys(props.RequestModels ?? {})).toStrictEqual(['application/json']);
    routes[method.route] = models.get(props.RequestModels?.['application/json']?.Ref ?? '') ?? '<none>';
  }
  return routes;
}

describe('the request validator', () => {
  it.each([['default', apiTemplate], ['all plugins', apiTemplateAllPlugins]])('%s: one, body + parameters, on the API', (_, synth) => {
    const template = synth();
    const validators = Object.values(template.findResources('AWS::ApiGateway::RequestValidator'))
      .map((validator) => ValidatorSchema.parse(validator).Properties);
    expect(validators).toStrictEqual([
      { RestApiId: { Ref: restApiId(template) }, ValidateRequestBody: true, ValidateRequestParameters: true },
    ]);
  });

  it.each([['default', apiTemplate], ['all plugins', apiTemplateAllPlugins]])('%s: models on exactly the public JSON write routes', (_, synth) => {
    expect(validatedRoutes(synth())).toStrictEqual(VALIDATED_ROUTES);
  });

  it('skipFeedbackFormItemRoutes: the widget route is absent, the other two keep their model', () => {
    const rest = Object.fromEntries(Object.entries(VALIDATED_ROUTES)
      .filter(([route]) => !route.startsWith('POST /feedback-forms/')));
    expect(validatedRoutes(apiTemplateFlagged())).toStrictEqual(rest);
  });
});

describe('the models (JSON Schema draft 4, never stricter than the handler)', () => {
  const schemas = (): Record<string, unknown> => Object.fromEntries(
    Object.values(apiTemplate().findResources('AWS::ApiGateway::Model')).map((model) => {
      const props = ModelSchema.parse(model).Properties;
      expect(props.ContentType).toBe('application/json');
      expect(props.RestApiId).toStrictEqual({ Ref: restApiId(apiTemplate()) });
      return [props.Name, props.Schema];
    }));

  it('feedback form submission', () => {
    expect(schemas().FeedbackFormSubmission).toStrictEqual({
      $schema: DRAFT4, title: 'FeedbackFormSubmission', type: 'object', required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1 },
        rating: { type: ['number', 'null'], minimum: 1, maximum: 10 },
        name: { type: ['string', 'null'], maxLength: 200 },
        email: { type: ['string', 'null'], maxLength: 254 },
        page_url: { type: ['string', 'null'], maxLength: 4096 },
        custom_fields: {
          type: ['object', 'null'], maxProperties: 20, patternProperties: { '^$': { not: {} } },
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'], maxLength: 1000 },
        },
        dimensions: { type: ['object', 'null'], maxProperties: 10 },
      },
    });
  });

  it('ballot submission', () => {
    expect(schemas().BallotSubmission).toStrictEqual({
      $schema: DRAFT4, title: 'BallotSubmission', type: 'object', properties: { notes: { type: ['string', 'null'] } },
    });
  });

  // lambda/api/test/test_public_body_models_parity.py runs every boundary body through the handlers AND these
  // models (draft-4 validator), from this pinned copy: a deliberate model change updates the JSON file too (the
  // failure prints the difference).
  it('the parity test reads exactly the synthesized models (schemas/public-body-models.json)', () => {
    expect(JSON.parse(readFileSync(PINNED_MODELS, 'utf8'))).toStrictEqual(schemas());
  });

  it('no model refuses extra fields (widget participant_token, pin bodies)', () => {
    for (const schema of Object.values(schemas())) {
      expect(z.object({ additionalProperties: z.unknown().optional() }).parse(schema).additionalProperties).toBeUndefined();
    }
  });

  it('every field the embeddable widget sends is declared, and only `text` is required', () => {
    const widget = readFileSync(join(ROOT, 'lambda', 'api', 'static', 'feedback-widget.js'), 'utf8');
    // The widget's flat payload literal; a nested object in it would end the match early, so the list is pinned.
    const payload = /var payload = \{([^}]*)\}/.exec(widget)?.[1] ?? '';
    expect(payload, 'feedback-widget.js: no flat `var payload = {…}` literal').not.toBe('');
    const fields = payload.split(',').map((entry) => entry.split(':')[0]?.trim());
    expect(fields).toStrictEqual(['text', 'rating', 'name', 'email', 'page_url']);
    const schema = z.object({ required: z.array(z.string()), properties: z.record(z.string(), z.unknown()) })
      .parse(schemas().FeedbackFormSubmission);
    expect(schema.required).toStrictEqual(['text']);
    for (const field of fields) expect(Object.keys(schema.properties)).toContain(field);
  });
});

/** The single-quoted items of a Python tuple constant `NAME: Final = ('a', 'b')`. */
function pythonStringTuple(name: string, ...segments: string[]): string[] {
  const source = readFileSync(join(ROOT, ...segments), 'utf8');
  const tuple = new RegExp(`^${name}(?::\\s*Final)?\\s*=\\s*\\(([^)]*)\\)`, 'm').exec(source)?.[1];
  if (tuple === undefined) throw new Error(`${segments.join('/')}: no ${name} tuple`);
  return [...tuple.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('lockstep with the handlers', () => {
  it.each(Object.entries(FEEDBACK_SUBMISSION_BOUNDS))('feedback_form_handler.%s', (name, value) => {
    expect(pythonIntConstant(name, ...FORM_HANDLER)).toBe(value);
  });

  it('ballots_handler: `notes` is a submission field the handler reads as text', () => {
    expect(pythonStringTuple('SUBMISSION_FIELDS', ...BALLOTS_HANDLER)).toContain('notes');
    expect(readFileSync(join(ROOT, ...BALLOTS_HANDLER), 'utf8')).toContain("_validated_note(body.get('notes'))");
  });
});

describe('a failed validation (BAD_REQUEST_BODY)', () => {
  it('is a 400 with the same CORS headers as every other gateway 4XX', () => {
    const template = apiTemplate();
    const response = gatewayResponseOfType(template, 'BAD_REQUEST_BODY');
    expect(response.StatusCode).toBe('400');
    expect(response.ResponseParameters).toStrictEqual(gatewayResponseOfType(template, 'DEFAULT_4XX').ResponseParameters);
    expect(response.ResponseTemplates).toStrictEqual({ 'application/json': VALIDATION_ERROR_TEMPLATE });
  });

  it('renders a JSON body the widget (error), the ballot page (reason) and an OAuth client can read', () => {
    const rendered = VALIDATION_ERROR_TEMPLATE.replace('$context.error.messageString', '"Invalid request body"');
    expect(JSON.parse(rendered)).toStrictEqual({
      success: false, reason: 'invalid', error: 'invalid_request',
      error_description: 'The request body does not match what this endpoint accepts.',
      message: 'Invalid request body',
    });
    // The ballot page maps this reason to its permanent "could not be read" copy.
    expect(readFileSync(join(ROOT, ...BALLOTS_HANDLER), 'utf8')).toContain("REASON_INVALID = 'invalid'");
  });
});
