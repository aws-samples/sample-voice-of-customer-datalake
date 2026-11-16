/**
 * `save_categories` (`core` pack, administrators; docs/categories.md "Proposed by the assistant"): the categories the
 * assistant proposes for what is being reviewed (the categories-first rule, guidance.ts), saved only through its
 * approval card. The card shows them editable (labels, products, subcategories added or removed, a category left
 * out), and its Approve ADDS them to the current workspace's categories (the deployment's outside a workspace) with
 * `PUT /settings/categories`: a category already configured is never changed or removed, and the executor refuses
 * when the stored categories changed since the card showed them.
 *
 * A CARD_ONLY_WRITE_TOOLS entry (plan/schema.ts): the person edits the set on the card, so a plan never names it.
 * The precheck reads the categories as the caller and refuses a proposed category whose name is configured already.
 */
import type { ClientToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { readCategoryConfig } from '../server/category-access.js';
import { defineClientTool, q } from './define.js';
import { CATEGORY_PROPOSAL_LIMITS as L, categorySlug, saveCategoriesArgsSchema } from './category-schemas.js';

const labelProperty = (description: string) => ({ type: 'string', maxLength: L.maxLabelChars, description });
/** "1 category", "3 categories". */
const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function saveCategories(deps: ToolDeps): ClientToolDefinition {
  return defineClientTool({
    name: 'save_categories',
    pack: 'core',
    description: 'Add feedback categories (admin): the set the user agreed on for what they review, each with its '
      + `label (1-${L.maxLabelChars} characters, no "#"; it is what every screen shows, and its stored name is the `
      + 'label lower-cased with "_" for spaces), the product or area it belongs to (optional) and the labels of its '
      + `subcategories (up to ${L.maxSubcategories}). At most ${L.maxCategories} categories, each name once. They are `
      + 'ADDED to the categories already configured (read list_categories first): one configured already is never '
      + 'changed, so leave it out. The approval card lets the user edit the set before approving; after "executed", '
      + 'call list_categories again: the result names what was saved.',
    properties: {
      categories: {
        type: 'array',
        minItems: 1,
        maxItems: L.maxCategories,
        description: 'The new categories.',
        items: {
          type: 'object',
          properties: {
            label: labelProperty('The category as people read it, e.g. "Delivery".'),
            product: { type: 'string', maxLength: L.maxProductChars, description: 'The product or area it belongs to.' },
            subcategories: {
              type: 'array', maxItems: L.maxSubcategories, items: labelProperty('A subcategory, e.g. "Late delivery".'),
              description: 'Its subcategories’ labels.',
            },
          },
          required: ['label', 'subcategories'],
          additionalProperties: false,
        },
      },
    },
    required: ['categories'],
    schema: saveCategoriesArgsSchema,
    precheck: async (args, ctx) => {
      const configured = new Set((await readCategoryConfig(deps, ctx)).map((entry) => entry.name.toLowerCase()));
      const taken = args.categories.map((category) => categorySlug(category.label)).filter((name) => configured.has(name));
      return taken.length === 0 ? undefined
        : `categories ${taken.map((name) => q(name)).join(', ')} are configured already: save_categories only adds new `
          + 'ones, so leave them out (they are kept as they are). Read list_categories and propose the others.';
    },
    summarize: (args) => `Add ${counted(args.categories.length, 'category', 'categories')}: ${args.categories
      .map((category) => `${category.label} (${counted(category.subcategories.length, 'subcategory', 'subcategories')})`)
      .join(', ')}.`,
  });
}

export function createCategoriesClientTools(deps: ToolDeps): ClientToolDefinition[] {
  return [saveCategories(deps)];
}
