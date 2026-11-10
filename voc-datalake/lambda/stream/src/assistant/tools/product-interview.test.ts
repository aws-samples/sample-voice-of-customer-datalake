/**
 * The guided product interview (Product tab → "Fill with AI assistant"): its guidance
 * reaches the system prompt of a project page whose caller may edit, asks about exactly
 * the product-context fields, once each, and is absent where it could not end in a write.
 */
import { describe, expect, it } from 'vitest';
import type { PageKind } from '../contract.js';
import { buildCatalogue } from './catalogue.js';
import { LIFECYCLE_STATES, PRODUCT_CONTEXT_STRING_FIELDS } from './client/allowlists.js';
import { buildToolGuidance } from './guidance.js';
import { PRODUCT_INTERVIEW_GUIDANCE, PRODUCT_INTERVIEW_QUESTIONS } from './product-interview.js';
import { selectToolset, withoutProjectWrites } from './registry.js';
import { fakeDeps } from './test-fixtures.js';

const catalogue = buildCatalogue(fakeDeps());
const byName = (a: string, b: string) => a.localeCompare(b);
const PRODUCT_FIELDS = [...Object.keys(PRODUCT_CONTEXT_STRING_FIELDS), 'current_state'].sort(byName);

function toolsetFor(kind: PageKind) {
  return selectToolset(catalogue, { page: { kind, path: '/projects/p1', projectId: 'p1' }, isAdmin: false, webSearch: false });
}

/** The field each `  - <field>: <question>` line of a guidance text asks about. */
function askedFields(guidance: string): string[] {
  return guidance.split('\n').flatMap((line) => /^ {2}- ([a-z_]+): /.exec(line)?.[1] ?? []);
}

describe('the product interview questions', () => {
  it('ask about every product-context field exactly once', () => {
    const fields = PRODUCT_INTERVIEW_QUESTIONS.map((q) => q.field);
    expect(new Set(fields).size).toBe(fields.length);
    expect([...fields].sort(byName)).toStrictEqual(PRODUCT_FIELDS);
  });

  it('start with what the product is and end with the free-form notes', () => {
    expect(PRODUCT_INTERVIEW_QUESTIONS.map((q) => q.field)).toStrictEqual([
      'product_name', 'one_liner', 'target_users', 'problem_solved', 'current_state', 'key_features',
      'differentiators', 'success_metrics', 'known_limitations', 'non_goals', 'free_form_notes',
    ]);
  });

  it('name every lifecycle value the write accepts for current_state', () => {
    const question = PRODUCT_INTERVIEW_QUESTIONS.find((q) => q.field === 'current_state')?.question ?? '';
    expect(question).toContain(`(one of ${LIFECYCLE_STATES.join(', ')})`);
  });
});

describe('the product interview guidance', () => {
  it('is in the guidance of a project page that offers update_product_context, listing exactly the product fields', () => {
    const guidance = buildToolGuidance(toolsetFor('project'));
    expect(guidance).toContain(PRODUCT_INTERVIEW_GUIDANCE);
    expect(askedFields(guidance).sort(byName)).toStrictEqual(PRODUCT_FIELDS);
  });

  it.each([
    '"Fill with AI assistant"', '(1) get_product_context', 'ONE question per message',
    'never invent an answer', 'propose ONE update_product_context',
  ])('tells the model %s (read first, one question at a time, ONE approval card)', (rule) => {
    expect(PRODUCT_INTERVIEW_GUIDANCE).toContain(rule);
  });

  it('is left out for a caller who can only view the project', () => {
    const guidance = buildToolGuidance(withoutProjectWrites(toolsetFor('project')));
    expect(guidance).not.toContain('Product interview');
    expect(askedFields(guidance)).toStrictEqual([]);
  });

  it('is left out on a page without the project pack', () => {
    expect(buildToolGuidance(toolsetFor('dashboard'))).not.toContain('Product interview');
  });
});
