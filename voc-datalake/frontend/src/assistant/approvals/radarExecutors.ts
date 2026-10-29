/**
 * @fileoverview REST executors of the Radar write tools (docs/radar.md),
 * through `radarApi` (the user's own Cognito token; both routes are admin-only):
 * - `save_radar_brands` re-reads GET /radar/brands and refuses when the stored
 *   list differs from the one the card diffed against, then PUTs the whole list;
 * - `run_radar_scan` starts the release scan (POST /radar/scan).
 * The refusal sentences are our own (StaleApprovalError) and reach the model.
 *
 * @module assistant/approvals/radarExecutors
 */
import { radarApi } from '../../api/radarApi'
import { invalidateKeys, keysFor } from './invalidation'
import { StaleApprovalError, shownOf } from './shown'
import { brandKeyOf, radarListFingerprint, savedNewsFields } from './radarSchemas'
import type { RunRadarScanArgs, SaveRadarBrandsArgs } from './radarSchemas'
import type { WriteToolExecutionContext } from '../types'

export const RADAR_BRANDS_CHANGED_MESSAGE = 'The Radar brand list changed since this approval was shown (or was never shown); '
  + 'nothing was saved. Read get_radar view "brands" again and propose the complete list again.'

export async function saveRadarBrands(args: SaveRadarBrandsArgs, ctx: WriteToolExecutionContext) {
  const shownBase = shownOf(ctx)?.radarBrandsBase
  const current = await radarApi.getBrands()
  if (shownBase === undefined || shownBase !== radarListFingerprint(current)) throw new StaleApprovalError(RADAR_BRANDS_CHANGED_MESSAGE)
  // A brand the card names a language, feeds or terms for gets them; otherwise a brand already tracked keeps its own.
  const stored = new Map(current.map((entry) => [entry.key, entry]))
  const saved = await radarApi.saveBrands(args.brands.map((brand) => ({
    label: brand.label, domains: brand.domains ?? [], ...savedNewsFields(brand, stored.get(brandKeyOf(brand.label))),
  })))
  void invalidateKeys(ctx.queryClient, keysFor.radar())
  const brands = args.brands.map((brand) => ({ key: brandKeyOf(brand.label), label: brand.label }))
  const named = brands.map((brand) => `${brand.label} (key ${brand.key})`).join(', ')
  return {
    summary: brands.length === 0
      ? 'Cleared the Radar brand list; stored reviews and releases are kept.'
      : `Saved the Radar brand list: ${named}. Use a key as radar_brand on a scraper or connector.`,
    data: { brands, tracked: saved.map((entry) => entry.key) },
  }
}

export async function runRadarScan(args: RunRadarScanArgs, ctx: WriteToolExecutionContext) {
  await radarApi.startScan(args.brand)
  void invalidateKeys(ctx.queryClient, keysFor.radar())
  const which = args.brand === undefined ? 'every Radar brand' : `Radar brand ${args.brand}`
  return {
    summary: `Started a release scan for ${which}. It runs in the background for a few minutes; get_radar view "releases" lists what it found.`,
    data: { brand: args.brand ?? null, status: 'started' },
  }
}
