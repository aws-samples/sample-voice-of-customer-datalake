/**
 * Mutation hardening of the workspace write tools (create_project,
 * set_problem_resolved, set_feedback_category, update_feedback_form,
 * run_scraper, save_brand_settings).
 *
 * The run found unpinned: the advertised schemas (descriptions, the brand-list
 * array fragments, required lists), the trim on brand-list items, the
 * "change at least one field" refusal, and both branches of the summaries
 * (resolve vs reopen, with or without a subcategory, the ', ' joins).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClientToolDefinition } from '../../types.js';
import type { FakeContext } from '../test-fixtures.js';
import {
  expectSpec,
  expectStringBound,
  idProp,
  itTrimsAndBounds,
  outcome,
  summaryOf,
  textProp,
} from './spec-mutation-fixtures.js';

// Loaded in a hook, not by a static import: a module that throws while loading (a brand-list
// helper gone) must FAIL a test — a throwing import or hook only skips them, which kills no mutant.
let tool: (name: string) => ClientToolDefinition;
let dashboard: FakeContext;
let admin: FakeContext;
let workspaceToolNames: string[] = [];
let loadError: unknown;

beforeAll(async () => {
  try {
    const fixtures = await import('../test-fixtures.js');
    const { createWorkspaceClientTools } = await import('./workspace.js');
    workspaceToolNames = createWorkspaceClientTools().map((definition) => definition.name);
    tool = fixtures.clientToolLookup();
    dashboard = fixtures.fakeContext('dashboard');
    admin = fixtures.fakeContext('settings', {}, { isAdmin: true });
  } catch (error) {
    loadError = error;
  }
});

it('the module loads and defines the six workspace tools, in order', () => {
  expect(loadError).toBeUndefined();
  expect(workspaceToolNames).toStrictEqual([
    'create_project', 'set_problem_resolved', 'set_feedback_category', 'update_feedback_form', 'run_scraper', 'save_brand_settings',
  ]);
});

const brandListProp = (description: string, maxLength: number) => ({
  type: 'array', items: { type: 'string', maxLength }, maxItems: 50, description,
});

describe('the workspace tools advertise their exact schema and pack', () => {
  it('create_project', () => {
    expect(tool('create_project').pack).toBe('core');
    expectSpec(tool('create_project'), {
      description: 'Create a new research project, e.g. to turn the feedback findings of this conversation into a project.',
      properties: {
        name: textProp('Short project name.', 200),
        description: textProp('One-paragraph goal/scope, grounded in the feedback discussed.', 2000),
      },
      required: ['name'],
    });
  });

  it('set_problem_resolved', () => {
    expect(tool('set_problem_resolved').pack).toBe('insights');
    expectSpec(tool('set_problem_resolved'), {
      description: 'Mark a Problem Analysis problem as resolved (or reopen it). Use the exact problem_key returned by '
        + 'get_resolved_problems or shown on the Problems page.',
      properties: {
        problem_key: textProp('The problem key.', 300),
        resolved: { type: 'boolean', description: 'true = resolved, false = reopen.' },
      },
      required: ['problem_key', 'resolved'],
    });
  });

  it('set_feedback_category', () => {
    expectSpec(tool('set_feedback_category'), {
      description: 'Correct the category (and optionally subcategory) of one feedback item — e.g. when the user says '
        + 'a review was misclassified. Use a category name from list_categories; feedback_id defaults to the item on '
        + 'screen. The change is recorded as a manual correction (who and when), which a category reprocess leaves '
        + 'alone unless an administrator chooses to include manual corrections.',
      properties: {
        feedback_id: idProp('Feedback id; omit to use the item on screen.'),
        category: textProp('The new category name (from list_categories).', 64),
        subcategory: textProp('The new subcategory name, if the category has subcategories.', 64),
      },
      required: ['feedback_id', 'category'],
    });
  });

  it('update_feedback_form', () => {
    expect(tool('update_feedback_form').pack).toBe('forms');
    expectSpec(tool('update_feedback_form'), {
      description: 'Change settings of an embeddable feedback form. Allowed keys in `updates`: enabled, name, title, '
        + 'description, question, placeholder, submit_button_text, success_message, rating_enabled, rating_type '
        + '(stars|numeric|emoji), collect_email, collect_name. Enabling a form makes it accept public submissions.',
      properties: {
        form_id: idProp('Feedback form id.'),
        updates: { type: 'object', description: 'Settings to change (see the allowed keys).' },
      },
      required: ['form_id', 'updates'],
    });
  });

  it('run_scraper', () => {
    expect(tool('run_scraper').pack).toBe('scrapers');
    expectSpec(tool('run_scraper'), {
      description: 'Run a configured web scraper now (admin). New feedback is ingested in the background.',
      properties: { scraper_id: idProp('Scraper id from list_scrapers.') },
      required: ['scraper_id'],
    });
  });

  it('save_brand_settings', () => {
    expect(tool('save_brand_settings').pack).toBe('settings');
    expectSpec(tool('save_brand_settings'), {
      description: 'Change the brand settings (admin). Only the fields you send change; lists you send REPLACE the '
        + 'stored list, so read get_brand_settings first and send the complete list.',
      properties: {
        brand_name: textProp('Brand name.', 200),
        brand_handles: brandListProp('Social handles.', 100),
        hashtags: brandListProp('Hashtags.', 100),
        urls_to_track: brandListProp('URLs to track.', 200),
      },
      required: [],
    });
  });
});

describe('the text fields are trimmed and bounded', () => {
  itTrimsAndBounds([
    ['create_project', {}, 'name', 200],
    ['set_problem_resolved', { resolved: true }, 'problem_key', 300],
    ['set_feedback_category', { feedback_id: 'fb_1' }, 'category', 64],
    ['set_feedback_category', { feedback_id: 'fb_1', category: 'delivery' }, 'subcategory', 64],
    ['save_brand_settings', {}, 'brand_name', 200],
  ], (name) => tool(name), () => admin);

  it('create_project bounds its description at 2000 characters', () => {
    expectStringBound(tool('create_project'), dashboard, {
      base: { name: 'Booking fixes' }, field: 'description', max: 2000, trimmed: false,
    });
  });
});

describe('save_brand_settings lists', () => {
  const save = (args: Record<string, unknown>) => outcome(tool('save_brand_settings').validate(args, admin));
  const ok = (args: Record<string, unknown>) => tool('save_brand_settings').validate(args, admin).ok;

  it.each<[string, number]>([['brand_handles', 100], ['hashtags', 100], ['urls_to_track', 200]])(
    '%s trims each item and bounds it at %i characters',
    (field, max) => {
      expect(save({ [field]: ['  #acme  ', 'ab'] })).toStrictEqual({ [field]: ['#acme', 'ab'] });
      expect(ok({ [field]: ['   '] })).toBe(false);
      expect(ok({ [field]: ['x'.repeat(max)] })).toBe(true);
      expect(ok({ [field]: ['x'.repeat(max + 1)] })).toBe(false);
    },
  );

  it('takes at most 50 items', () => {
    const items = (count: number) => Array.from({ length: count }, (_, n) => `#tag${n}`);
    expect(ok({ hashtags: items(1) })).toBe(true);
    expect(ok({ hashtags: items(50) })).toBe(true);
    expect(ok({ hashtags: items(51) })).toBe(false);
  });

  it('refuses a call that changes nothing, saying so', () => {
    expect(save({})).toBe('Invalid arguments — change at least one field');
    expect(save({ brand_name: 'Acme' })).toStrictEqual({ brand_name: 'Acme' });
  });
});

describe('the summaries', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['create_project', { name: 'Booking fixes' }, "Create project 'Booking fixes'."],
    ['set_problem_resolved', { problem_key: 'delivery::late', resolved: true }, "Mark as resolved problem 'delivery::late'."],
    ['set_problem_resolved', { problem_key: 'delivery::late', resolved: false }, "Reopen problem 'delivery::late'."],
    ['set_feedback_category', { feedback_id: 'fb_1', category: 'delivery' }, "Change the category of feedback fb_1 to 'delivery'."],
    [
      'set_feedback_category', { feedback_id: 'fb_1', category: 'delivery', subcategory: 'late' },
      "Change the category of feedback fb_1 to 'delivery' / 'late'.",
    ],
    ['update_feedback_form', { form_id: 'abc12345', updates: { enabled: true, title: 'Tell us' } }, 'Update feedback form abc12345: enabled, title.'],
    ['run_scraper', { scraper_id: 'scraper_1' }, 'Run scraper scraper_1 now.'],
    ['save_brand_settings', { brand_name: 'Acme', hashtags: ['#acme'] }, 'Save brand settings: brand_name, hashtags.'],
  ])('%s %o', (name, args, expected) => {
    expect(summaryOf(tool(name), admin, args)).toBe(expected);
  });
});
