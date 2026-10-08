/**
 * @fileoverview The checklist derivation: each step is done iff its real
 * evidence says so, pending while that evidence loads, never counted twice.
 */
import { describe, it, expect } from 'vitest'
import {
  categoriesReady, deriveSteps, needsScraperList, ownsAProject, progressOf, sourceConnected,
} from './onboardingSteps'
import type { StepInputs } from './onboardingSteps'
import type { Category } from '../../../components/CategoriesManager/CategoriesManager'
import type { Project } from '../../../api/projectTypes'

const category = (product?: string): Category => ({ id: 'c', name: 'delivery', product, subcategories: [] })
const project = (overrides: Partial<Project>): Project => ({
  project_id: 'p', name: 'P', description: '', status: 'active', created_at: '', updated_at: '',
  persona_count: 0, document_count: 0, ...overrides,
})
const NO_SIGNALS = { feedback_present: false, feedback_form_configured: false }

const EMPTY: StepInputs = {
  isAdmin: true, userSub: 'me', categories: [], signals: NO_SIGNALS, scraperCount: 0, sessionCount: 0, projects: [],
}
const DONE: StepInputs = {
  isAdmin: true, userSub: 'me', categories: [category('App')],
  signals: { feedback_present: true, feedback_form_configured: false },
  scraperCount: undefined, sessionCount: 2, projects: [project({ owner: { sub: 'me', username: 'me', email: '' } })],
}

const statuses = (inputs: StepInputs) => Object.fromEntries(deriveSteps(inputs).map((s) => [s.id, s.status]))

describe('deriveSteps', () => {
  it('lists the first-run journey in order', () => {
    expect(deriveSteps(EMPTY).map((s) => s.id)).toStrictEqual(['categories', 'source', 'feedback', 'assistant', 'project'])
  })

  it('marks every step todo on an empty deployment', () => {
    expect(statuses(EMPTY)).toStrictEqual({ categories: 'todo', source: 'todo', feedback: 'todo', assistant: 'todo', project: 'todo' })
  })

  it('marks every step done from real evidence', () => {
    expect(statuses(DONE)).toStrictEqual({ categories: 'done', source: 'done', feedback: 'done', assistant: 'done', project: 'done' })
    expect(progressOf(deriveSteps(DONE))).toStrictEqual({ done: 5, total: 5, ready: true })
  })

  it('keeps a step pending while its evidence loads, and never counts it', () => {
    const loading: StepInputs = { ...EMPTY, categories: undefined, signals: undefined, scraperCount: undefined, sessionCount: undefined, projects: undefined }
    expect(new Set(Object.values(statuses(loading)))).toStrictEqual(new Set(['pending']))
    expect(progressOf(deriveSteps(loading))).toStrictEqual({ done: 0, total: 5, ready: false })
  })

  it('links each step to where it is done (categories: Settings for admins, the list for others)', () => {
    const links = (isAdmin: boolean) => Object.fromEntries(deriveSteps({ ...EMPTY, isAdmin }).map((s) => [s.id, s.to]))
    expect(links(true)).toStrictEqual({
      categories: '/admin?tab=categories', source: '/scrapers', feedback: '/categories', assistant: '/chat', project: '/projects',
    })
    expect(links(false).categories).toBe('/categories')
  })

  it('is ready only when every step is done', () => {
    expect(progressOf(deriveSteps({ ...DONE, sessionCount: 0 }))).toStrictEqual({ done: 4, total: 5, ready: false })
  })
})

describe('categoriesReady', () => {
  it('needs at least one category and a product on every one', () => {
    expect([categoriesReady([]), categoriesReady([category('App'), category('  ')]), categoriesReady([category('App')])])
      .toStrictEqual([false, false, true])
  })
})

describe('sourceConnected', () => {
  it('is proven by a form, by feedback, or by a configured scraper', () => {
    expect([
      sourceConnected({ signals: { ...NO_SIGNALS, feedback_form_configured: true }, scraperCount: undefined }),
      sourceConnected({ signals: { ...NO_SIGNALS, feedback_present: true }, scraperCount: undefined }),
      sourceConnected({ signals: NO_SIGNALS, scraperCount: 1 }),
      sourceConnected({ signals: NO_SIGNALS, scraperCount: 0 }),
      sourceConnected({ signals: NO_SIGNALS, scraperCount: undefined }),
    ]).toStrictEqual([true, true, true, false, undefined])
  })

  it('reads the scraper list only when the signals cannot settle it', () => {
    expect([
      needsScraperList(undefined),
      needsScraperList(NO_SIGNALS),
      needsScraperList({ ...NO_SIGNALS, feedback_present: true }),
      needsScraperList({ ...NO_SIGNALS, feedback_form_configured: true }),
    ]).toStrictEqual([false, true, false, false])
  })
})

describe('ownsAProject', () => {
  it('counts projects the caller owns, not ones shared with them', () => {
    const shared = project({ owner: { sub: 'other', username: 'o', email: '' }, access: { role: 'editor', can_view: true, can_edit: true, can_manage: false } })
    const ownedByRole = project({ access: { role: 'owner', can_view: true, can_edit: true, can_manage: true } })
    expect([ownsAProject([shared], 'me'), ownsAProject([shared, ownedByRole], 'me')]).toStrictEqual([false, true])
  })

  it('never matches an unowned project on an unknown caller', () => {
    expect(ownsAProject([project({ owner: { sub: '', username: '', email: '' } })], '')).toBe(false)
  })
})
