/**
 * @fileoverview The caller's onboarding-buddy preference and start page (`GET|PUT
 * /settings/my-onboarding`, settings Lambda, `lambda/shared/onboarding.py`).
 *
 * The server is the source of truth: it stores the state per Cognito `sub` and
 * computes `visible` on its own clock (a "Hide for now" snooze ends there). The
 * GET also carries two deployment-wide first-run `signals` the aggregates table
 * answers cheaply, so Home needs no metrics call to tick "feedback arrived".
 *
 * Every response is normalized through a lenient Zod schema: a drifted or
 * missing field reads as the first-run default (buddy shown, nothing done).
 *
 * @module api/onboardingApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { optionalText } from './schemaList'

const ONBOARDING_STATES = ['active', 'hidden', 'dismissed', 'skipped'] as const
export type OnboardingState = typeof ONBOARDING_STATES[number]

/** Where the app opens for this user (`START_PAGES` in shared/onboarding.py). */
const START_PAGES = ['home', 'dashboard'] as const
export type StartPage = typeof START_PAGES[number]

/** A PUT names only what it changes; the server leaves the other field as stored. */
export type OnboardingChanges = { state: OnboardingState } | { start_page: StartPage }

const SignalsSchema = z.object({
  feedback_present: z.boolean().catch(false),
  feedback_form_configured: z.boolean().catch(false),
}).catch({ feedback_present: false, feedback_form_configured: false })

const OnboardingSchema = z.object({
  state: z.enum(ONBOARDING_STATES).catch('active'),
  hidden_until: optionalText,
  updated_at: optionalText,
  visible: z.boolean().catch(true),
  start_page: z.enum(START_PAGES).catch('home'),
  signals: SignalsSchema,
})
export type OnboardingPreference = z.output<typeof OnboardingSchema>

/** First run (no row yet, or an unreadable answer): shown, nothing known done. */
export const DEFAULT_ONBOARDING: OnboardingPreference = OnboardingSchema.parse({})

export function normalizeOnboarding(raw: unknown): OnboardingPreference {
  const parsed = OnboardingSchema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_ONBOARDING
}

export const onboardingKey = () => ['settings', 'my-onboarding'] as const

const PATH = '/settings/my-onboarding'

export const onboardingApi = {
  get: async (): Promise<OnboardingPreference> => normalizeOnboarding(await fetchApi<unknown>(PATH)),
  save: async (changes: OnboardingChanges): Promise<OnboardingPreference> =>
    normalizeOnboarding(await fetchApi<unknown>(PATH, { method: 'PUT', body: JSON.stringify(changes) })),
}
