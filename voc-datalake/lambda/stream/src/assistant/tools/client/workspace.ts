/**
 * Client (write) tools outside the project pack: core, insights, forms,
 * scrapers and settings.
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { idProperty, idSchema } from '../spec.js';
import { feedbackFormUpdatesSchema } from './allowlists.js';
import { defineClientTool, q, stringProperty } from './define.js';

const MAX_BRAND_LIST_ITEMS = 50;
/** Item limits match the SPA's approval boundary (narrower of the two sides). */
const brandList = (itemMax: number) => z.array(z.string().trim().min(1).max(itemMax)).max(MAX_BRAND_LIST_ITEMS);
const brandListProperty = (description: string, itemMax: number) => ({
  type: 'array', items: { type: 'string', maxLength: itemMax }, maxItems: MAX_BRAND_LIST_ITEMS, description,
});

const createProject = defineClientTool({
  name: 'create_project',
  pack: 'core',
  description: 'Create a new research project, e.g. to turn the feedback findings of this conversation into a project.',
  properties: {
    name: stringProperty('Short project name.', 200),
    description: stringProperty('One-paragraph goal/scope, grounded in the feedback discussed.', 2000),
  },
  required: ['name'],
  schema: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
  }).strict(),
  summarize: (args) => `Create project ${q(args.name)}.`,
});

const setProblemResolved = defineClientTool({
  name: 'set_problem_resolved',
  pack: 'insights',
  description: 'Mark a Problem Analysis problem as resolved (or reopen it). Use the exact problem_key returned by '
    + 'get_resolved_problems or shown on the Problems page.',
  properties: {
    problem_key: stringProperty('The problem key.', 300),
    resolved: { type: 'boolean', description: 'true = resolved, false = reopen.' },
  },
  required: ['problem_key', 'resolved'],
  schema: z.object({ problem_key: z.string().trim().min(1).max(300), resolved: z.boolean() }).strict(),
  summarize: (args) => `${args.resolved ? 'Mark as resolved' : 'Reopen'} problem ${q(args.problem_key, 120)}.`,
});

/** Category / subcategory names: the snake_case ids of the category config. */
const MAX_CATEGORY_NAME = 64;
const categoryName = z.string().trim().min(1).max(MAX_CATEGORY_NAME);

const setFeedbackCategory = defineClientTool({
  name: 'set_feedback_category',
  pack: 'insights',
  description: 'Correct the category (and optionally subcategory) of one feedback item — e.g. when the user says '
    + 'a review was misclassified. Use a category name from list_categories; feedback_id defaults to the item on '
    + 'screen. The change is recorded as a manual correction (who and when), which a category reprocess leaves '
    + 'alone unless an administrator chooses to include manual corrections.',
  properties: {
    feedback_id: idProperty('Feedback id; omit to use the item on screen.'),
    category: stringProperty('The new category name (from list_categories).', MAX_CATEGORY_NAME),
    subcategory: stringProperty('The new subcategory name, if the category has subcategories.', MAX_CATEGORY_NAME),
  },
  required: ['feedback_id', 'category'],
  feedbackScoped: true,
  schema: z.object({
    feedback_id: idSchema,
    category: categoryName,
    subcategory: categoryName.optional(),
  }).strict(),
  summarize: (args) => {
    const subcategory = args.subcategory === undefined ? '' : ` / ${q(args.subcategory, MAX_CATEGORY_NAME)}`;
    return `Change the category of feedback ${args.feedback_id} to ${q(args.category, MAX_CATEGORY_NAME)}${subcategory}.`;
  },
});

const updateFeedbackForm = defineClientTool({
  name: 'update_feedback_form',
  pack: 'forms',
  description: 'Change settings of an embeddable feedback form. Allowed keys in `updates`: enabled, name, title, '
    + 'description, question, placeholder, submit_button_text, success_message, rating_enabled, rating_type '
    + '(stars|numeric|emoji), collect_email, collect_name. Enabling a form makes it accept public submissions.',
  properties: {
    form_id: idProperty('Feedback form id.'),
    updates: { type: 'object', description: 'Settings to change (see the allowed keys).' },
  },
  required: ['form_id', 'updates'],
  schema: z.object({ form_id: idSchema, updates: feedbackFormUpdatesSchema }).strict(),
  summarize: (args) => `Update feedback form ${args.form_id}: ${Object.keys(args.updates).join(', ')}.`,
});

const runScraper = defineClientTool({
  name: 'run_scraper',
  pack: 'scrapers',
  description: 'Run a configured web scraper now (admin). New feedback is ingested in the background.',
  properties: { scraper_id: idProperty('Scraper id from list_scrapers.') },
  required: ['scraper_id'],
  schema: z.object({ scraper_id: idSchema }).strict(),
  summarize: (args) => `Run scraper ${args.scraper_id} now.`,
});

const saveBrandSettings = defineClientTool({
  name: 'save_brand_settings',
  pack: 'settings',
  description: 'Change the brand settings (admin). Only the fields you send change; lists you send REPLACE the '
    + 'stored list, so read get_brand_settings first and send the complete list.',
  properties: {
    brand_name: stringProperty('Brand name.', 200),
    brand_handles: brandListProperty('Social handles.', 100),
    hashtags: brandListProperty('Hashtags.', 100),
    urls_to_track: brandListProperty('URLs to track.', 200),
  },
  required: [],
  schema: z.object({
    brand_name: z.string().trim().min(1).max(200).optional(),
    brand_handles: brandList(100).optional(),
    hashtags: brandList(100).optional(),
    urls_to_track: brandList(200).optional(),
  }).strict().refine((args) => Object.keys(args).length > 0, 'change at least one field'),
  summarize: (args) => `Save brand settings: ${Object.keys(args).join(', ')}.`,
});

export function createWorkspaceClientTools(): ClientToolDefinition[] {
  return [createProject, setProblemResolved, setFeedbackCategory, updateFeedbackForm, runScraper, saveBrandSettings];
}
