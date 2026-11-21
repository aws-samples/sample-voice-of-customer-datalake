/**
 * @fileoverview The caller's onboarding-buddy preference and start page (`GET|PUT
 * /settings/my-onboarding`, settings Lambda, `lambda/shared/onboarding.py`).
 *
 * The server is the source of truth: it stores the state per Cognito `sub` and
 * computes `visible` on its own clock (a "Hide for now" snooze ends there). The
 * GET also carries the first-run `signals` the aggregates table answers cheaply
 * (the request's workspace's), so Home needs no metrics call to tick "feedback
 * arrived", and, with a role playbook chosen (7.66.00, docs/playbooks.md), the
 * server signals of its steps (`brief_subscribed`, `objectives_set`,
 * `form_test_response`).
 *
 * Every response is normalized through a lenient Zod schema: a drifted or
 * missing field reads as the first-run default (buddy shown, nothing done).
 *
 * @module api/onboardingApi
 */
import { put } from './requestKit'
import { z } from 'zod'
import { fetchApi } from './client'
import { optionalText } from './schemaList'

const ONBOARDING_STATES = ['active', 'hidden', 'dismissed', 'skipped'] as const
export type OnboardingState = typeof ONBOARDING_STATES[number]

/** Where the app opens for this user (`START_PAGES` in shared/onboarding.py). */
const START_PAGES = ['home', 'dashboard'] as const
export type StartPage = typeof START_PAGES[number]

/** Whether Home's "How it works" starts open or collapsed (`GUIDES` in shared/onboarding.py). */
const GUIDES = ['open', 'skipped'] as const
export type GuideState = typeof GUIDES[number]

/** The role playbooks (`ROLES` in shared/playbooks.py, schemas/playbooks.json). */
export const PLAYBOOK_ROLES = ['product', 'scrum_master', 'qa', 'engineering'] as const
export type PlaybookRole = typeof PLAYBOOK_ROLES[number]

/** Whether Home shows "Subscribe to the morning brief" (`SUBSCRIBE_PROMPTS` in shared/onboarding.py). */
const SUBSCRIBE_PROMPTS = ['shown', 'dismissed'] as const
type SubscribePrompt = typeof SUBSCRIBE_PROMPTS[number]

/**
 * A PUT names only what it changes; the server leaves the other fields as stored.
 * `dismiss_decision_run` closes Home's decision card for that waiting run (it decides nothing).
 * `playbook` picks (or, null, clears) the role playbook; `playbook_done` replaces the steps ticked by hand.
 */
export type OnboardingChanges =
  | { state: OnboardingState }
  | { start_page: StartPage }
  | { guide: GuideState }
  | { subscribe_prompt: SubscribePrompt }
  | { dismiss_decision_run: string }
  | { playbook: PlaybookRole | null }
  | { playbook_done: readonly string[] }

/** A playbook signal the server sends only for the chosen playbook's steps: absent = not asked (undefined). */
const optionalSignal = z.boolean().optional().catch(undefined)

const SignalsSchema = z.object({
  feedback_present: z.boolean().catch(false),
  feedback_form_configured: z.boolean().catch(false),
  brief_subscribed: optionalSignal,
  objectives_set: optionalSignal,
  form_test_response: optionalSignal,
}).catch({ feedback_present: false, feedback_form_configured: false })

const OnboardingSchema = z.object({
  state: z.enum(ONBOARDING_STATES).catch('active'),
  hidden_until: optionalText,
  updated_at: optionalText,
  visible: z.boolean().catch(true),
  start_page: z.enum(START_PAGES).catch('home'),
  guide: z.enum(GUIDES).catch('open'),
  subscribe_prompt: z.enum(SUBSCRIBE_PROMPTS).catch('shown'),
  /** Run ids whose Home decision card the reader closed (newest first, at most 50). */
  dismissed_decision_runs: z.array(z.string()).catch([]),
  /** The role playbook the person picked (null: none yet) and the steps they ticked by hand. */
  playbook: z.enum(PLAYBOOK_ROLES).nullable().catch(null),
  playbook_done: z.array(z.string()).catch([]),
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
    normalizeOnboarding(await fetchApi<unknown>(PATH, put(changes))),
}
