/**
 * @fileoverview The header time-range tokens and the app's default window.
 *
 * Kept out of `configStore.ts` so components can import the default without
 * pulling in the store (many specs mock the store module wholesale).
 *
 * @module store/timeRanges
 */
import type { DateBasis } from '../api/types'

/**
 * Time-range tokens. `'90d'` is the widest fixed preset; `'all'` is ALL TIME
 * (days=0). Before persisted version 2, `'all'` was the token of the "90 Days"
 * preset (configStore keeps those users on 90 days).
 */
export const TIME_RANGES = ['24h', '48h', '7d', '14d', '30d', '90d', 'custom', 'all'] as const

/** A time-range token the config store holds. */
export type TimeRange = typeof TIME_RANGES[number]

/** The app's default window: the last 14 days by imported date (since 5.47.00). */
export const DEFAULT_TIME_RANGE: TimeRange = '14d'
export const DEFAULT_DATE_BASIS: DateBasis = 'imported'
