/**
 * @fileoverview GET /radar/brands wire fixtures shared by the Radar brand editor and the
 * Scrapers page's "Radar source" specs: one brand of the list, one legacy profile brand.
 */
export const GLOBEX_BRAND = { key: 'globex', label: 'Globex', domains: ['globex.example'], origin: 'list', sources: [] }
export const ACME_PROFILE_BRAND = { key: 'acme', label: 'Acme', domains: ['acme.example'], origin: 'profile', sources: ['rival_reviews'] }
export const RADAR_BRANDS = [GLOBEX_BRAND, ACME_PROFILE_BRAND]
