/**
 * @fileoverview REST executors of the connector write tools, through the
 * existing API clients (`fetchApi` → the user's own Cognito token; the routes
 * are admin-only). Each one re-reads the current state right before it writes:
 * - `create_scraper` refuses an id that exists now (a create never overwrites);
 * - `update_scraper` refuses when the stored scraper differs from the one the
 *   card diffed against (fingerprint on the shown record), then saves the merge;
 * - `create_app_connector` refuses an app that is already configured.
 * The refusal sentences are our own (StaleApprovalError) and reach the model.
 *
 * @module assistant/approvals/scraperExecutors
 */
import { api } from '../../api/client'
import { scrapersApi } from '../../api/scrapersApi'
import { invalidateKeys, keysFor } from './invalidation'
import { StaleApprovalError, shownOf } from './shown'
import {
  APP_ID_FIELD, appConnectorRecord, createdScraperRecord, mergedScraperRecord, scraperFingerprint, scraperRecordProblem,
} from './scraperSchemas'
import type { ScraperConfig } from '../../api/types'
import type { WriteToolExecutionContext } from '../types'
import type { CreateAppConnectorArgs, CreateScraperArgs, UpdateScraperArgs } from './scraperSchemas'

const scraperExistsMessage = (id: string) =>
  `A scraper with id "${id}" already exists; nothing was saved. A create never overwrites — propose update_scraper, or a different id.`
export const SCRAPER_CHANGED_MESSAGE = 'The scraper changed since this approval was shown (or its current version was never shown); '
  + 'nothing was saved. Read it again with list_scrapers and propose the change again.'
const scraperMissingMessage = (id: string) => `No scraper has id "${id}" any more; nothing was saved.`
const appExistsMessage = (name: string) =>
  `An app connector for "${name}" is already configured; nothing was saved.`

/** The stored scraper `id`, read fresh (normalised like the Scrapers page reads it). */
export async function fetchScraper(id: string): Promise<ScraperConfig | undefined> {
  const { scrapers } = await scrapersApi.getScrapers()
  return scrapers.find((scraper) => scraper.id === id)
}

function refused(problem: string | null): void {
  if (problem !== null) throw new StaleApprovalError(`${problem} Nothing was saved.`)
}

export async function createScraper(args: CreateScraperArgs, ctx: WriteToolExecutionContext) {
  const record = createdScraperRecord(args)
  refused(scraperRecordProblem(record))
  if (await fetchScraper(args.id) !== undefined) throw new StaleApprovalError(scraperExistsMessage(args.id))
  await scrapersApi.saveScraper(record)
  void invalidateKeys(ctx.queryClient, keysFor.scrapers())
  const schedule = record.enabled && record.frequency_minutes > 0 ? `every ${String(record.frequency_minutes)} minutes` : 'not scheduled'
  return {
    summary: `Created web scraper "${record.name}" (${record.id}), ${record.enabled ? 'enabled' : 'disabled'}, ${schedule}. `
      + 'It has not run yet; run_scraper starts a run.',
    data: { scraper_id: record.id },
  }
}

export async function updateScraper(args: UpdateScraperArgs, ctx: WriteToolExecutionContext) {
  const shownBase = shownOf(ctx)?.scraperBase
  const current = await fetchScraper(args.scraper_id)
  if (current === undefined) throw new StaleApprovalError(scraperMissingMessage(args.scraper_id))
  if (shownBase === undefined || shownBase !== scraperFingerprint(current)) throw new StaleApprovalError(SCRAPER_CHANGED_MESSAGE)
  const merged = mergedScraperRecord(current, args.updates)
  refused(scraperRecordProblem(merged))
  await scrapersApi.saveScraper(merged)
  void invalidateKeys(ctx.queryClient, keysFor.scrapers())
  return {
    summary: `Updated web scraper ${args.scraper_id} (${Object.keys(args.updates).join(', ')}).`,
    data: { scraper_id: args.scraper_id },
  }
}

const sameText = (a: string | undefined, b: string | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/** How much of a web review page a run reads, for the tool summary. */
function webReach(record: Record<string, string>): string {
  const pages = record.max_pages === '0' ? 'all pages' : `the latest ${record.max_pages ?? ''} pages`
  return record.max_reviews === undefined || record.max_reviews === '0' ? pages : `${pages}, up to ${record.max_reviews} reviews`
}

export async function createAppConnector(args: CreateAppConnectorArgs, ctx: WriteToolExecutionContext) {
  const record = appConnectorRecord(args)
  const idField = APP_ID_FIELD[args.source]
  const { apps } = await api.getAppConfigs(args.source)
  const duplicate = apps.some((app) => sameText(app.app_name, record.app_name) || sameText(app[idField], record[idField]))
  if (duplicate) throw new StaleApprovalError(appExistsMessage(record.app_name ?? ''))
  const res = await api.saveAppConfig(args.source, record)
  void invalidateKeys(ctx.queryClient, keysFor.appConfigs(args.source))
  const cadence = record.frequency_minutes === '0' ? 'on manual runs only' : `every ${record.frequency_minutes ?? ''} minutes`
  const web = args.source === 'web_reviews'
  const reads = web ? `reads reviews from that page (${webReach(record)})` : 'collects reviews'
  // A web_reviews target's source label, minted by the route (absent for the app-review connectors).
  const sourceId = res.app.source_id
  return {
    summary: `Added ${web ? 'web reviews' : 'app'} connector "${record.app_name ?? ''}" (${args.source}, ${record[idField] ?? ''}); `
      + `it ${reads} ${cadence}.`,
    data: { source: args.source, app_id: res.app.id, ...(sourceId === undefined ? {} : { source_id: sourceId }) },
  }
}
