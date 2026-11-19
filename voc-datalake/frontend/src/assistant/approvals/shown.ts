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
 * - `scraperBase` — the fingerprint of the stored scraper the `update_scraper`
 *   diff was computed against; the executor re-reads and refuses when the
 *   scraper changed since (or the card never rendered its diff).
 * - `userBase` / `accessBase` — the same for the stored user the `update_user`
 *   diff was computed against, and for the stored grant `set_user_access`
 *   diffed against.
 * - `radarBrandsBase` — the same for the stored Radar brand list the
 *   `save_radar_brands` diff was computed against.
 * - `feedbackFormDraft` — the form the `draft_feedback_form` card shows right now, as the person edited it (its
 *   name, the questions left out, the addresses removed); the executor creates exactly that form, Off.
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
import type { FormV2 } from '../../pages/FeedbackForms/model/formsV2'

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
  /** Set by the update_scraper preview: `scraperFingerprint` of the scraper it diffed against. */
  scraperBase?: string
  /** Set by the update_user preview: `userFingerprint` of the user it diffed against. */
  userBase?: string
  /** Set by the set_user_access preview: `accessFingerprint` of the grant it diffed against. */
  accessBase?: string
  /** Set by the save_radar_brands preview: `radarListFingerprint` of the stored list it diffed against. */
  radarBrandsBase?: string
  /** Set by the draft_feedback_form preview: the form it shows, once it can be created. */
  feedbackFormDraft?: { readonly form: FormV2 }
}

/** Raised when the state an approval was shown against has changed; its message reaches the model. */
export class StaleApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleApprovalError'
  }
}

/**
 * Refuse a write whose card was never shown, or whose stored record changed since: `shownBase` is the
 * fingerprint the card rendered against, `currentFingerprint` the one of the record read just now.
 */
export function requireUnchangedSinceShown(shownBase: string | undefined, currentFingerprint: string, changedMessage: string): void {
  if (shownBase === undefined || shownBase !== currentFingerprint) throw new StaleApprovalError(changedMessage)
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

/** Record the scraper (fingerprint) the update preview just rendered its diff against. */
export function recordScraperBase(shown: ShownRecord, fingerprint: string | undefined): void {
  shown.scraperBase = fingerprint
}

/** Record the user (fingerprint) the update_user preview just rendered its diff against. */
export function recordUserBase(shown: ShownRecord, fingerprint: string | undefined): void {
  shown.userBase = fingerprint
}

/** Record the grant (fingerprint) the set_user_access preview just rendered its diff against. */
export function recordAccessBase(shown: ShownRecord, fingerprint: string | undefined): void {
  shown.accessBase = fingerprint
}

/** Record the stored Radar brand list (fingerprint) the save_radar_brands preview just diffed against. */
export function recordRadarBrandsBase(shown: ShownRecord, fingerprint: string | undefined): void {
  shown.radarBrandsBase = fingerprint
}

export const ShownContext = createContext<ShownRecord | null>(null)

/**
 * Lets a preview decline its card with a reason (the draft_feedback_form card's "Open in builder": the person edits
 * the form there instead, so the assistant is told it was not created). Outside a card there is nothing to decline.
 */
export const ApprovalDeclineContext = createContext<((reason: string) => void) | null>(null)

/**
 * Lets a preview hold Approve until the card has what it needs (the draft_feedback_form card: a name, and every
 * address the AI suggested checked or removed). A preview that never calls it holds nothing.
 */
export const ApprovalHoldContext = createContext<(held: boolean) => void>(holdNothing)

function holdNothing(): void {
  // (outside a card there is no Approve to hold)
}

/** Record the form the draft_feedback_form card shows right now (undefined: none that can be created yet). */
export function recordFeedbackFormDraft(shown: ShownRecord, form: FormV2 | undefined): void {
  shown.feedbackFormDraft = form === undefined ? undefined : { form }
}

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
