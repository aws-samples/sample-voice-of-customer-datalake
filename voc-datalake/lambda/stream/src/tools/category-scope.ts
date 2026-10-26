/**
 * Which feedback the caller may read — the stream-side mirror of
 * `lambda/shared/category_access.py::CategoryScope` / `admits_item`.
 *
 * An item is visible iff the CATEGORY rule admits its `category` AND the SOURCE
 * rule admits its `source_platform`. The policy itself is resolved by the metrics
 * Lambda (`GET /feedback/access`); this module only applies the resolved scope to
 * rows the stream reads directly from DynamoDB. There is deliberately no
 * "default" scope: every caller of `executeSearchFeedback` must pass one, so a
 * new call site cannot silently read every row.
 */
import { z } from 'zod';

/**
 * The source rule: `all` hides nothing, `allow` admits exactly `sources`, `deny`
 * admits everything except `sourcesDenied`, and `none` admits nothing (the
 * fail-closed reading of a restricted scope whose rule is missing or unknown).
 */
type SourceRule = 'all' | 'allow' | 'deny' | 'none';

export interface CategoryScope {
  /** True only when NEITHER rule hides anything (admins, users without a restriction). */
  all: boolean;
  /** True when the category rule hides nothing. */
  categoriesAll: boolean;
  /** The admitted category names when `categoriesAll` is false. */
  categories: ReadonlySet<string>;
  sourceRule: SourceRule;
  /** The explicit source grants (`allow`). */
  sources: ReadonlySet<string>;
  /** The hidden restricted sources (`deny`). */
  sourcesDenied: ReadonlySet<string>;
}

const sourceIds = z.array(z.string()).max(1000);

/**
 * Wire shape of `GET /feedback/access`. `sources_all` is required: a body that
 * does not say whether a source is hidden fails to parse, and the tool fails closed.
 */
export const categoryScopeResponseSchema = z.object({
  all: z.boolean(),
  categories: z.array(z.string()).max(1000),
  sources_all: z.boolean(),
  sources: sourceIds.catch([]),
  source_rule: z.unknown().optional(),
  // Checked in `sourceRuleOf`: a `deny` rule whose list is malformed must not read as "deny nothing".
  sources_denied: z.unknown().optional(),
}).loose();

function sourceRuleOf(body: z.infer<typeof categoryScopeResponseSchema>): SourceRule {
  if (body.sources_all) return 'all';
  // A restricted source rule we cannot name (or a deny rule without its list) admits nothing.
  if (body.source_rule === 'allow') return 'allow';
  return body.source_rule === 'deny' && sourceIds.safeParse(body.sources_denied).success ? 'deny' : 'none';
}

export function toCategoryScope(body: z.infer<typeof categoryScopeResponseSchema>): CategoryScope {
  const sourceRule = sourceRuleOf(body);
  return {
    all: body.all && sourceRule === 'all',
    categoriesAll: body.all,
    categories: new Set(body.categories),
    sourceRule,
    sources: new Set(body.sources),
    sourcesDenied: new Set(sourceRule === 'deny' ? sourceIds.parse(body.sources_denied) : []),
  };
}

/**
 * Whether an item in `category` passes the CATEGORY rule. A restricted caller
 * never sees an item without a category (legacy / unclassified rows): that is
 * hidden, like any category outside the scope, because there is nothing to admit it by.
 */
export function admitsCategory(scope: CategoryScope, category: string | undefined): boolean {
  if (scope.categoriesAll) return true;
  if (!category) return false;
  return scope.categories.has(category);
}

/** Whether an item from `source` (its `source_platform`) passes the SOURCE rule. */
function admitsSource(scope: CategoryScope, source: string | undefined): boolean {
  const name = source ?? '';
  switch (scope.sourceRule) {
    case 'all': return true;
    case 'allow': return scope.sources.has(name);
    case 'deny': return !scope.sourcesDenied.has(name);
    case 'none': return false;
  }
}

/** Both rules: the one check every list, aggregate and by-id path applies. */
export function admitsItem(
  scope: CategoryScope,
  item: { category?: string; source_platform?: string },
): boolean {
  return admitsCategory(scope, item.category) && admitsSource(scope, item.source_platform);
}
