/**
 * @fileoverview The onboarding buddy's checklist, derived from REAL state.
 *
 * Pure: `deriveSteps` turns what Home already knows (categories config, the
 * onboarding GET's signals, the caller's assistant sessions and projects, and
 * — only when nothing else proves a source — the scraper list) into steps.
 * A step whose evidence is still loading is `pending`: it is neither counted
 * as done nor shown as missing.
 *
 * The journey mirrors a real first run: classify (categories) → connect a
 * source → feedback arrives → ask the assistant → start a research project.
 *
 * @module pages/Home/onboarding/onboardingSteps
 */
import type { Category } from '../../../components/CategoriesManager/CategoriesManager'
import type { Project } from '../../../api/projectTypes'

type StepId = 'categories' | 'source' | 'feedback' | 'assistant' | 'project'

export type StepStatus = 'done' | 'todo' | 'pending'

export interface OnboardingStep {
  id: StepId
  status: StepStatus
  /** Where the user does it. */
  to: string
}

/** Each input is `undefined` while its request is in flight (or disabled). */
export interface StepInputs {
  isAdmin: boolean
  userSub: string | undefined
  categories: readonly Category[] | undefined
  signals: { feedback_present: boolean; feedback_form_configured: boolean } | undefined
  /** Number of scrapers configured; only fetched when the signals cannot prove a source. */
  scraperCount: number | undefined
  sessionCount: number | undefined
  projects: readonly Project[] | undefined
}

const statusOf = (value: boolean | undefined): StepStatus => {
  if (value === undefined) return 'pending'
  return value ? 'done' : 'todo'
}

/** Categories exist and every one names its product (the Settings editor's rule). */
export function categoriesReady(categories: readonly Category[]): boolean {
  return categories.length > 0 && categories.every((c) => (c.product ?? '').trim() !== '')
}

/** The caller owns at least one project (a project shared with them is not "their first"). */
export function ownsAProject(projects: readonly Project[], userSub: string | undefined): boolean {
  const hasSub = userSub !== undefined && userSub !== ''
  return projects.some((p) => p.access?.role === 'owner' || (hasSub && p.owner?.sub === userSub))
}

/**
 * A source is connected when a feedback form or a scraper is configured — or
 * when feedback has arrived at all, since it can only come from a source
 * (plugins, manual import).
 */
export function sourceConnected(inputs: Pick<StepInputs, 'signals' | 'scraperCount'>): boolean | undefined {
  const { signals, scraperCount } = inputs
  if (signals?.feedback_present === true || signals?.feedback_form_configured === true) return true
  if (scraperCount !== undefined) return scraperCount > 0
  return undefined
}

/** Whether the scraper list must be read to settle the source step. */
export function needsScraperList(signals: StepInputs['signals']): boolean {
  return signals !== undefined && !signals.feedback_present && !signals.feedback_form_configured
}

export function deriveSteps(inputs: StepInputs): OnboardingStep[] {
  const { isAdmin, categories, signals, sessionCount, projects, userSub } = inputs
  return [
    {
      id: 'categories',
      status: statusOf(categories === undefined ? undefined : categoriesReady(categories)),
      // Settings is admin-only; everyone else can still browse the categories.
      to: isAdmin ? '/admin?tab=categories' : '/categories',
    },
    { id: 'source', status: statusOf(sourceConnected(inputs)), to: '/scrapers' },
    { id: 'feedback', status: statusOf(signals?.feedback_present), to: '/categories' },
    { id: 'assistant', status: statusOf(sessionCount === undefined ? undefined : sessionCount > 0), to: '/chat' },
    { id: 'project', status: statusOf(projects === undefined ? undefined : ownsAProject(projects, userSub)), to: '/projects' },
  ]
}

export interface Progress {
  done: number
  total: number
  ready: boolean
}

export function progressOf(steps: readonly OnboardingStep[]): Progress {
  const done = steps.filter((s) => s.status === 'done').length
  return { done, total: steps.length, ready: done === steps.length }
}
