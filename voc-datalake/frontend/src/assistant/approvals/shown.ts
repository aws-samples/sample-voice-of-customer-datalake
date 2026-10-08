/**
 * @fileoverview What an approval card SHOWED, so the executor writes exactly
 * that and not whatever the app state happens to be at click time.
 *
 * Each card captures a {@link ShownRecord} once, when it first renders:
 * - `job` — the time window (`days`) and response language the job previews
 *   display and the job executors send. Changing the global time range or the
 *   UI language while the card is open does not change the job it starts.
 * - `brandBase` — the current brand settings the `save_brand_settings` preview
 *   merged into; the executor re-fetches and refuses to save if they changed
 *   since (the user approved a merge against a base that no longer exists).
 *
 * The record reaches previews through {@link ShownContext} and executors
 * through the execution context (see {@link shownOf}) — the shared
 * `WriteToolExecutionContext` / preview props interfaces are left untouched.
 *
 * @module assistant/approvals/shown
 */
import { createContext } from 'react'
import i18n from 'i18next'
import { getDaysFromRange } from '../../api/baseUrl'
import { useConfigStore } from '../../store/configStore'
import type { WriteToolExecutionContext } from '../types'

export interface JobEnvironment {
  days: number
  responseLanguage: string
}

export interface BrandSettings {
  brand_name: string
  brand_handles: string[]
  hashtags: string[]
  urls_to_track: string[]
}

export interface ShownRecord {
  readonly job: JobEnvironment
  /** Set by the brand preview once it has rendered the merge. */
  brandBase: BrandSettings | undefined
}

/** Raised when the state an approval was shown against has changed; its message reaches the model. */
export class StaleApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleApprovalError'
  }
}

/** The job environment the app selects right now. */
export function currentJobEnvironment(): JobEnvironment {
  const { timeRange, customDays } = useConfigStore.getState()
  return {
    days: getDaysFromRange(timeRange, customDays),
    responseLanguage: i18n.language === '' ? 'en' : i18n.language,
  }
}

export function createShownRecord(): ShownRecord {
  return { job: currentJobEnvironment(), brandBase: undefined }
}

/** Record the base the brand preview just rendered its merge against. */
export function recordBrandBase(shown: ShownRecord, base: BrandSettings | undefined): void {
  shown.brandBase = base
}

export const ShownContext = createContext<ShownRecord | null>(null)

/** The card's shown record, when the execution came from a card. */
export function shownOf(ctx: WriteToolExecutionContext): ShownRecord | undefined {
  return ctx.shown
}

export function sameBrandSettings(a: BrandSettings, b: BrandSettings): boolean {
  const sameList = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v, i) => v === y[i])
  return a.brand_name === b.brand_name
    && sameList(a.brand_handles, b.brand_handles)
    && sameList(a.hashtags, b.hashtags)
    && sameList(a.urls_to_track, b.urls_to_track)
}
