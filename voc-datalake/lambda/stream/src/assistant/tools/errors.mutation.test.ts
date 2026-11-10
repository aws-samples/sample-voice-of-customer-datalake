/**
 * What the mutation run found the tool specs never looked at: the HTTP status
 * each tool error code carries, the error's name, and the exact generic
 * sentence that replaces an untrusted failure's text.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, ServiceError, ValidationError } from '../../lib/errors.js';
import { AssistantToolError, describeToolError, isAssistantToolError } from './errors.js';

describe('AssistantToolError', () => {
  it.each([
    ['invalid_input', 400],
    ['not_permitted', 403],
    ['not_found', 404],
    ['too_large', 413],
    ['not_configured', 500],
    ['unavailable', 502],
  ] as const)('maps %s to HTTP %i', (code, status) => {
    const err = new AssistantToolError(code, 'm');
    expect({ name: err.name, code: err.code, statusCode: err.statusCode, message: err.message })
      .toStrictEqual({ name: 'AssistantToolError', code, statusCode: status, message: 'm' });
    expect(isAssistantToolError(err)).toBe(true);
  });
});

describe('describeToolError', () => {
  const GENERIC = 'The tool failed unexpectedly. Tell the user the data could not be read right now.';

  it.each([
    ['a tool error, verbatim', new AssistantToolError('unavailable', 'Service down.'), 'Service down.'],
    ['a 4xx ApiError, verbatim', new ValidationError('days must be 0-9999'), 'days must be 0-9999'],
    ['a 499 ApiError, verbatim', new ApiError('client gone', 499), 'client gone'],
    ['a 500 ApiError, as the generic sentence', new ServiceError('boto3 Traceback'), GENERIC],
    ['a plain Error, as the generic sentence', new Error('arn:aws:iam::123'), GENERIC],
    ['a non-error value, as the generic sentence', 'oops', GENERIC],
  ])('describes %s', (_label, err, text) => {
    expect(describeToolError(err)).toBe(text);
  });
});
