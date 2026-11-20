/**
 * @fileoverview GET /radar/brands for the Scrapers page: the brands a Radar source may name
 * (the same cache entry Administration → Sources → Radar writes after a save).
 * @module pages/Scrapers/useRadarBrands
 */
import { useQuery } from '@tanstack/react-query'
import { radarApi, radarKeys } from '../../api/radarApi'

export function useRadarBrands() {
  return useQuery({ queryKey: radarKeys.brands(), queryFn: () => radarApi.getBrands() })
}

/**
 * A lookup from a Radar brand key to its label (the key itself until the list loads, or when the
 * brand is not in it); undefined for no key (`''` / undefined = an ordinary source).
 */
export function useRadarBrandLabeler(): (key: string | undefined) => string | undefined {
  const { data } = useRadarBrands()
  return (key) => (key === undefined || key === ''
    ? undefined
    : data?.find((brand) => brand.key === key)?.label ?? key)
}

/** The label of Radar brand `key` (see {@link useRadarBrandLabeler}). */
export function useRadarBrandLabel(key: string): string | undefined {
  return useRadarBrandLabeler()(key)
}
