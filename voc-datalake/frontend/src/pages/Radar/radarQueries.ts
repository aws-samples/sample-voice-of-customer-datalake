/**
 * @fileoverview The Radar page's view reads, shared by each view and the page's early start
 * (useEarlyReads) so both use ONE cache entry.
 * @module pages/Radar/radarQueries
 */
import { radarApi, radarKeys } from '../../api/radarApi'

/** The `?brand=` value of the "All brands" view (offered with at least two brands). */
export const ALL_BRANDS = 'all'

/** One brand's page read (detail, releases, compare). */
export const brandPageQuery = (brand: string, days: number) => ({
  queryKey: radarKeys.page(brand, days), queryFn: () => radarApi.getPage(brand, days),
})

/** Every brand side by side and their combined releases (GET /radar/all). */
export const allBrandsQuery = (days: number) => ({
  queryKey: radarKeys.all(days), queryFn: () => radarApi.getAll(days),
})
