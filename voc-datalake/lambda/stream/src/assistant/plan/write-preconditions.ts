/**
 * Reads a write needs right before it runs, as the SPA executors do them:
 *
 *   - `create_scraper` refuses an id that exists now (a create never overwrites);
 *   - `update_scraper` merges into the stored scraper, normalised as the SPA reads it
 *     (`storedScraperRecord`; refused when it is gone);
 *   - `create_app_connector` refuses an app that is already configured;
 *   - `update_company_context` / `update_design_system` fill an omitted half
 *     from the stored document (PUT takes the whole document).
 *
 * `preconditionFor` names the GET; `settlePrecondition` turns its answer into
 * the `current` state for `buildWriteRequest`, or a refusal (the step fails with
 * that client-safe sentence; nothing was written).
 */
import type { ApiCall } from '../tools/internal-api.js';
import { APP_ID_FIELD } from '../tools/client/scraper-schemas.js';
import { isRecord } from '../tools/format.js';
import { recordsAt } from '../tools/server/feedback-shape.js';
import { appConnectorSource, storedScraperRecord } from './scraper-records.js';
import { text, type Args } from './write-args.js';

export type PreconditionOutcome = { ok: true; current?: Record<string, unknown> } | { ok: false; refusal: string };

const SCRAPERS_READ: ApiCall = { fn: 'scrapers', method: 'GET', path: '/scrapers', resource: '/scrapers' };

function appsRead(source: string): ApiCall {
  return {
    fn: 'integrations', method: 'GET', path: `/integrations/${source}/apps`, resource: '/integrations/{source}/{proxy+}',
    pathParameters: { source, proxy: 'apps' },
  };
}

const settingsRead = (route: string): ApiCall => ({
  fn: 'settings', method: 'GET', path: `/settings/${route}`, resource: '/settings/{proxy+}', pathParameters: { proxy: route },
});

/** The GET a write needs first, or undefined when it needs none. */
export function preconditionFor(tool: string, args: Args): ApiCall | undefined {
  switch (tool) {
    case 'create_scraper':
    case 'update_scraper':
      return SCRAPERS_READ;
    case 'create_app_connector':
      return appsRead(appConnectorSource(args));
    case 'update_company_context':
      return args.vision === undefined || args.objectives === undefined ? settingsRead('company-context') : undefined;
    case 'update_design_system':
      return args.tokens === undefined || args.guidelines === undefined ? settingsRead('design-system') : undefined;
    default:
      return undefined;
  }
}

const sameText = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

function scraperOutcome(tool: string, args: Args, body: unknown): PreconditionOutcome {
  const id = text(args, tool === 'create_scraper' ? 'id' : 'scraper_id');
  const stored = recordsAt(body, 'scrapers').find((scraper) => scraper.id === id);
  if (tool === 'create_scraper') {
    return stored === undefined ? { ok: true } : { ok: false, refusal: `A scraper with id "${id}" already exists; nothing was saved.` };
  }
  return stored === undefined ? { ok: false, refusal: `No scraper has id "${id}" any more; nothing was saved.` } : { ok: true, current: storedScraperRecord(stored) };
}

function appOutcome(args: Args, body: unknown): PreconditionOutcome {
  const idField = APP_ID_FIELD[appConnectorSource(args)];
  const name = text(args, 'app_name');
  const duplicate = recordsAt(body, 'apps').some((app) => sameText(app.app_name, name) || sameText(app[idField], args[idField]));
  return duplicate ? { ok: false, refusal: `An app connector for "${name}" is already configured; nothing was saved.` } : { ok: true };
}

/** The precondition's verdict on the GET's answer. */
export function settlePrecondition(tool: string, args: Args, body: unknown): PreconditionOutcome {
  if (tool === 'create_scraper' || tool === 'update_scraper') return scraperOutcome(tool, args, body);
  if (tool === 'create_app_connector') return appOutcome(args, body);
  return { ok: true, current: isRecord(body) ? body : {} };
}
