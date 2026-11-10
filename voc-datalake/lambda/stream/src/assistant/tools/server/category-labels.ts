/**
 * Display labels next to category / subcategory ids in tool results (prod 5.14: the assistant
 * wrote "software_firmware" and "ease_of_use" to users because every result it read carried
 * only ids).
 *
 * `readCategoryLabeller` reads the category configuration once per run, as the caller; when it
 * cannot be read the labels fall back to the humanised ids (a label is presentation, never a
 * reason to fail a read). `withCategoryLabels` adds `category_label` / `subcategory_label` beside
 * every `category` / `subcategory` string in a result, leaving the ids for filters.
 */
import { z } from 'zod';
import { categoryLabeller, type CategoryLabeller, type LabelSource } from '../../../tools/display-labels.js';
import type { AssistantRunContext } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { isRecord } from '../../../lib/is-record.js';
import { readCategoryConfig, type CategoryEntry } from './category-access.js';

const subSchema = z.object({
  name: z.string().min(1),
  description: z.unknown().optional().transform((value) => (typeof value === 'string' ? value : undefined)),
}).loose();

/** Deepest nesting walked (radar compare / themes sit at depth ≤ 4). */
const MAX_DEPTH = 6;

function toLabelSource(entry: CategoryEntry): LabelSource {
  const subcategories = entry.subcategories.flatMap((raw) => {
    const sub = subSchema.safeParse(raw);
    return sub.success ? [{ name: sub.data.name, description: sub.data.description }] : [];
  });
  return { name: entry.name, description: entry.description, subcategories };
}

const labellerByRun = new WeakMap<AssistantRunContext, Promise<CategoryLabeller>>();

async function fetchLabeller(deps: ToolDeps, ctx: AssistantRunContext): Promise<CategoryLabeller> {
  try {
    return categoryLabeller((await readCategoryConfig(deps, ctx)).map(toLabelSource));
  } catch (err: unknown) {
    console.warn(`category-labels: config read failed, humanising ids: ${err instanceof Error ? err.name : 'unknown'}`);
    return categoryLabeller();
  }
}

/** The run's labeller (one config read per run; never rejects). */
export function readCategoryLabeller(deps: ToolDeps, ctx: AssistantRunContext): Promise<CategoryLabeller> {
  const cached = labellerByRun.get(ctx);
  if (cached) return cached;
  const pending = fetchLabeller(deps, ctx);
  labellerByRun.set(ctx, pending);
  return pending;
}

function labelRecord(record: Record<string, unknown>, labels: CategoryLabeller, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = withCategoryLabels(value, labels, depth + 1);
    if (key === 'category' && typeof value === 'string' && value !== '' && !('category_label' in record)) {
      out.category_label = labels.category(value);
    }
    if (key === 'subcategory' && typeof value === 'string' && value !== '' && !('subcategory_label' in record)) {
      out.subcategory_label = labels.subcategory(value, typeof record.category === 'string' ? record.category : undefined);
    }
  }
  return out;
}

/** `value` with a label beside every category / subcategory id it holds (a copy; ids untouched). */
function withCategoryLabels(value: unknown, labels: CategoryLabeller, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => withCategoryLabels(entry, labels, depth + 1));
  return isRecord(value) ? labelRecord(value, labels, depth) : value;
}

/** `{id: label}` for the keys of a `{category id: count}` breakdown (get_metrics categories). */
export function breakdownLabels(breakdown: unknown, labels: CategoryLabeller): Record<string, string> | undefined {
  if (!isRecord(breakdown)) return undefined;
  return Object.fromEntries(Object.keys(breakdown).map((id) => [id, labels.category(id)]));
}

function hasCategoryId(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.some((entry) => hasCategoryId(entry, depth + 1));
  if (!isRecord(value)) return false;
  return typeof value.category === 'string' || Object.values(value).some((entry) => hasCategoryId(entry, depth + 1));
}

/** `value` labelled; the category configuration is read only when it holds a category id. */
export async function labelResult(deps: ToolDeps, ctx: AssistantRunContext, value: unknown): Promise<unknown> {
  return hasCategoryId(value) ? withCategoryLabels(value, await readCategoryLabeller(deps, ctx)) : value;
}
