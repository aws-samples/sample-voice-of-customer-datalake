/**
 * Argument schema of `save_categories` (`core` pack, administrators; docs/categories.md "Proposed by the assistant"):
 * the categories the assistant proposes for what is being reviewed, each with its label, the product or area it
 * belongs to and its subcategories' labels. The approval card lets the person edit them before Approve, and its
 * executor adds them to the current workspace's categories (`PUT /settings/categories`) as the categories editor makes
 * them: the label is the description every screen shows, and the stored name is the label's slug.
 *
 * Bounds: at most 10 categories with at most 5 subcategories each (the categories-first rule proposes 6-10 with 3-5,
 * guidance.ts; fewer stay valid, so a person may remove some on the card), labels of 1-64 characters without "#" and
 * not "*" (the stored name's rule, `lambda/shared/category_config.py` `_NAME_RE` and the access rows' wildcard), a
 * product of at most 120 characters (`MAX_PRODUCT_CHARS`), and no two categories (or two subcategories of one) with
 * the same name. The route re-validates everything.
 *
 * The SPA's approval boundary (`frontend/src/assistant/approvals/categorySchemas.ts`) imports this module through
 * `@stream`; browser-safe: zod only. `categories.test.ts` pins the bounds against the Python module.
 */
import { z } from 'zod';

export const CATEGORY_PROPOSAL_LIMITS = {
  maxCategories: 10, maxSubcategories: 5, maxLabelChars: 64, maxProductChars: 120,
} as const;
/** A raw label or product is capped before its whitespace is folded; the folded text is then held to its bound. */
const MAX_TEXT_INPUT = 200;
/** shared/category_access.py WILDCARD: the access rows' "every category", never a category's name. */
const WILDCARD = '*';

/** A label with its whitespace folded (trimmed, each run one space), as the card shows and saves it. */
export function foldedLabel(raw: string): string {
  return raw.trim().split(/\s+/u).filter((part) => part !== '').join(' ');
}

/**
 * The stored name of a label, as the categories editor makes it (CategoriesManager `toSlug` of the trimmed label):
 * lower-cased, each run of whitespace one "_".
 */
export function categorySlug(label: string): string {
  return label.trim().toLowerCase().replaceAll(/\s+/gu, '_');
}

/**
 * Whether a folded label makes a stored name the route takes: 1-64 characters, no "#", not the wildcard (its slug
 * counted in code points too, as Python counts it: lower-casing may lengthen a letter).
 */
export function isCategoryLabel(label: string): boolean {
  const { maxLabelChars } = CATEGORY_PROPOSAL_LIMITS;
  return label.length > 0 && label.length <= maxLabelChars && Array.from(categorySlug(label)).length <= maxLabelChars
    && !label.includes('#') && label !== WILDCARD;
}

const LABEL_RULE = `1-${CATEGORY_PROPOSAL_LIMITS.maxLabelChars} characters, no "#"`;

const labelSchema = z.string().max(MAX_TEXT_INPUT).transform(foldedLabel)
  .pipe(z.string().refine(isCategoryLabel, LABEL_RULE));

/** An optional product: folded, at most 120 characters; a blank one is no product (the category leaves it out). */
const productSchema = z.string().max(MAX_TEXT_INPUT).transform(foldedLabel)
  .pipe(z.string().max(CATEGORY_PROPOSAL_LIMITS.maxProductChars)).optional();

/** The indexes of the entries whose slug an earlier entry already has. */
export function repeatedSlugs(labels: readonly string[]): number[] {
  const slugs = labels.map(categorySlug);
  return slugs.flatMap((slug, index) => (slugs.indexOf(slug) === index ? [] : [index]));
}

const categoryProposalSchema = z.strictObject({
  label: labelSchema,
  product: productSchema,
  subcategories: z.array(labelSchema).max(CATEGORY_PROPOSAL_LIMITS.maxSubcategories),
}).check((ctx) => {
  ctx.issues.push(...repeatedSlugs(ctx.value.subcategories).map((index) => ({
    code: 'custom' as const, path: ['subcategories', index], input: ctx.value,
    message: `two subcategories are both "${categorySlug(ctx.value.subcategories[index] ?? '')}"`,
  })));
}).transform(({ product, ...category }) => (product === undefined || product === '' ? category : { ...category, product }));

export const saveCategoriesArgsSchema = z.strictObject({
  categories: z.array(categoryProposalSchema).min(1).max(CATEGORY_PROPOSAL_LIMITS.maxCategories),
}).check((ctx) => {
  ctx.issues.push(...repeatedSlugs(ctx.value.categories.map((category) => category.label)).map((index) => ({
    code: 'custom' as const, path: ['categories', index, 'label'], input: ctx.value,
    message: `two categories are both "${categorySlug(ctx.value.categories[index]?.label ?? '')}"`,
  })));
});
