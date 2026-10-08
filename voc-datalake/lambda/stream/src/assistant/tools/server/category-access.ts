/**
 * The caller's category scope, read from the metrics Lambda (`GET /feedback/access`)
 * as the CALLER — the Python policy (`lambda/shared/category_access.py`) is the
 * only place it is resolved; the stream only applies it to the rows it reads
 * from DynamoDB directly (search_feedback) and to the category list it shows.
 *
 * Fails CLOSED: when the scope cannot be read or does not parse, the tool fails
 * rather than falling back to "all categories". Read at most once per run.
 */
import { z } from 'zod';
import {
  admitsCategory,
  categoryScopeResponseSchema,
  toCategoryScope,
  type CategoryScope,
} from '../../../tools/category-scope.js';
import type { AssistantRunContext } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { pick } from '../format.js';

const SCOPE_UNAVAILABLE = 'The signed-in user\u2019s category access could not be read, so feedback and categories '
  + 'cannot be shown right now. Say so; do not guess at the data.';

/** One read per run; a failed read is not cached, so a later tool call retries. */
const scopeByRun = new WeakMap<AssistantRunContext, Promise<CategoryScope>>();

async function fetchCategoryScope(deps: ToolDeps, ctx: AssistantRunContext): Promise<CategoryScope> {
  const body = await deps.invoke({
    fn: 'metrics',
    method: 'GET',
    path: '/feedback/access',
    resource: '/feedback/access',
  }, ctx.claims).catch((err: unknown) => {
    console.warn(`category-access: scope read failed: ${err instanceof Error ? err.name : 'unknown'}`);
    throw new AssistantToolError('unavailable', SCOPE_UNAVAILABLE);
  });
  const parsed = categoryScopeResponseSchema.safeParse(body);
  if (!parsed.success) {
    console.warn('category-access: scope response did not parse');
    throw new AssistantToolError('unavailable', SCOPE_UNAVAILABLE);
  }
  return toCategoryScope(parsed.data);
}

export function readCategoryScope(deps: ToolDeps, ctx: AssistantRunContext): Promise<CategoryScope> {
  const cached = scopeByRun.get(ctx);
  if (cached) return cached;
  const pending = fetchCategoryScope(deps, ctx);
  scopeByRun.set(ctx, pending);
  pending.catch(() => scopeByRun.delete(ctx));
  return pending;
}

// ── Visible categories (list_categories) ──

/** `GET /settings/categories`; the handler answers 200 with `error` when its read failed. */
const categoriesConfigSchema = z.object({
  categories: z.array(z.unknown()).catch([]),
  error: z.unknown().optional(),
}).loose();

/** A string field that degrades to absent when a legacy row stored something else. */
const lenientText = z.unknown().transform((value) => (typeof value === 'string' ? value : undefined));

const subcategoryEntrySchema = z.object({ name: z.string().min(1), description: lenientText }).loose();

const categoryEntrySchema = z.object({
  name: z.string().min(1),
  description: lenientText,
  product: lenientText,
  subcategories: z.array(z.unknown()).catch([]),
}).loose();

type CategoryEntry = z.infer<typeof categoryEntrySchema>;

const MAX_LISTED_SUBCATEGORIES = 30;

/** The model-facing view of one category. Owners are left out: people's details stay out of the prompt. */
function summarizeCategory(entry: CategoryEntry): Record<string, unknown> {
  const subcategories = entry.subcategories
    .flatMap((raw) => {
      const sub = subcategoryEntrySchema.safeParse(raw);
      return sub.success ? [pick(sub.data, ['name', 'description'], 200)] : [];
    })
    .slice(0, MAX_LISTED_SUBCATEGORIES);
  return {
    ...pick(entry, ['name', 'description', 'product'], 300),
    ...(subcategories.length > 0 ? { subcategories } : {}),
  };
}

function parseCategoryEntries(body: unknown): CategoryEntry[] {
  const parsed = categoriesConfigSchema.safeParse(body);
  // A failed read is unknown, not "no categories".
  if (!parsed.success || parsed.data.error !== undefined) {
    throw new AssistantToolError('unavailable', 'The category configuration could not be read. Try again later.');
  }
  return parsed.data.categories.flatMap((raw) => {
    const entry = categoryEntrySchema.safeParse(raw);
    return entry.success ? [entry.data] : [];
  });
}

/** The configured categories the caller may see, summarised for the model. */
export async function readVisibleCategories(
  deps: ToolDeps,
  ctx: AssistantRunContext,
): Promise<{ restricted: boolean; categories: Record<string, unknown>[] }> {
  const [scope, body] = await Promise.all([
    readCategoryScope(deps, ctx),
    deps.invoke({
      fn: 'settings',
      method: 'GET',
      path: '/settings/categories',
      resource: '/settings/{proxy+}',
      pathParameters: { proxy: 'categories' },
    }, ctx.claims),
  ]);
  const categories = parseCategoryEntries(body)
    .filter((entry) => admitsCategory(scope, entry.name))
    .map(summarizeCategory);
  // Listing categories is about the CATEGORY rule only; a source restriction hides no category.
  return { restricted: !scope.categoriesAll, categories };
}
