/**
 * Plan-mode read tools of the `scrapers` pack:
 *
 *   - `get_source_run` (admin): the status row of a manual or scheduled source
 *     run (`SOURCE_RUN#{source}` / `{execution_id}`, aggregates table). Errors
 *     are redacted to their count plus exception-class-shaped entries, the only
 *     detail an ingestor writes that cannot carry upstream text.
 *   - `find_app_store_app`: candidate store ids for `create_app_connector`.
 *     iOS from Apple's public iTunes Search API; Android from `web_search`
 *     results (package names out of `play.google.com/store/apps/details?id=`
 *     links), only when the user turned web search on for this conversation.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition, WebSourceRef } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { clip, jsonResult } from '../format.js';
import { idSchema, parseToolInput, toolSpec } from '../spec.js';
import { RUN_SOURCE_IDS, isPackageName } from '../client/scraper-schemas.js';
import { serverTool } from './common.js';

const MAX_ERRORS_SHOWN = 5;
const ERROR_CLASS_SHAPE = /^[A-Za-z_]\w{0,99}$/;
const ERROR_WITHHELD = 'error details withheld';

const sourceRunInput = z.object({ source: z.enum(RUN_SOURCE_IDS), execution_id: idSchema.optional() }).strict();

function redactedErrors(errors: unknown): { error_count: number; errors: string[] } {
  const list: unknown[] = Array.isArray(errors) ? errors : [];
  return {
    error_count: list.length,
    errors: list.slice(0, MAX_ERRORS_SHOWN).map((error) => (typeof error === 'string' && ERROR_CLASS_SHAPE.test(error) ? error : ERROR_WITHHELD)),
  };
}

const stringOrUndefined = (value: unknown) => (typeof value === 'string' ? value : undefined);
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** The client-safe view of one run row. */
export function sourceRunView(source: string, row: Record<string, unknown> | undefined): Record<string, unknown> {
  if (row === undefined) return { source, status: 'never_run' };
  return {
    source,
    execution_id: stringOrUndefined(row.sk),
    status: stringOrUndefined(row.status) ?? 'unknown',
    started_at: stringOrUndefined(row.started_at),
    completed_at: stringOrUndefined(row.completed_at),
    items_found: count(row.items_found),
    ...redactedErrors(row.errors),
  };
}

function getSourceRun(deps: ToolDeps): ServerToolDefinition {
  return serverTool('get_source_run', 'scrapers', toolSpec(
    'get_source_run',
    'Administrators: status of a data-source run started by run_source (or its schedule): running, completed or '
      + 'failed, items found, error count. With execution_id that run; without it the newest run of the source.',
    {
      source: { type: 'string', enum: [...RUN_SOURCE_IDS], description: 'The data source.' },
      execution_id: { type: 'string', maxLength: 128, description: 'Execution id returned by run_source.' },
    },
    ['source'],
  ), async (input, ctx) => {
    if (!ctx.isAdmin) throw new AssistantToolError('not_permitted', 'get_source_run is only available to administrators.');
    const args = parseToolInput(sourceRunInput, input);
    const row = await deps.readSourceRun(args.source, args.execution_id);
    if (row === undefined && args.execution_id !== undefined) {
      throw new AssistantToolError('not_found', `No run ${args.execution_id} of ${args.source}.`);
    }
    return { content: jsonResult(sourceRunView(args.source, row)) };
  });
}

// ── find_app_store_app ─────────────────────────────────────────────────────

const MAX_TERM_CHARS = 100;
const PLATFORMS = ['ios', 'android'] as const;
const findAppInput = z.object({
  name: z.string().trim().min(1).max(MAX_TERM_CHARS),
  platforms: z.array(z.enum(PLATFORMS)).min(1).max(2).optional(),
  country: z.string().regex(/^[a-z]{2}$/, 'a two-letter country code').optional(),
}).strict();

interface Candidate {
  platform: (typeof PLATFORMS)[number];
  id: string;
  name: string;
  developer: string;
  url: string;
}

const PLAY_LINK = /play\.google\.com\/store\/apps\/details\?id=([\w.]{3,255})/g;

const MAX_ANDROID_CANDIDATES = 5;
const MAX_LABEL_CHARS = 120;

/** Package names linked from the web results, first appearance order, each with the result that linked it. */
export function androidCandidates(sources: readonly WebSourceRef[], content: string): Candidate[] {
  const found = new Map<string, Candidate>();
  const scan = (haystack: string, title: string) => {
    for (const match of haystack.matchAll(PLAY_LINK)) {
      const id = match[1];
      if (id === undefined || !isPackageName(id) || found.has(id)) continue;
      found.set(id, { platform: 'android', id, name: clip(title, MAX_LABEL_CHARS), developer: '', url: `https://play.google.com/store/apps/details?id=${id}` });
    }
  };
  for (const source of sources) scan(source.url, source.title);
  scan(content, '');
  return [...found.values()].slice(0, MAX_ANDROID_CANDIDATES);
}

async function iosCandidates(deps: ToolDeps, name: string, country: string): Promise<Candidate[]> {
  const apps = await deps.searchAppStore(name, country);
  return apps.map((app) => ({ platform: 'ios', id: app.id, name: clip(app.name, MAX_LABEL_CHARS), developer: clip(app.developer, MAX_LABEL_CHARS), url: app.url }));
}

interface Found {
  candidates: Candidate[];
  note?: string;
}

const NONE: Found = { candidates: [] };

async function android(deps: ToolDeps, name: string, ctx: AssistantRunContext): Promise<Found> {
  if (ctx.props.useWebSearch !== true) {
    return { candidates: [], note: 'Web search is off for this conversation, so Android package names cannot be looked up: ask the user for the package name (com.example.app) or to turn web search on.' };
  }
  const result = await deps.webSearch({ query: `${name} site:play.google.com/store/apps`, max_results: 8 });
  const candidates = androidCandidates(result.webSources, result.content);
  return candidates.length > 0 ? { candidates } : { candidates, note: 'No Google Play link was found; ask the user for the package name.' };
}

function findAppStoreApp(deps: ToolDeps): ServerToolDefinition {
  return serverTool('find_app_store_app', 'scrapers', toolSpec(
    'find_app_store_app',
    'Find an app\u2019s store ids for create_app_connector: the numeric App Store id (iOS) and the Google Play package '
      + 'name (Android, needs web search on). Returns candidates {platform, id, name, developer, url}; pick the one '
      + 'whose developer matches and show the chosen id to the user. Saves nothing.',
    {
      name: { type: 'string', maxLength: MAX_TERM_CHARS, description: 'App or company name, e.g. "Example Air".' },
      platforms: { type: 'array', items: { type: 'string', enum: [...PLATFORMS] }, maxItems: 2, description: 'Default both.' },
      country: { type: 'string', maxLength: 2, description: 'Two-letter App Store country code (default us).' },
    },
    ['name'],
  ), async (input, ctx) => {
    const args = parseToolInput(findAppInput, input);
    const platforms = args.platforms ?? PLATFORMS;
    const [ios, droid] = await Promise.all([
      platforms.includes('ios') ? iosCandidates(deps, args.name, args.country ?? 'us') : Promise.resolve([]),
      platforms.includes('android') ? android(deps, args.name, ctx) : Promise.resolve(NONE),
    ]);
    const notes = droid.note === undefined ? {} : { note: droid.note };
    return { content: jsonResult({ candidates: [...ios, ...droid.candidates], ...notes }) };
  });
}

export function createSourceServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [getSourceRun(deps), findAppStoreApp(deps)];
}
