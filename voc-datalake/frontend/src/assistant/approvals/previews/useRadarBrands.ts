/**
 * @fileoverview GET /radar/brands for the approval cards (docs/radar.md): the
 * brand-list diff of `save_radar_brands`, the scan card, and the "Radar
 * source" row of the connector cards.
 *
 * @module assistant/approvals/previews/useRadarBrands
 */
import { useQuery } from '@tanstack/react-query'
import { fetchRadarBrands } from '../radarExecutors'

/** Read fresh for the card (a card-local key, never the Radar page's cache). */
export function useRadarBrandsPreview() {
  return useQuery({ queryKey: ['assistant', 'radar-brands-preview'], queryFn: fetchRadarBrands, retry: false, staleTime: 0 })
}

/** Brand key → label. */
export function useRadarBrandLabels(): ReadonlyMap<string, string> {
  const { data } = useRadarBrandsPreview()
  return new Map((data ?? []).map((entry) => [entry.key, entry.label]))
}
