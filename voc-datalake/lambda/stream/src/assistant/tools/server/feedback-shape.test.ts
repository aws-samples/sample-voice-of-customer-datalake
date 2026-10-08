import { describe, expect, it } from 'vitest';
import { toFeedbackSource } from './feedback-shape.js';

const STORED_OVERRIDE = {
  previous_category: 'delivery',
  previous_subcategory: 'late',
  by_sub: 'sub-secret',
  by_username: 'ada',
  at: '2026-01-01T00:00:00Z',
};
const PUBLIC_OVERRIDE = {
  previous_category: 'delivery',
  previous_subcategory: 'late',
  by_username: 'ada',
  at: '2026-01-01T00:00:00Z',
};

describe('category_override on source cards', () => {
  it('never carries the editor\'s Cognito subject to the SPA', () => {
    const card = toFeedbackSource({ feedback_id: 'f1', category: 'billing', category_override: STORED_OVERRIDE });
    expect(card).toStrictEqual({ feedback_id: 'f1', category: 'billing', category_override: PUBLIC_OVERRIDE });
    expect(JSON.stringify(card)).not.toContain('sub-secret');
  });

  it('drops a malformed override instead of passing it through', () => {
    expect(toFeedbackSource({ feedback_id: 'f1', category_override: 'junk' })).toStrictEqual({ feedback_id: 'f1' });
    expect(toFeedbackSource({ feedback_id: 'f1', category_override: ['x'] })).toStrictEqual({ feedback_id: 'f1' });
  });
});
