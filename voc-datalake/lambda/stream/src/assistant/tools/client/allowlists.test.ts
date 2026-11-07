/**
 * The `updates` shapes carry exactly the keys their field lists name. The SPA builds its approval
 * boundary from these shapes (`frontend/src/assistant/approvals/schemas.ts`, through `@stream`), so a key
 * here is a key a card accepts.
 */
import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_FORM_UPDATE_FIELDS,
  PERSONA_UPDATE_FIELDS,
  PRODUCT_CONTEXT_STRING_FIELDS,
  feedbackFormUpdatesShape,
  personaUpdatesShape,
  productContextUpdatesShape,
} from './allowlists.js';

const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b));

describe('client-tool updates allowlists', () => {
  it('persona: the shape has exactly PERSONA_UPDATE_FIELDS', () => {
    expect(sorted(Object.keys(personaUpdatesShape))).toStrictEqual(sorted(PERSONA_UPDATE_FIELDS));
  });

  it('product context: the string fields plus current_state', () => {
    expect(sorted(Object.keys(productContextUpdatesShape)))
      .toStrictEqual(sorted([...Object.keys(PRODUCT_CONTEXT_STRING_FIELDS), 'current_state']));
  });

  it('feedback form: the shape has exactly FEEDBACK_FORM_UPDATE_FIELDS', () => {
    expect(sorted(Object.keys(feedbackFormUpdatesShape))).toStrictEqual(sorted(FEEDBACK_FORM_UPDATE_FIELDS));
  });

  it('feedback form: routing, theme and rating-scale keys stay excluded', () => {
    const excluded = ['rating_max', 'category', 'subcategory', 'theme', 'custom_fields', 'project_id', 'document_id'];
    expect(FEEDBACK_FORM_UPDATE_FIELDS.filter((field) => excluded.includes(field))).toStrictEqual([]);
  });
});
