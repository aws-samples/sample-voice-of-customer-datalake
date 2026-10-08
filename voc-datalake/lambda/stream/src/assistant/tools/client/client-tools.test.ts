import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS } from '../../contract.js';
import { clientToolLookup, clientToolsByName, fakeContext } from '../test-fixtures.js';
import { FEEDBACK_FORM_UPDATE_FIELDS, PERSONA_UPDATE_FIELDS, PRODUCT_CONTEXT_STRING_FIELDS } from './allowlists.js';
import { NEW_TOOL_VALID_ARGS } from './new-tools-fixtures.js';

const clientTools = clientToolsByName();
const tool = clientToolLookup();

const projectPage = fakeContext('project', { projectId: 'proj_1' });
const dashboard = fakeContext('dashboard');
const admin = fakeContext('settings', {}, { isAdmin: true });

/** Minimal valid args per tool (project tools rely on the page default). */
const VALID: Record<string, Record<string, unknown>> = {
  create_project: { name: 'Booking fixes' },
  set_problem_resolved: { problem_key: 'delivery::late', resolved: true },
  set_feedback_category: { feedback_id: 'fb_1', category: 'delivery', subcategory: 'late' },
  update_document: { document_id: 'prd_1', content: '# PRD', change_summary: 'Tightened scope' },
  create_document: { title: 'Notes', content: 'Body' },
  delete_document: { document_id: 'doc_1', reason: 'Duplicate' },
  update_persona: { persona_id: 'persona_1', updates: { tagline: 'Busy parent' } },
  add_persona_note: { persona_id: 'persona_1', text: 'Mentioned pricing twice' },
  update_project: { name: 'Renamed' },
  update_product_context: { updates: { one_liner: 'Faster checkout', current_state: 'beta' } },
  start_research: { question: 'Why do users churn?' },
  generate_document: { doc_type: 'prd', title: 'Checkout PRD', feature_idea: 'One-click checkout' },
  generate_personas: { persona_count: 3 },
  merge_documents: { output_type: 'prd', title: 'Merged', instructions: 'Combine', document_ids: ['d1', 'd2'] },
  update_feedback_form: { form_id: 'abc12345', updates: { enabled: true, title: 'Tell us' } },
  run_scraper: { scraper_id: 'scraper_1' },
  save_brand_settings: { brand_name: 'Acme', hashtags: ['#acme'] },
  ...NEW_TOOL_VALID_ARGS,
};

describe('client tool validators', () => {
  it('cover every client tool in this table', () => {
    expect([...clientTools.keys()].sort((a, b) => a.localeCompare(b)))
      .toStrictEqual(Object.keys(VALID).sort((a, b) => a.localeCompare(b)));
  });

  it.each(Object.entries(VALID))('%s accepts its minimal valid arguments and summarizes them', (name, args) => {
    const adminOnly = ADMIN_ONLY_CLIENT_TOOLS.some((admin) => admin === name);
    const result = tool(name).validate(args, adminOnly ? admin : projectPage);
    expect(result.ok).toBe(true);
    const summary = result.ok ? tool(name).summarize(result.args) : '';
    expect(summary.length).toBeGreaterThan(5);
    expect(summary).not.toContain('\n');
  });

  it.each(Object.entries(VALID))('%s refuses unknown top-level keys', (name, args) => {
    const result = tool(name).validate({ ...args, project_id: 'proj_1', sneaky: 1 }, admin);
    expect(result).toMatchObject({ ok: false });
  });

  it('fills project_id from the page and keeps an explicit one', () => {
    expect(tool('create_document').validate({ title: 't', content: 'c' }, projectPage))
      .toStrictEqual({ ok: true, args: { project_id: 'proj_1', title: 't', content: 'c' } });
    expect(tool('create_document').validate({ project_id: 'proj_9', title: 't', content: 'c' }, projectPage))
      .toMatchObject({ ok: true, args: { project_id: 'proj_9' } });
  });

  it('refuses a project tool when neither the model nor the page names a project', () => {
    const result = tool('create_document').validate({ title: 't', content: 'c' }, dashboard);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('project_id');
  });

  it('set_feedback_category fills feedback_id from the item on screen', () => {
    const feedbackPage = fakeContext('feedback', { feedbackId: 'fb_7' });
    expect(tool('set_feedback_category').validate({ category: 'billing' }, feedbackPage))
      .toStrictEqual({ ok: true, args: { feedback_id: 'fb_7', category: 'billing' } });
    expect(tool('set_feedback_category').validate({ category: 'billing' }, dashboard).ok).toBe(false);
  });

  it('set_feedback_category bounds its category and feedback_id', () => {
    const setCategory = tool('set_feedback_category');
    expect(setCategory.validate({ feedback_id: 'fb_1', category: 'x'.repeat(65) }, dashboard).ok).toBe(false);
    expect(setCategory.validate({ feedback_id: '../x', category: 'billing' }, dashboard).ok).toBe(false);
  });

  it('set_feedback_category is a plain insights write for any user', () => {
    expect(tool('set_feedback_category').risk).toBe('write');
    expect(tool('set_feedback_category').pack).toBe('insights');
  });

  // The argument bounds of the contract.
  it.each<[string, Record<string, unknown>, 'dashboard' | 'project' | 'admin']>([
    ['create_project', { name: '' }, 'dashboard'],
    ['create_project', { name: 'x'.repeat(201) }, 'dashboard'],
    ['generate_personas', { persona_count: 9 }, 'project'],
    ['merge_documents', { ...VALID.merge_documents, document_ids: ['only'] }, 'project'],
    ['update_project', {}, 'project'],
    ['save_brand_settings', {}, 'admin'],
    ['update_document', { ...VALID.update_document, document_id: '../x' }, 'project'],
  ])('%s refuses %o', (name, args, page) => {
    const ctx = { dashboard, project: projectPage, admin }[page];
    expect(tool(name).validate(args, ctx).ok).toBe(false);
  });

  it('refuses admin-only write tools for non-admins', () => {
    expect(tool('run_scraper').validate({ scraper_id: 's1' }, dashboard)).toMatchObject({ ok: false });
    expect(tool('save_brand_settings').validate({ brand_name: 'Acme' }, dashboard)).toMatchObject({ ok: false });
  });

  it('marks delete_document destructive and the rest as writes', () => {
    expect(tool('delete_document').risk).toBe('destructive');
    expect(tool('update_document').risk).toBe('write');
  });

  it('summarizes with the touched project and the change summary', () => {
    const result = tool('update_document').validate({ ...VALID.update_document, title: 'PRD v2' }, projectPage);
    expect(result.ok ? tool('update_document').summarize(result.args) : '')
      .toBe("Update document 'PRD v2' in project proj_1: Tightened scope");
  });
});

describe('updates allowlists', () => {
  const SAMPLE_PERSONA_VALUES: Record<string, unknown> = {
    name: 'x', tagline: 'x', confidence: 'high', quotes: [{ text: 'A quote' }], scenario: { narrative: 'A day in the life' },
  };

  it.each(PERSONA_UPDATE_FIELDS)('update_persona accepts %s', (field) => {
    const updates = { [field]: SAMPLE_PERSONA_VALUES[field] ?? {} };
    expect(tool('update_persona').validate({ persona_id: 'p1', updates }, projectPage).ok).toBe(true);
  });

  it('update_persona refuses unknown keys inside a section and bare-string quotes', () => {
    const validate = (updates: Record<string, unknown>) => tool('update_persona')
      .validate({ persona_id: 'p1', updates }, projectPage).ok;
    expect(validate({ identity: { bio: 'B', avatar_url: 'https://x' } })).toBe(false);
    expect(validate({ quotes: ['A quote'] })).toBe(false);
  });

  it.each(['avatar_url', 'avatar_prompt', 'research_notes', 'pk', 'persona_id'])('update_persona refuses %s', (field) => {
    expect(tool('update_persona').validate({ persona_id: 'p1', updates: { [field]: 'x' } }, projectPage).ok).toBe(false);
  });

  it('update_persona refuses empty updates', () => {
    expect(tool('update_persona').validate({ persona_id: 'p1', updates: {} }, projectPage).ok).toBe(false);
  });

  it.each(Object.entries(PRODUCT_CONTEXT_STRING_FIELDS))('update_product_context bounds %s at %i', (field, max) => {
    const check = (length: number) => tool('update_product_context')
      .validate({ updates: { [field]: 'x'.repeat(length) } }, projectPage).ok;
    expect(check(max)).toBe(true);
    expect(check(max + 1)).toBe(false);
  });

  it('update_product_context refuses unknown keys and bad lifecycle states', () => {
    expect(tool('update_product_context').validate({ updates: { pricing: 'x' } }, projectPage).ok).toBe(false);
    expect(tool('update_product_context').validate({ updates: { current_state: 'retired' } }, projectPage).ok).toBe(false);
  });

  const validateFormUpdates = (updates: Record<string, unknown>) => tool('update_feedback_form')
    .validate({ form_id: 'f1', updates }, dashboard).ok;

  it('update_feedback_form accepts the flat display settings', () => {
    expect(FEEDBACK_FORM_UPDATE_FIELDS).toHaveLength(14);
    expect(validateFormUpdates({ rating_type: 'emoji', collect_email: false })).toBe(true);
  });

  it.each<Record<string, unknown>>([
    { rating_max: 5 },
    { category: 'billing' },
    { theme: { primary_color: '#000' } },
    { custom_fields: [] },
    { project_id: 'proj_1' },
    { brand_name: 'x' },
    { dimension_defaults: { Product: 'app' } },
    { dimension_defaults: { product: 'a b' } },
    { tags: ['a#b'] },
    { tags: Array.from({ length: 21 }, (_, n) => `t${n}`) },
  ])('update_feedback_form refuses %o', (updates) => {
    expect(validateFormUpdates(updates)).toBe(false);
  });
});

describe('allowlist constants describe the schemas', () => {
  // The constants are what the frontend lockstep reads; these pin them to the
  // schemas they name, so the lockstep is not comparing a stale list.
  const personaAccepts = (updates: Record<string, unknown>) =>
    tool('update_persona').validate({ persona_id: 'p1', updates }, projectPage).ok;

  it('update_feedback_form accepts exactly FEEDBACK_FORM_UPDATE_FIELDS', () => {
    const sample: Record<string, unknown> = {
      enabled: true, rating_enabled: true, collect_email: true, collect_name: true, rating_type: 'stars',
      dimension_defaults: { product: 'app' }, tags: ['vip'],
    };
    const accepted = FEEDBACK_FORM_UPDATE_FIELDS.filter((field) => tool('update_feedback_form')
      .validate({ form_id: 'f1', updates: { [field]: sample[field] ?? 'x' } }, dashboard).ok);
    expect(accepted).toStrictEqual([...FEEDBACK_FORM_UPDATE_FIELDS]);
  });

  it('update_persona refuses every key outside PERSONA_UPDATE_FIELDS that a persona row carries', () => {
    expect(['avatar_url', 'avatar_prompt', 'research_notes', 'created_at'].some((field) => personaAccepts({ [field]: 'x' }))).toBe(false);
  });
});
