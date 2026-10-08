/**
 * The by-date GSI query, field for field.
 *
 * The mutation run found that the callers' specs answer from a fake `send` that
 * ignores the key condition and the sort order, so neither was pinned: a blank
 * condition or an oldest-first walk passed every test.
 */
import { describe, expect, it } from 'vitest';
import { feedbackByDateQuery } from './feedback-by-date-query.js';

describe('feedbackByDateQuery', () => {
  it('queries one DATE# partition of gsi1-by-date, newest first, with the caller paging', () => {
    const command = feedbackByDateQuery('voc-feedback', '2026-03-04', { Limit: 25, ExclusiveStartKey: { pk: 'k' } });

    expect(command.input).toStrictEqual({
      TableName: 'voc-feedback',
      IndexName: 'gsi1-by-date',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': 'DATE#2026-03-04' },
      ScanIndexForward: false,
      Limit: 25,
      ExclusiveStartKey: { pk: 'k' },
    });
  });
});
