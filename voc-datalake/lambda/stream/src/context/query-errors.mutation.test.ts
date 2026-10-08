/**
 * The persistent-error vocabulary, exactly.
 *
 * The mutation run found that the consumers' specs only ever raise
 * AccessDeniedException, so blanking the other two names went unnoticed — and a
 * missing name means that failure is retried and reported once per partition.
 */
import { describe, expect, it } from 'vitest';
import { PERSISTENT_QUERY_ERRORS } from './query-errors.js';

describe('PERSISTENT_QUERY_ERRORS', () => {
  it('names exactly the errors that fail identically for every partition', () => {
    expect([...PERSISTENT_QUERY_ERRORS]).toStrictEqual([
      'AccessDeniedException',
      'ResourceNotFoundException',
      'ValidationException',
    ]);
  });
});
