/**
 * Whether the caller's category access is restricted, read before the first model turn so the
 * dynamic system prompt can say so (owner rule 2026-10-21: a restricted user never hears another
 * category's name or count — prod 5.17.01 the assistant told a Technical Support-only viewer the
 * workspace "is set up with eight categories, such as Hardware Quality").
 *
 * The scope itself is resolved by the metrics Lambda (`GET /feedback/access`, as the caller) through
 * `readCategoryScope`, whose per-run cache the tools then reuse, so this costs no extra call when a
 * tool reads feedback. Admins are never restricted and skip the read.
 *
 * Fails OPEN to "not restricted" (no prompt line): every tool that reads feedback or categories
 * fails CLOSED on its own when the scope cannot be read, so a missing line never widens what the
 * model can see; it only loses the reminder.
 */
import type { ApiInvoker } from '../tools/internal-api.js';
import { readCategoryScope } from '../tools/server/category-access.js';
import type { AssistantRunContext } from '../types.js';
import { failOpen } from './fail-open.js';

/** True when the caller sees only some categories. */
export type LoadCategoryRestriction = (ctx: AssistantRunContext) => Promise<boolean>;

/** The restriction must not hold up the first token for long. */
const RESTRICTION_TIMEOUT_MS = 2500;

/** The production loader: the run-cached scope read, as the caller. */
export function createCategoryRestrictionLoader(invoke: ApiInvoker): LoadCategoryRestriction {
  return async (ctx) => !(await readCategoryScope({ invoke }, ctx)).categoriesAll;
}

/** This run's restriction; false for an admin, without a loader, or when the read failed or was slow. */
export async function restrictionForRun(
  load: LoadCategoryRestriction | undefined,
  ctx: AssistantRunContext,
  timeoutMs: number = RESTRICTION_TIMEOUT_MS,
): Promise<boolean> {
  if (load === undefined || ctx.isAdmin) return false;
  return failOpen(() => load(ctx), false, timeoutMs, 'Category restriction unknown');
}
